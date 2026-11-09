/**
 * services/watchdog/rules.js - what counts as an alert.
 *
 * Deterministic rules decide; AI only explains (see summarize.js). Every alert has
 * a severity, a rule id, a plain-language title, and the on-chain facts behind it
 * (transaction, block, addresses), so anyone can check it independently.
 *
 *   high    power changed or something may be wrong: admin role granted/revoked,
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
        severity: role === 'ADMIN' ? 'high' : 'medium',
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
    case 'Decided':
      return [{ ...base, rule: 'market', severity: 'info', title: `Market ${a.id} closed: ${Number(a.chosen) === 0 ? 'PASS' : 'FAIL'} recommended`, facts: { market: String(a.id) } }];
    default:
      return [];
  }
}

module.exports = { rulesForEvent, ROLE_NAMES, short };
