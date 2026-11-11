/**
 * services/watchdog/rules.js - what counts as an alert.
 *
 * Deterministic rules decide; AI only explains (see summarize.js). Every alert has
 * a severity, a rule id, a plain-language title, and the on-chain facts behind it
 * (transaction, block, addresses), so anyone can check it independently.
 *
 *   high    power changed or something may be wrong: admin role granted/revoked,
 *           a council change proposed, scheduled or carried out, council membership,
 *           identity source approved/removed, enrolment spike, failed binding action,
 *           operational account running out of funds
 *   medium  notable: other role changes, revocations, binding polls opened,
 *           overdue mandates, metric resolutions
 *   info    normal activity worth a public record: polls, mandates, markets
 */

'use strict';

const { ethers } = require('ethers');

const ROLE_NAMES = Object.fromEntries(
  ['GOVERNOR_ROLE', 'VERIFIER_ROLE', 'ISSUER_ROLE', 'PROPOSER_ROLE', 'CREATOR_ROLE', 'RESOLVER_ROLE', 'VETO_ROLE'].map((r) => [ethers.id(r), r.replace('_ROLE', '')]),
);
ROLE_NAMES[ethers.ZeroHash] = 'ADMIN';

const ACTIONS = ['advisory', 'veto a market decision', 'create a mandate', 'repeal a mandate'];
const TIERS = ['basic', 'verified'];

const short = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;
const CALLS = new ethers.Interface([
  'function setIssuer(address issuer, uint8 maxTier, bool active, string name)',
  'function grantRole(bytes32 role, address account)',
  'function revokeRole(bytes32 role, address account)',
  'function addMember(address member)',
  'function removeMember(address member)',
  'function setThreshold(uint256 threshold)',
  'function setDelay(uint64 delay)',
  'function transferOwnership(address newOwner)',
  'function setMinBond(uint256 amount)',
]);
const utc = (secs) => new Date(Number(secs) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** What a council proposal will do, decoded from its exact calldata. */
function describeCall(target, data, names = {}) {
  const where = names[String(target).toLowerCase()] || short(target);
  let f;
  try {
    f = CALLS.parseTransaction({ data });
  } catch {
    return `an unrecognised call to ${where} (data ${String(data).slice(0, 10)}…)`;
  }
  const a = f.args;
  switch (f.name) {
    case 'setIssuer':
      return a.active ? `approve ${short(a.issuer)} as identity source "${a.name}" (up to ${TIERS[Number(a.maxTier)] || a.maxTier} tier)` : `remove identity source ${short(a.issuer)} ("${a.name}")`;
    case 'grantRole':
      return `grant ${ROLE_NAMES[a.role] || a.role} to ${short(a.account)} on ${where}`;
    case 'revokeRole':
      return `revoke ${ROLE_NAMES[a.role] || a.role} from ${short(a.account)} on ${where}`;
    case 'addMember':
      return `add ${short(a.member)} to the council`;
    case 'removeMember':
      return `remove ${short(a.member)} from the council`;
    case 'setThreshold':
      return `require ${a.threshold} council approvals`;
    case 'setDelay':
      return `set the council waiting period to ${Number(a.delay) / 3600} hours`;
    case 'transferOwnership':
      return `hand ${where} to ${short(a.newOwner)}`;
    case 'setMinBond':
      return `set the poll bond to ${ethers.formatEther(a.amount)} credits`;
    default:
      return `${f.name} on ${where}`;
  }
}

/**
 * Turn one decoded event into zero or more alerts.
 * @param {{ contract: string, name: string, args: any, tx: string, block: number, time: number }} ev
 * @param {object} ctx  shared state: thresholds, enrolment windows, issuer names
 */
function rulesForEvent(ev, ctx) {
  const a = ev.args;
  const base = { tx: ev.tx, block: ev.block, time: ev.time, contract: ev.contract, event: ev.name };
  switch (ev.name) {
    case 'RoleGranted':
    case 'RoleRevoked': {
      const role = ROLE_NAMES[a.role] || a.role;
      const granted = ev.name === 'RoleGranted';
      return [{
        ...base,
        rule: 'role-change',
        severity: role === 'ADMIN' || String(ev.contract).startsWith('charter') ? 'high' : 'medium', // who may set rules matters as much as admin
        title: `${role} role ${granted ? 'granted to' : 'revoked from'} ${short(a.account)} on ${ev.contract}`,
        facts: { role, account: a.account, by: a.sender },
      }];
    }
    case 'IssuerSet': {
      ctx.issuerNames.set(a.issuer.toLowerCase(), a.name);
      return [{
        ...base,
        rule: 'identity-source',
        severity: 'high',
        title: a.active
          ? `Identity source "${a.name}" (${short(a.issuer)}) approved, up to ${TIERS[Number(a.maxTier)] || a.maxTier} tier`
          : `Identity source "${a.name}" (${short(a.issuer)}) removed`,
        facts: { issuer: a.issuer, name: a.name, maxTier: Number(a.maxTier), active: a.active },
      }];
    }
    case 'Enrolled': {
      const key = a.issuer.toLowerCase();
      const win = (ctx.enrolWindows.get(key) || []).filter((t) => ev.time - t < 3600);
      win.push(ev.time);
      ctx.enrolWindows.set(key, win);
      const limit = ctx.thresholds.enrolPerHour;
      const lastFlag = ctx.spikeFlagged.get(key) || 0;
      if (win.length > limit && ev.time - lastFlag >= 3600) {
        ctx.spikeFlagged.set(key, ev.time);
        const name = ctx.issuerNames.get(key) || 'an identity source';
        return [{
          ...base,
          rule: 'enrolment-spike',
          severity: 'high',
          title: `Enrolment spike: ${win.length} people enrolled by "${name}" (${short(a.issuer)}) within an hour (limit ${limit})`,
          facts: { issuer: a.issuer, count: win.length, windowSeconds: 3600, limit },
        }];
      }
      return [];
    }
    case 'Revoked':
      return [{ ...base, rule: 'revocation', severity: 'medium', title: `A member was removed from the voter list by ${short(a.by)}`, facts: { by: a.by } }];
    case 'PollCreated': {
      const action = ACTIONS[Number(a.action)] || `action ${a.action}`;
      const binding = Number(a.action) !== 0;
      return [{
        ...base,
        rule: 'poll-opened',
        severity: binding ? 'medium' : 'info',
        title: `Poll ${a.id} opened${binding ? ` (binding: a YES will ${action})` : ''}, closes ${new Date(Number(a.end) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        facts: { poll: String(a.id), action, binding, questionCID: a.questionCID },
      }];
    }
    case 'PollFinalized':
      return [{ ...base, rule: 'poll-closed', severity: 'info', title: `Poll ${a.id} closed: ${a.passed ? 'passed' : 'did not pass'} with ${a.totalBallots} ballots`, facts: { poll: String(a.id), passed: a.passed, ballots: String(a.totalBallots) } }];
    case 'MandatePaused':
      return [{ ...base, rule: 'mandate', severity: 'medium', title: `Mandate ${a.id} paused for review by public vote: its deadline clock is stopped`, facts: { mandate: String(a.id) } }];
    case 'MandateRevised':
      return [{ ...base, rule: 'mandate', severity: 'medium', title: `Mandate ${a.id} revised by public vote: responsible ${short(a.responsible)}, due ${new Date(Number(a.deadline) * 1000).toISOString().slice(0, 10)}, ${a.threshold} check(s)`, facts: { mandate: String(a.id), responsible: a.responsible } }];
    case 'MemberElected':
      return [{ ...base, rule: 'council-membership', severity: 'high', title: `${short(a.member)} elected to the council by public vote, term ends ${new Date(Number(a.termEnd) * 1000).toISOString().slice(0, 10)}`, facts: { member: a.member } }];
    case 'MemberRecalled':
      return [{ ...base, rule: 'council-membership', severity: 'high', title: `${short(a.member)} recalled from the council by public vote`, facts: { member: a.member } }];
    case 'PowerRemovedByVote':
      return [{ ...base, rule: 'role-change', severity: 'high', title: `Public vote removed power: ${describeCall(a.target, a.data, ctx.contractNames)}`, facts: { target: a.target, data: a.data } }];
    case 'ElectorateChanged':
      return [{ ...base, rule: 'council-settings', severity: 'high', title: `The council changed which voting contract can elect and recall it, to ${short(a.electorate)}. Check this was publicly agreed.`, facts: { electorate: a.electorate } }];
    case 'EmergencyProposed':
      return [{ ...base, rule: 'emergency', severity: 'high', title: `Council change #${a.id} proposed as an EMERGENCY: it runs as soon as approved, then residents must ratify it or it is undone`, facts: { proposal: String(a.id) } }];
    case 'EmergencyRatificationOpened':
      return [{ ...base, rule: 'emergency', severity: 'high', title: `Emergency council change #${a.id} is in effect. Residents ratify it in poll ${a.pollId} by ${new Date(Number(a.ratifyBy) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC, or anyone can undo it`, facts: { proposal: String(a.id), poll: String(a.pollId) } }];
    case 'EmergencyLapsed':
      return [{ ...base, rule: 'emergency', severity: 'high', title: `Emergency council change #${a.id} was undone: residents did not ratify it`, facts: { proposal: String(a.id) } }];
    case 'OfficialRegistered':
      return [{ ...base, rule: 'officials', severity: 'medium', title: `Official registered: ${a.name}, ${a.office}${a.jurisdiction ? ` (${a.jurisdiction})` : ''}, account ${short(a.account)}`, facts: { official: String(a.id), account: a.account } }];
    case 'OfficialRemoved':
      return [{ ...base, rule: 'officials', severity: 'medium', title: `Official ${a.id} (${short(a.account)}) removed from the registry`, facts: { official: String(a.id) } }];
    case 'DelegateRegistered':
      return [{ ...base, rule: 'officials', severity: 'info', title: `New public delegate: ${a.name} (${short(a.account)})`, facts: { delegate: String(a.id) } }];
    case 'PositionRecorded':
      return a.late ? [{ ...base, rule: 'officials', severity: 'info', title: `Official ${a.officialId} recorded a position on poll ${a.pollId} after it closed (marked late)`, facts: { poll: String(a.pollId) } }] : [];
    case 'EmergencyDeclared':
      return [{ ...base, rule: 'emergency', severity: 'high', title: `Emergency measure ${a.measureId} declared by official ${a.officialId}: it lapses unless residents ratify it in poll ${a.pollId}`, facts: { measure: String(a.measureId), poll: String(a.pollId) } }];
    case 'BodyCreated':
      return [{ ...base, rule: 'bodies', severity: 'medium', title: `New decision-making body set up: ${a.name}${a.kind ? ` (${a.kind})` : ''}`, facts: { body: String(a.bodyId) } }];
    case 'RulesChanged':
      return Number(a.version) === 0 ? [] : [{ ...base, rule: 'bodies', severity: 'high', title: `Body ${a.bodyId} changed how it decides (rules version ${a.version}). Items already on its agenda keep the old rules; check the change was publicly agreed`, facts: { body: String(a.bodyId), version: Number(a.version) } }];
    case 'MemberSeated':
      return [{ ...base, rule: 'bodies', severity: 'medium', title: `${short(a.account)} seated on body ${a.bodyId} (${a.seat})`, facts: { body: String(a.bodyId), account: a.account } }];
    case 'MemberUnseated':
      return [{ ...base, rule: 'bodies', severity: 'medium', title: `${short(a.account)} removed from body ${a.bodyId}`, facts: { body: String(a.bodyId), account: a.account } }];
    case 'MotionProposed':
      return [{ ...base, rule: 'agenda', severity: 'info', title: `Body ${a.bodyId} put motion ${a.motionId} on its agenda: voting ${new Date(Number(a.opensAt) * 1000).toISOString().slice(0, 16).replace('T', ' ')} to ${new Date(Number(a.closesAt) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC${Number(a.residentPoll) ? `; residents vote first in poll ${a.residentPoll}` : ''}`, facts: { motion: String(a.motionId), body: String(a.bodyId), ref: a.ref } }];
    case 'VoteCast': {
      const how = ['', 'Yes', 'No', 'Abstain', 'recused'][Number(a.choice)];
      if (Number(a.choice) === 4) return [{ ...base, rule: 'agenda', severity: 'info', title: `${short(a.member)} recused on motion ${a.motionId}: ${a.reason}`, facts: { motion: String(a.motionId), member: a.member } }];
      if (Number(a.via) === 1) return [{ ...base, rule: 'agenda', severity: 'info', title: `Clerk recorded ${short(a.member)}'s vote on motion ${a.motionId} (${how}) taken in the room`, facts: { motion: String(a.motionId), member: a.member } }];
      if (Number(a.via) === 2) return [{ ...base, rule: 'agenda', severity: 'medium', title: `An alternate voted ${how} for ${short(a.member)} on motion ${a.motionId}`, facts: { motion: String(a.motionId), member: a.member } }];
      return [];
    }
    case 'RolesSet': {
      const names = ['chair', 'clerk', 'staff'].filter((_, i) => Number(a.roles) & (1 << i));
      return [{ ...base, rule: 'bodies', severity: 'medium', title: `${short(a.account)} ${names.length ? `given the role of ${names.join(' and ')}` : 'had every role removed'} on body ${a.bodyId}${Number(a.until) ? ` until ${new Date(Number(a.until) * 1000).toISOString().slice(0, 10)}` : ''}${Number(a.byMotion) ? ` by the body's own vote (motion ${a.byMotion})` : ' by a registrar'}`, facts: { body: String(a.bodyId), account: a.account } }];
    }
    case 'AlternateSet':
      return [{ ...base, rule: 'bodies', severity: 'medium', title: `${a.alternate === '0x0000000000000000000000000000000000000000' ? 'Alternate removed for' : `${short(a.alternate)} named alternate for`} ${short(a.member)} on body ${a.bodyId}${Number(a.byMotion) ? ` by the body's own vote (motion ${a.byMotion})` : ' by a registrar'}`, facts: { body: String(a.bodyId), member: a.member } }];
    case 'MotionWithdrawn':
      return [{ ...base, rule: 'agenda', severity: 'info', title: `Motion ${a.motionId} withdrawn from the agenda before voting by ${short(a.by)}`, facts: { motion: String(a.motionId) } }];
    case 'ClosedSessionRecorded': {
      const why = ['', 'personnel', 'legal advice', 'security', 'property negotiations', 'labor negotiations', 'other'][Number(a.reason)] || 'other';
      return [{ ...base, rule: 'closed-session', severity: 'medium', title: `Body ${a.bodyId} met in closed session (${why}${a.cite ? `, under ${a.cite}` : ''}); sealed minutes due by ${new Date(Number(a.publishBy) * 1000).toISOString().slice(0, 10)}`, facts: { session: String(a.sessionId), body: String(a.bodyId) } }];
    }
    case 'MinutesPublished':
      return [{ ...base, rule: 'closed-session', severity: 'info', title: `Minutes of closed session ${a.sessionId} published, matching their seal`, facts: { session: String(a.sessionId) } }];
    case 'MotionDecided': {
      const words = ['', '', '', 'passed: awaiting the executive', 'adopted', 'did not pass', 'vetoed', 'override vote', 'lapsed (the executive did not act)'];
      return [{ ...base, rule: 'agenda', severity: Number(a.stage) === 6 || Number(a.stage) === 8 ? 'medium' : 'info', title: `Motion ${a.motionId} ${words[Number(a.stage)] || 'decided'} (${a.yes} Yes, ${a.no} No, ${a.abstain} Abstain)`, facts: { motion: String(a.motionId), stage: Number(a.stage) } }];
    }
    case 'ExecutiveActed':
      return [{ ...base, rule: 'agenda', severity: a.signed ? 'info' : 'medium', title: `Motion ${a.motionId} ${a.signed ? 'signed' : 'VETOED'} by the executive`, facts: { motion: String(a.motionId) } }];
    case 'PetitionCreated':
      return [{ ...base, rule: 'petition', severity: 'info', title: `Petition ${a.id} started (action ${a.action}): ${a.needed} signatures open its vote`, facts: { petition: String(a.id) } }];
    case 'PetitionSucceeded':
      return [{ ...base, rule: 'petition', severity: 'medium', title: `Petition ${a.id} reached its signatures: poll ${a.pollId} opened by itself`, facts: { petition: String(a.id), poll: String(a.pollId) } }];
    case 'PetitionPollFailed':
      return [{ ...base, rule: 'petition', severity: 'high', title: `Petition ${a.id} has enough signatures but its poll could not open (check the rules); anyone can retry`, facts: { petition: String(a.id) } }];
    case 'RoundCreated':
      return [{ ...base, rule: 'budget-round', severity: 'info', title: `Budget round ${a.id} opened: ${a.proposals} proposals, budget ${Number(a.budget).toLocaleString('en-US')}, ${a.credits} credits per person, closes ${new Date(Number(a.end) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`, facts: { round: String(a.id) } }];
    case 'RoundFinalized':
      return [{ ...base, rule: 'budget-round', severity: 'medium', title: `Budget round ${a.id} counted: ${Number(a.spent).toLocaleString('en-US')} allocated, ${a.participants} people took part`, facts: { round: String(a.id), spent: String(a.spent), participants: String(a.participants), fundedMask: String(a.fundedMask) } }];
    case 'RuleChanged':
      return [{ ...base, rule: 'rule-changed', severity: 'high', title: `Voting rule ${a.name} changed by public vote from ${a.oldValue} to ${a.newValue}`, facts: { rule: a.name, from: String(a.oldValue), to: String(a.newValue) } }];
    case 'PollCrossChecked':
      return [{ ...base, rule: 'poll-cross-checked', severity: 'info', title: `Poll ${a.id} is cross-checked: ID-checked voters are counted separately (a disagreement needs ${a.checkQuorum} of their votes)`, facts: { poll: String(a.id), checkQuorum: Number(a.checkQuorum) } }];
    case 'PollDisputed':
      return [{
        ...base,
        rule: 'poll-contested',
        severity: 'high',
        title: `Poll ${a.id} is contested: everyone voted ${a.yes} Yes / ${a.no} No, but ID-checked voters voted ${a.checkYes} Yes / ${a.checkNo} No. The result was held and its binding action did not run; a re-vote among ID-checked residents is recommended.`,
        facts: { poll: String(a.id), yes: String(a.yes), no: String(a.no), checkYes: String(a.checkYes), checkNo: String(a.checkNo) },
      }];
    case 'ActionFailed':
      return [{ ...base, rule: 'action-failed', severity: 'high', title: `Poll ${a.id} passed but its binding action failed (${ACTIONS[Number(a.action)] || a.action})`, facts: { poll: String(a.id) } }];
    case 'MandateCreated':
      return [{ ...base, rule: 'mandate', severity: 'info', title: `Mandate ${a.id} created for ${short(a.responsible)}, due ${new Date(Number(a.deadline) * 1000).toISOString().slice(0, 10)}`, facts: { mandate: String(a.id), responsible: a.responsible, specCID: a.specCID } }];
    case 'MandateFulfilled':
      return [{ ...base, rule: 'mandate', severity: 'info', title: `Mandate ${a.id} verified as fulfilled`, facts: { mandate: String(a.id) } }];
    case 'MandateCancelled':
      return [{ ...base, rule: 'mandate', severity: 'medium', title: `Mandate ${a.id} repealed`, facts: { mandate: String(a.id) } }];
    case 'Vetoed':
      return [{ ...base, rule: 'market', severity: 'medium', title: `Market ${a.id}: the public vetoed the market's PASS decision`, facts: { market: String(a.id) } }];
    case 'MetricResolved':
      return [{ ...base, rule: 'market', severity: 'medium', title: `Market ${a.id}: metric resolved as ${a.met ? 'met' : 'not met'} (check the resolver's source)`, facts: { market: String(a.id), met: a.met } }];
    case 'Proposed': {
      const what = describeCall(a.target, a.data, ctx.contractNames);
      ctx.proposals.set(String(a.id), what);
      return [{
        ...base,
        rule: 'council-proposal',
        severity: 'high',
        title: `Council change #${a.id} proposed by ${short(a.proposer)}: ${what}${a.fast ? ' (removes power: can run as soon as approved)' : ''}`,
        facts: { proposal: String(a.id), proposer: a.proposer, target: a.target, value: String(a.value), data: a.data, description: a.description, fast: a.fast },
      }];
    }
    case 'Queued': {
      const what = ctx.proposals.get(String(a.id)) || 'see the proposal';
      return [{ ...base, rule: 'council-scheduled', severity: 'high', title: `Council change #${a.id} approved: it can run from ${utc(a.readyAt)} (${what}). Members can still cancel it until then.`, facts: { proposal: String(a.id), readyAt: Number(a.readyAt) } }];
    }
    case 'Executed':
      return [{ ...base, rule: 'council-executed', severity: 'high', title: `Council change #${a.id} carried out: ${ctx.proposals.get(String(a.id)) || 'see the proposal'}`, facts: { proposal: String(a.id) } }];
    case 'Cancelled':
      return [{ ...base, rule: 'council-cancelled', severity: 'medium', title: `Council change #${a.id} cancelled by ${short(a.by)}: ${ctx.proposals.get(String(a.id)) || 'see the proposal'}`, facts: { proposal: String(a.id), by: a.by } }];
    case 'MemberAdded':
    case 'MemberRemoved':
      return [{ ...base, rule: 'council-membership', severity: 'high', title: `${short(a.member)} ${ev.name === 'MemberAdded' ? 'joined' : 'left'} the council`, facts: { member: a.member } }];
    case 'ThresholdChanged':
      return [{ ...base, rule: 'council-settings', severity: 'high', title: `The council now needs ${a.threshold} approvals per change`, facts: { threshold: String(a.threshold) } }];
    case 'DelayChanged':
      return [{ ...base, rule: 'council-settings', severity: 'high', title: `The council waiting period is now ${Number(a.delay) / 3600} hours`, facts: { delay: Number(a.delay) } }];
    case 'Decided':
      return [{ ...base, rule: 'market', severity: 'info', title: `Market ${a.id} closed: ${Number(a.chosen) === 0 ? 'PASS' : 'FAIL'} recommended`, facts: { market: String(a.id) } }];
    default:
      return [];
  }
}

module.exports = { rulesForEvent, ROLE_NAMES, short, describeCall };
