/**
 * app/src/bodies.js - government bodies and organizations deciding in public:
 *   Bodies screen  each body's own rules in plain words, its members by seat, the agenda
 *                  with countdowns, residents' result beside the roll call, and the
 *                  buttons for whoever may act (members vote, the clerk records votes
 *                  taken in the room, the executive signs or vetoes, anyone counts)
 *   Admin          registrars set up a body from a template (city council, school board,
 *                  co-op...) and change any rule, seat members (with terms), give roles
 *                  (chair, clerk, staff) and name alternates
 *   Permissions    the chair runs the agenda; clerks record votes; staff draft; members can
 *                  recuse; alternates vote for absent members; self-governed bodies vote on
 *                  their own roles; closed sessions are recorded with sealed minutes
 *   Dashboard      every body's recent decisions and how often each member sided with
 *                  residents
 */

import { ethers } from 'ethers';
import { countdown } from './time.js';
import { copyBtn, jumpTo, itemTools } from './copy.js';
import { readDoc, postDoc } from './notices.js';
import { categoryChip, categoryFromHash, categoryOptions } from './priority.js';
import { ORG_TEMPLATES, RULE_WORDS } from './org-templates.js';
import { attachPicker, attachmentsHtml, wireAttachments, uploadService } from './attach.js';

const RULES = 'tuple(string name, string kind, uint32 seats, uint16 quorumPct, uint16 passPct, bool passOfSeats, uint16 overridePct, uint32 noticeMinutes, uint32 voteMinutes, uint32 executiveMinutes, address executive, bool silenceApproves, uint8 residentTier, bool explainDissent, bool reasonsRequired, address clerk, bool active, bool allowAlternates, bool selfGoverned)';
const MOTION = 'tuple(uint256 bodyId, string ref, bytes32 category, address proposer, uint64 noticeAt, uint64 opensAt, uint64 closesAt, uint256 residentPoll, uint8 stage, uint64 executiveBy, uint64 overrideBy, uint32 version, uint32 electorate, bool overridden, string executiveRef)';
export const BODIES_ABI = [
  'function bodyCount() view returns (uint256)',
  `function getBody(uint256) view returns (${RULES} r, uint32 version, address[] members)`,
  `function rulesAt(uint256, uint32) view returns (${RULES})`,
  'function seatOf(uint256, address) view returns (string)',
  'function isMember(uint256, address) view returns (bool)',
  'function motionCount() view returns (uint256)',
  `function getMotion(uint256) view returns (${MOTION} m, uint32[5] counts)`,
  'function rollCall(uint256) view returns (address[] who, uint8[] choice, string[] reason, uint8[] via, uint8[] overrideChoice)',
  'function holds(uint256, address, uint8) view returns (bool)',
  'function grantOf(uint256, address) view returns (uint8 roles, uint64 until)',
  'function seatUntil(uint256, address) view returns (uint64)',
  'function alternateOf(uint256, address) view returns (address)',
  'function recusals(uint256) view returns (uint32)',
  'function actionOf(uint256) view returns (tuple(uint8 kind, address account, address alternate, uint8 roles, uint64 until))',
  'function setRoles(uint256, address, uint8, uint64)',
  'function setAlternate(uint256, address, address)',
  'function proposeAction(uint256, string, bytes32, tuple(uint8 kind, address account, address alternate, uint8 roles, uint64 until)) returns (uint256)',
  'function withdraw(uint256)',
  'function recuse(uint256, string)',
  'function castVoteFor(uint256, address, uint8, string)',
  'function residentResult(uint256) view returns (uint8)',
  'function hasRole(bytes32, address) view returns (bool)',
  `function createBody(${RULES}) returns (uint256)`,
  `function setRules(uint256, ${RULES})`,
  'function seat(uint256, address, string, uint64)',
  'function unseat(uint256, address)',
  'function propose(uint256, string, bytes32) returns (uint256)',
  'function castVote(uint256, uint8, string)',
  'function recordVote(uint256, address, uint8, string)',
  'function count(uint256)',
  'function act(uint256, bool, string)',
  'function castOverride(uint256, bool, string)',
  'function recordOverride(uint256, address, bool, string)',
  'function settle(uint256)',
  'error BadRules()', 'error UnknownBody()', 'error UnknownMotion()', 'error NotAMember()', 'error NotAllowed()', 'error SeatsFull()',
  'error AlreadyMember()', 'error WrongStage()', 'error NotOpen()', 'error AlreadyVoted()', 'error ReasonRequired()', 'error BadRef()', 'error TooEarly()',
];
const ERRORS = {
  BadRules: 'Those rules are outside the allowed limits (for example, passing needs at least a majority, and the dissent rule needs a residents\' vote with a notice period).',
  NotAMember: 'This account does not hold a seat on this body.',
  NotAllowed: 'This account is not allowed to do that here.',
  SeatsFull: 'Every seat is filled. Raise the number of seats first.',
  AlreadyMember: 'That account already holds a seat.',
  WrongStage: 'That step is not open for this motion now.',
  NotOpen: 'Voting is not open for this motion now.',
  AlreadyVoted: 'This member has already voted on it.',
  ReasonRequired: 'A public reason is required for this vote (it goes against the residents\' result, or the body requires reasons).',
  TooEarly: 'Not yet: voting is still open, or members are still voting.',
  BadRef: 'That text is too long (128 characters at most).',
  BadInput: 'Check the details: a reason is needed, the publication date must be in the future (within 10 years), and "Other" needs the rule cited.',
  WrongMinutes: 'That text does not match the sealed minutes. Publish exactly the minutes that were sealed.',
  AlreadyPublished: 'These minutes are already published.',
};
const BODY_ERRORS = new ethers.Interface(BODIES_ABI.filter((x) => x.startsWith('error')));

export const STAGES = ['', 'On the agenda', 'Voting', 'Awaiting the executive', 'Adopted', 'Did not pass', 'Vetoed', 'Override vote', 'Lapsed', 'Withdrawn'];
const CHOICE = ['', 'Yes', 'No', 'Abstain', 'Recused'];
export const ROLE = { CHAIR: 1, CLERK: 2, STAFF: 4 };
const roleWords = (bits) => ['chair', 'clerk', 'staff'].filter((_, i) => Number(bits) & (1 << i));
export const RECORDS_ABI = [
  'function draftCount() view returns (uint256)',
  'function getDraft(uint256) view returns (tuple(uint256 bodyId, string ref, address by, uint64 at))',
  'function submitDraft(uint256, string) returns (uint256)',
  'function sessionCount() view returns (uint256)',
  'function getSession(uint256) view returns (tuple(uint256 bodyId, uint8 reason, string cite, bytes32 minutesHash, uint64 heldAt, uint64 publishBy, uint64 publishedAt, address by) s, bool overdue)',
  'function recordClosedSession(uint256, uint8, string, bytes32, uint64) returns (uint256)',
  'function publishMinutes(uint256, bytes32)',
  'error NotAllowed()', 'error BadInput()', 'error Unknown()', 'error AlreadyPublished()', 'error WrongMinutes()',
];
const RECORD_ERRORS = new ethers.Interface(RECORDS_ABI.filter((x) => x.startsWith('error')));
export const CLOSED_REASONS = ['', 'Personnel', 'Legal advice', 'Security', 'Property negotiations', 'Labor negotiations', 'Other (cite the rule)'];
/** The minutes document whose fingerprint is sealed, and later published unchanged. */
export const minutesDoc = (bodyName, text) => ({ title: `Minutes of a closed session: ${bodyName}`, body: text });
export const sealOf = (doc) => ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(doc)));
const TIERS = ['all members', 'ID-checked residents', 'residents with full voting rights'];

/** Starting points: every value can be changed before (and after) the body is set up. */
export const TEMPLATES = {
  city: { label: 'City or town council', kind: 'city council', seats: 7, quorumPct: 51, passPct: 50, passOfSeats: false, overridePct: 67, noticeMinutes: 72 * 60, voteMinutes: 7 * 24 * 60, executiveMinutes: 10 * 24 * 60, silenceApproves: true, residentTier: 2, explainDissent: true, reasonsRequired: false, allowAlternates: false, selfGoverned: true },
  county: { label: 'County board', kind: 'county board', seats: 5, quorumPct: 60, passPct: 50, passOfSeats: false, overridePct: 0, noticeMinutes: 72 * 60, voteMinutes: 7 * 24 * 60, executiveMinutes: 0, silenceApproves: true, residentTier: 2, explainDissent: true, reasonsRequired: false, allowAlternates: false, selfGoverned: true },
  legislature: { label: 'State legislature (one chamber)', kind: 'legislative chamber', seats: 100, quorumPct: 51, passPct: 50, passOfSeats: true, overridePct: 67, noticeMinutes: 5 * 24 * 60, voteMinutes: 3 * 24 * 60, executiveMinutes: 10 * 24 * 60, silenceApproves: true, residentTier: 2, explainDissent: true, reasonsRequired: false, allowAlternates: false, selfGoverned: true },
  school: { label: 'School board', kind: 'school board', seats: 7, quorumPct: 51, passPct: 50, passOfSeats: false, overridePct: 0, noticeMinutes: 72 * 60, voteMinutes: 3 * 24 * 60, executiveMinutes: 0, silenceApproves: true, residentTier: 2, explainDissent: false, reasonsRequired: false, allowAlternates: false, selfGoverned: true },
  committee: { label: 'Committee or commission', kind: 'committee', seats: 5, quorumPct: 51, passPct: 50, passOfSeats: false, overridePct: 0, noticeMinutes: 48 * 60, voteMinutes: 3 * 24 * 60, executiveMinutes: 0, silenceApproves: true, residentTier: 255, explainDissent: false, reasonsRequired: false, allowAlternates: false, selfGoverned: true },
  nonprofit: { label: 'Nonprofit or company board', kind: 'board of directors', seats: 9, quorumPct: 51, passPct: 50, passOfSeats: false, overridePct: 0, noticeMinutes: 7 * 24 * 60, voteMinutes: 3 * 24 * 60, executiveMinutes: 0, silenceApproves: true, residentTier: 255, explainDissent: false, reasonsRequired: true, allowAlternates: false, selfGoverned: true },
  coop: { label: 'Co-op, union or association board', kind: 'member board', seats: 7, quorumPct: 51, passPct: 50, passOfSeats: false, overridePct: 0, noticeMinutes: 7 * 24 * 60, voteMinutes: 7 * 24 * 60, executiveMinutes: 0, silenceApproves: true, residentTier: 0, explainDissent: true, reasonsRequired: false, allowAlternates: false, selfGoverned: true },
  hoa: { label: 'Neighborhood or HOA board', kind: 'neighborhood board', seats: 5, quorumPct: 60, passPct: 50, passOfSeats: false, overridePct: 0, noticeMinutes: 4 * 24 * 60, voteMinutes: 7 * 24 * 60, executiveMinutes: 0, silenceApproves: true, residentTier: 1, explainDissent: true, reasonsRequired: false, allowAlternates: false, selfGoverned: true },
  custom: { label: 'Custom: start from scratch', kind: '', seats: 5, quorumPct: 51, passPct: 50, passOfSeats: false, overridePct: 0, noticeMinutes: 24 * 60, voteMinutes: 3 * 24 * 60, executiveMinutes: 0, silenceApproves: true, residentTier: 255, explainDissent: false, reasonsRequired: false, allowAlternates: false, selfGoverned: true },
};

const dur = (minutes) => {
  const m = Number(minutes);
  if (!m) return 'none';
  if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'}`;
  return `${m} minutes`;
};
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const passWords = (r) => {
  const pct = Number(r.passPct);
  const share = pct === 50 ? 'a majority' : pct === 67 || pct === 66 ? 'two-thirds' : pct === 75 ? 'three-quarters' : pct === 100 ? 'everyone' : `${pct}%`;
  return `${share} of ${r.passOfSeats ? 'all members' : 'the votes cast'}`;
};

/** The body's rules in plain words. */
export function rulesSummary(r, esc, names = {}) {
  const exec = r.executive !== ethers.ZeroAddress;
  return `<ul class="rules-summary">
    <li>${Number(r.seats)} seats · ${Number(r.quorumPct)}% must take part · passes with ${passWords(r)}</li>
    <li>Published ${dur(r.noticeMinutes)} before voting opens · voting stays open ${dur(r.voteMinutes)}</li>
    <li>${Number(r.residentTier) === 255 ? 'No residents\' vote first' : `Residents (${TIERS[Number(r.residentTier)]}) vote anonymously on each item during the notice period`}${r.explainDissent ? ' · members who vote against a clear residents\' result must say why' : ''}${r.reasonsRequired ? ' · every vote needs a public reason' : ''}</li>
    <li>${exec ? `Then the executive (${esc(names[r.executive.toLowerCase()] || short(r.executive))}) has ${dur(r.executiveMinutes)} to sign or veto; if they do nothing it is ${r.silenceApproves ? 'adopted' : 'dropped'}${Number(r.overridePct) ? ` · a veto can be overridden by ${Number(r.overridePct)}% of all members` : ' · vetoes are final'}` : 'No executive signature needed: passed means adopted'}</li>
    ${r.clerk !== ethers.ZeroAddress ? `<li>Clerk: ${esc(names[r.clerk.toLowerCase()] || short(r.clerk))} (publishes the agenda, records votes taken in the room)</li>` : ''}
    <li>${r.selfGoverned ? 'The body votes on its own roles (chair, clerks, staff) and alternates' : 'Roles are given by the registrar'}${r.allowAlternates ? ' · a member\'s named alternate may vote in their place' : ''} · members may recuse, on the record</li>
  </ul>`;
}

async function nameBook(cfg, provider) {
  const names = {};
  if (!cfg.officialsAddress) return names;
  const o = new ethers.Contract(cfg.officialsAddress, ['function count() view returns (uint256)', 'function getOfficial(uint256) view returns (tuple(address account, string name, string office, string jurisdiction, uint64 termEnd, bool official, bool delegate, bool active, string statementRef))'], provider);
  const n = Math.min(Number(await o.count().catch(() => 0n)), 200);
  for (let i = 1; i <= n; i++) {
    const x = await o.getOfficial(i).catch(() => null);
    if (x && x.active) names[x.account.toLowerCase()] = x.office ? `${x.name}, ${x.office}` : x.name;
  }
  return names;
}

/** Residents' anonymous result on the motion's poll: { yes, no, result: 0 none / 1 Yes / 2 No, closed }. */
async function residents(cfg, provider, g, id, m) {
  if (!m.residentPoll || !cfg.voteAddress) return null;
  const v = new ethers.Contract(cfg.voteAddress, ['function tally(uint256) view returns (uint256[])', 'function getPoll(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 quorum, uint8 options, uint8 action, bool finalized, bool passed, address proposer, uint256 bond, string questionCID, bytes actionData))'], provider);
  const [t, p, result] = await Promise.all([v.tally(m.residentPoll), v.getPoll(m.residentPoll), g.residentResult(id)]);
  return { yes: Number(t[0] || 0n), no: Number(t[1] || 0n), result: Number(result), closed: p.finalized || Number(p.end) <= Date.now() / 1000, end: p.end };
}

/** One motion as HTML (shared by the app and the dashboard). */
async function motionHtml(cfg, provider, g, id, esc, names, now) {
  const [m, counts] = await g.getMotion(id);
  const st = Number(m.stage);
  const doc = await readDoc(cfg, provider, m.ref);
  const r = await g.rulesAt(m.bodyId, m.version);
  const res = await residents(cfg, provider, g, id, m).catch(() => null);
  const [who, choice, reason, via, overrideChoice] = await g.rollCall(id);
  const recused = Number(await g.recusals(id).catch(() => 0n));
  const action = await g.actionOf(id).catch(() => null);
  const total = Number(counts[0]) + Number(counts[1]) + Number(counts[2]);
  const clock =
    st === 1 ? `voting opens ${countdown(m.opensAt, '', 'bodies')}`
    : st === 2 ? (Number(m.closesAt) > now ? `voting closes ${countdown(m.closesAt, '', 'bodies')}` : 'voting closed · waiting to be counted')
    : st === 3 ? (Number(m.executiveBy) > now ? `executive must act ${countdown(m.executiveBy, '', 'bodies')}` : 'executive deadline passed · waiting to be closed')
    : st === 7 ? (Number(m.overrideBy) > now ? `override vote closes ${countdown(m.overrideBy, '', 'bodies')}` : 'override vote closed · waiting to be closed')
    : `put on the agenda ${countdown(m.noticeAt)}`;
  const resLine = res
    ? `<p><strong>Residents:</strong> ${res.yes} Yes · ${res.no} No${res.closed ? (res.result === 1 ? ' · <strong>residents said Yes</strong>' : res.result === 2 ? ' · <strong>residents said No</strong>' : ' · no clear result') : ` · residents' vote closes ${countdown(res.end)}`}</p>`
    : '';
  const rows = who.map((a, i) => {
    const c = Number(choice[i]);
    const against = res && res.result && c && c < 3 && c !== res.result;
    return `<tr${against ? ' class="against"' : ''}><td>${esc(names[a.toLowerCase()] || short(a))}</td><td><strong>${CHOICE[c] || '-'}</strong>${Number(overrideChoice[i]) ? ` · override: ${Number(overrideChoice[i]) === 1 ? 'Yes' : 'No'}` : ''}${Number(via[i]) === 1 ? ' <span class="muted">(recorded by clerk)</span>' : Number(via[i]) === 2 ? ' <span class="muted">(by their alternate)</span>' : ''}${against ? ' <span class="warn">▲ against residents</span>' : ''}</td><td>${esc(reason[i] || '')}</td></tr>`;
  });
  return {
    m, st, r, counts, who, choice, overrideChoice, doc,
    html: `<p class="eyebrow">Motion ${id} · <strong>${STAGES[st]}</strong> · ${clock}</p>
      <h3>${esc(doc.title)} ${categoryChip(categoryFromHash(m.category), esc)}</h3>${doc.body ? `<p>${esc(doc.body)}</p>` : ''}${attachmentsHtml(cfg, doc, esc)}
      ${itemTools({ anchor: `motion-${id}`, idText: `Motion ${id} (government bodies ${cfg.bodiesAddress})`, ref: m.ref, explorer: cfg.explorer, address: cfg.bodiesAddress })}
      ${doc.from && Number(doc.from.motion) ? `<p class="note">Comes from ${esc(String(doc.from.body || 'another body'))}, which adopted it ${Number(doc.from.yes)}–${Number(doc.from.no)} (motion ${Number(doc.from.motion)}).</p>` : ''}
      ${resLine}
      ${action && Number(action.kind) ? `<p class="note"><strong>Changes the body itself:</strong> ${Number(action.kind) === 1 ? `${esc(names[action.account.toLowerCase()] || short(action.account))} ${roleWords(action.roles).length ? `becomes ${roleWords(action.roles).join(' and ')}` : 'loses every role'}${Number(action.until) ? ` until ${new Date(Number(action.until) * 1000).toLocaleDateString()}` : ''}` : `${action.alternate === ethers.ZeroAddress ? 'no alternate' : esc(names[action.alternate.toLowerCase()] || short(action.alternate))} for ${esc(names[action.account.toLowerCase()] || short(action.account))}`}. No executive signature needed.</p>` : ''}
      <p><strong>Members:</strong> ${counts[0]} Yes · ${counts[1]} No · ${counts[2]} Abstain${recused ? ` · ${recused} recused` : ''} · ${total} of ${Number(m.electorate) - recused} voted${st === 7 || Number(counts[3]) + Number(counts[4]) ? ` · override ${counts[3]} Yes · ${counts[4]} No` : ''}${m.overridden ? ' · <strong>veto overridden</strong>' : ''}</p>
      ${m.executiveRef ? `<p class="muted">Executive's message: ${esc((await readDoc(cfg, provider, m.executiveRef)).body || m.executiveRef)}</p>` : ''}
      ${rows.length ? `<details${st === 2 || st === 7 ? ' open' : ''}><summary>Roll call (${rows.length})</summary><table class="data"><thead><tr><th>Member</th><th>Vote</th><th>Reason</th></tr></thead><tbody>${rows.join('')}</tbody></table></details>` : ''}`,
  };
}

export function wireBodies(ctx) {
  const { state, $, status, esc } = ctx;
  const bodyFilter = {}; // the view each body was left on: open, decided or all
  const reg = () => (state.config.bodiesAddress ? new ethers.Contract(state.config.bodiesAddress, BODIES_ABI, state.provider) : null);
  const me = () => {
    try {
      return ctx.activeAddress() || '';
    } catch {
      return '';
    }
  };

  async function send(el, label, fn) {
    status(el, `${label}: confirm…`);
    try {
      const tx = await fn(reg().connect(ctx.activeSigner()));
      status(el, `${label}: waiting for the network…`);
      await tx.wait();
      status(el, `${label}: done.`, 'ok');
      return true;
    } catch (e) {
      let name = e.revert?.name;
      try {
        name ||= BODY_ERRORS.parseError(e.data)?.name;
      } catch {
        /* not ours */
      }
      status(el, `${label} failed: ${ERRORS[name] || name || e.shortMessage || e.message}`, 'error');
      return false;
    }
  }

  /** The Bodies screen. */
  async function render() {
    const box = $('bodies-list');
    const g = reg();
    if (!g) return (box.innerHTML = '<p class="muted">Government bodies are not set up on this deployment yet.</p>');
    box.innerHTML = '<p class="muted">Loading…</p>';
    const [n, mc, block, names] = await Promise.all([g.bodyCount(), g.motionCount(), state.provider.getBlock('latest'), nameBook(state.config, state.provider), uploadService(state.config)]);
    const now = Number(block.timestamp);
    const account = me().toLowerCase();
    if (!Number(n)) return (box.innerHTML = '<p class="muted">No bodies yet. A registrar sets them up under Admin.</p>');
    const motionsOf = {};
    for (let id = Number(mc); id >= Math.max(1, Number(mc) - 49); id--) {
      const [m] = await g.getMotion(id);
      (motionsOf[m.bodyId] ||= []).push(id);
    }
    const cards = [];
    const all = [];
    for (let b = 1; b <= Number(n); b++) all.push({ id: b, body: await g.getBody(b) });
    const rolesOf = {};
    for (const { id } of all) rolesOf[id] = account ? (await g.grantOf(id, account).catch(() => [0n, 0n])) : [0n, 0n];
    const holds = (b, bits) => {
      const [roles, until] = rolesOf[b];
      if ((Number(roles) & bits) && (!Number(until) || Number(until) > now)) return true;
      return !!(bits & ROLE.CLERK) && !!account && all[b - 1].body[0].clerk.toLowerCase() === account;
    };
    const others = all.filter(({ id, body: [r, , mem] }) => r.active && (mem.some((a) => a.toLowerCase() === account) || holds(id, ROLE.CHAIR | ROLE.CLERK))).map(({ id, body: [r] }) => ({ id, name: r.name }));
    const rec = state.config.bodyRecordsAddress ? new ethers.Contract(state.config.bodyRecordsAddress, RECORDS_ABI, state.provider) : null;
    const drafts = [];
    const sessions = [];
    if (rec) {
      const [dn, sn] = await Promise.all([rec.draftCount(), rec.sessionCount()]);
      for (let d = Number(dn); d >= Math.max(1, Number(dn) - 49); d--) drafts.push({ id: d, ...(await rec.getDraft(d)).toObject() });
      for (let k = Number(sn); k >= Math.max(1, Number(sn) - 49); k--) {
        const [x, overdue] = await rec.getSession(k);
        sessions.push({ id: k, ...x.toObject(), overdue });
      }
    }
    for (let b = 1; b <= Number(n); b++) {
      const [r, , members] = all[b - 1].body;
      const seats = await Promise.all(members.map((a) => g.seatOf(b, a)));
      const mine = members.some((a) => a.toLowerCase() === account);
      const chair = holds(b, ROLE.CHAIR);
      const clerk = holds(b, ROLE.CLERK);
      const staff = holds(b, ROLE.STAFF);
      const terms = await Promise.all(members.map((a) => g.seatUntil(b, a).catch(() => 0n)));
      const alternates = await Promise.all(members.map((a) => g.alternateOf(b, a).catch(() => ethers.ZeroAddress)));
      const forMe = r.allowAlternates ? members.filter((a, i) => alternates[i].toLowerCase() === account) : [];
      const items = [];
      for (const id of motionsOf[b] || []) {
        const x = await motionHtml(state.config, state.provider, g, id, esc, names, now);
        items.push(`<article class="card stack motion" id="motion-${id}" data-group="${[1, 2, 3, 7].includes(x.st) ? 'open' : 'decided'}">${x.html}${actions(id, x, now, account, members, seats, others, { chair, clerk, forMe })}<p class="status" role="status"></p></article>`);
      }
      const myRoles = [mine && 'member', ...roleWords((chair ? 1 : 0) | (clerk ? 2 : 0) | (staff ? 4 : 0))].filter(Boolean);
      const bodyDrafts = drafts.filter((d) => Number(d.bodyId) === b);
      const bodySessions = sessions.filter((x) => Number(x.bodyId) === b);
      const draftDocs = await Promise.all(bodyDrafts.map((d) => readDoc(state.config, state.provider, d.ref)));
      cards.push(`<section class="card stack" id="body-${b}">
        <p class="eyebrow">${esc(r.kind || 'Body')}${r.active ? '' : ' · inactive'}</p><h2>${esc(r.name)}</h2>
        <details><summary>How this body decides</summary>${rulesSummary(r, esc, names)}</details>
        ${myRoles.length ? `<p class="note">Your roles here: <strong>${myRoles.join(', ')}</strong></p>` : ''}
        <details><summary>Members (${members.length} of ${r.seats} seats)</summary><ul class="list">${members.map((a, i) => `<li>${esc(seats[i])}: <strong>${esc(names[a.toLowerCase()] || short(a))}</strong> ${copyBtn(a)}${Number(terms[i]) ? ` · term ends ${new Date(Number(terms[i]) * 1000).toLocaleDateString()}${Number(terms[i]) <= now ? ' (ended)' : ''}` : ''}${alternates[i] !== ethers.ZeroAddress ? ` · alternate: ${esc(names[alternates[i].toLowerCase()] || short(alternates[i]))}` : ''}</li>`).join('') || '<li class="muted">No members seated yet.</li>'}</ul></details>
        ${(mine || chair || clerk) && r.active ? `<details class="propose"><summary><strong>Put an item on the agenda</strong></summary><div class="stack">
          <label>Title <input type="text" data-f="title" /></label><label>Full text<textarea data-f="body" rows="4"></textarea></label>
          <label>Topic <select data-f="cat">${categoryOptions()}</select></label>
          <details class="attach-wrap"><summary>📎 Attach the bill text, a map, photos…</summary><div data-attach></div></details>
          ${r.selfGoverned ? `<label>This item changes the body itself <select data-f="action"><option value="0">No: an ordinary item</option><option value="1">Give or remove someone's roles</option><option value="2">Name a member's alternate</option></select></label>
          <div class="stack" data-show="1" hidden><label>Their account (0x…) <input type="text" data-f="roleAccount" autocomplete="off" spellcheck="false" /></label>
            <div class="row"><label><input type="checkbox" data-f="roleChair" /> Chair</label><label><input type="checkbox" data-f="roleClerk" /> Clerk</label><label><input type="checkbox" data-f="roleStaff" /> Staff</label></div>
            <label>Until (optional) <input type="date" data-f="roleUntil" /></label><p class="note">Leave all unchecked to remove every role.</p></div>
          <div class="stack" data-show="2" hidden><label>Member <select data-f="altMember">${members.map((a, i) => `<option value="${a}">${esc(seats[i])}</option>`).join('')}</select></label>
            <label>Their alternate's account (0x…, empty to remove) <input type="text" data-f="altAccount" autocomplete="off" spellcheck="false" /></label></div>` : ''}
          <p class="note">It is published at once; voting opens after the ${dur(r.noticeMinutes)} notice period${Number(r.residentTier) === 255 ? '' : ', while residents vote on it'}.</p>
          <button class="primary" data-propose="${b}">Publish to the agenda</button><p class="status" role="status"></p></div></details>` : ''}
        ${rec ? `<details class="propose"><summary>Drafts (${bodyDrafts.length})</summary><div class="stack">
          ${bodyDrafts.map((d, i) => `<div class="card stack"><p class="eyebrow">Draft ${d.id} · by ${esc(names[d.by.toLowerCase()] || short(d.by))} · ${countdown(d.at)}</p><p><strong>${esc(draftDocs[i].title)}</strong></p>${draftDocs[i].body ? `<p>${esc(draftDocs[i].body)}</p>` : ''}${attachmentsHtml(state.config, draftDocs[i], esc)}${(mine || chair || clerk) && r.active ? `<button data-sponsor="${b}:${d.id}">Sponsor: put it on the agenda</button>` : ''}<p class="status" role="status"></p></div>`).join('') || '<p class="muted">No drafts.</p>'}
          ${mine || chair || clerk || staff ? `<label>New draft: title <input type="text" data-f="draftTitle" /></label><label>Text<textarea data-f="draftBody" rows="3"></textarea></label><details class="attach-wrap"><summary>📎 Attach files</summary><div data-attach></div></details><button data-draft="${b}">Submit draft</button>` : ''}
          <p class="status" role="status"></p></div></details>
        <details class="propose"><summary>Closed sessions (${bodySessions.length})${bodySessions.some((x) => x.overdue) ? ' <span class="warn">▲ minutes overdue</span>' : ''}</summary><div class="stack">
          <p class="note">Where the law allows a meeting without the public, it is still on the record: why it was closed, and a sealed fingerprint of its minutes, which must be published unchanged by the date shown.</p>
          ${bodySessions.map((x) => `<div class="card stack"><p class="eyebrow">Closed session ${x.id} · ${countdown(x.heldAt)} · ${esc(CLOSED_REASONS[Number(x.reason)] || 'Other')}${x.cite ? ` (${esc(x.cite)})` : ''}</p>
            <p>${Number(x.publishedAt) ? `Minutes published, matching their seal: <a href="#" data-minutes="${x.minutesHash}">read them</a>` : x.overdue ? `<strong class="warn">▲ Minutes overdue</strong> since ${countdown(x.publishBy)}` : `Minutes due ${countdown(x.publishBy)}`}</p>
            ${!Number(x.publishedAt) && (chair || clerk) ? `<label>The sealed minutes, exactly <textarea data-f="pubText" rows="3"></textarea></label><button data-publish="${x.id}:${b}">Publish the minutes</button>` : ''}
            <div class="minutes-text"></div><p class="status" role="status"></p></div>`).join('') || '<p class="muted">None recorded.</p>'}
          ${chair || clerk ? `<h4>Record a closed session</h4><label>Why it was closed <select data-f="csReason">${CLOSED_REASONS.slice(1).map((w, i) => `<option value="${i + 1}">${w}</option>`).join('')}</select></label>
            <label>The law or rule that allows it <input type="text" data-f="csCite" maxlength="120" placeholder="e.g. Open Meetings Act, personnel exception" /></label>
            <label>Minutes (kept private until published; only their fingerprint goes on the record now) <textarea data-f="csMinutes" rows="4"></textarea></label>
            <label>Publish them by <input type="date" data-f="csBy" /></label>
            <button data-closed="${b}">Record and seal</button>` : ''}
          <p class="status" role="status"></p></div></details>` : ''}
        <h3>Agenda and decisions</h3>
        ${items.length ? `<div class="filters" role="group" aria-label="Show items" data-body-filter><button type="button" data-show="open" aria-pressed="true">Open (${items.filter((h) => h.includes('data-group="open"')).length})</button><button type="button" data-show="decided" aria-pressed="false">Decided (${items.filter((h) => h.includes('data-group="decided"')).length})</button><button type="button" data-show="all" aria-pressed="false">All</button></div>` : ''}
        ${items.join('') || '<p class="muted">Nothing on the agenda.</p>'}
        <p class="muted empty-note" hidden>Nothing open. Choose "Decided" or "All" to see earlier items.</p>
      </section>`);
    }
    const menu = all.length > 1 ? `<nav class="filters section-menu" aria-label="Jump to a body">${all.map(({ id, body: [r] }) => `<a class="button" href="#body-${id}" data-jump="body-${id}">${esc(r.name)}</a>`).join('')}</nav>` : '';
    box.innerHTML = menu + cards.join('');
    for (const a of box.querySelectorAll('[data-jump]')) a.onclick = (e) => (e.preventDefault(), jumpTo($(a.dataset.jump)));
    for (const bar of box.querySelectorAll('[data-body-filter]')) {
      const section = bar.closest('section');
      const apply = (k) => {
        bodyFilter[section.id] = k;
        for (const b of bar.querySelectorAll('[data-show]')) b.setAttribute('aria-pressed', String(b.dataset.show === k));
        const arts = [...section.querySelectorAll('article.motion')];
        for (const a of arts) a.hidden = k !== 'all' && a.dataset.group !== k;
        section.querySelector('.empty-note').hidden = arts.some((a) => !a.hidden);
      };
      for (const b of bar.querySelectorAll('[data-show]')) b.onclick = () => apply(b.dataset.show);
      apply(bodyFilter[section.id] || 'open');
    }
    for (const el of box.querySelectorAll('[data-attach]')) el._picker = attachPicker(el, { state, esc });
    wireAttachments(box, state.config);
    wire(box);
  }

  /** Buttons for whoever may act on this motion now. */
  function actions(id, x, now, account, members, seats, others = [], my = {}) {
    if (!account) return '';
    const { m, st, r, who, choice, overrideChoice } = x;
    const voted = new Map(who.map((a, i) => [a.toLowerCase(), [Number(choice[i]), Number(overrideChoice[i])]]));
    const isMember = members.some((a) => a.toLowerCase() === account);
    const isClerk = !!my.clerk;
    const out = [];
    const reasonBox = '<input type="text" data-f="reason" maxlength="128" placeholder="Reason (public)" />';
    if (st === 1 && (m.proposer.toLowerCase() === account || my.chair)) out.push(`<button data-withdraw="${id}">Withdraw from the agenda</button>`);
    if ((st === 1 || (st === 2 && Number(m.closesAt) > now)) && isMember && !voted.get(account)?.[0]) out.push(`<details><summary>Recuse myself</summary><div class="stack"><p class="note">Step aside on this item, for example because of a conflict of interest. Your reason is public, and you no longer count toward quorum on it.</p><input type="text" data-f="recuseWhy" maxlength="128" placeholder="Reason (public)" /><button data-recuse="${id}">Recuse</button></div></details>`);
    if (st === 2 && Number(m.closesAt) > now) {
      for (const a of my.forMe || []) {
        if (voted.get(a.toLowerCase())?.[0]) continue;
        const seat = seats[members.indexOf(a)];
        out.push(`<p class="note">You are the alternate for <strong>${esc(seat)}</strong>.</p><div class="row"><button data-votefor="${id}:${a}:1">Yes for ${esc(seat)}</button><button data-votefor="${id}:${a}:2">No for ${esc(seat)}</button><button data-votefor="${id}:${a}:3">Abstain for ${esc(seat)}</button></div>`);
      }
    }
    if (st === 2 && Number(m.closesAt) > now) {
      if (isMember && !voted.get(account)?.[0]) out.push(`<div class="row">${reasonBox}</div><div class="row"><button data-vote="${id}:1">Vote Yes</button><button data-vote="${id}:2">Vote No</button><button data-vote="${id}:3">Abstain</button></div>`);
      if (isClerk) {
        const open = members.map((a, i) => [a, seats[i]]).filter(([a]) => !voted.get(a.toLowerCase())?.[0]);
        if (open.length) out.push(`<details><summary>Clerk: record a vote taken in the room</summary><div class="stack"><select data-f="member">${open.map(([a, s]) => `<option value="${a}">${esc(s)}</option>`).join('')}</select><select data-f="choice"><option value="1">Yes</option><option value="2">No</option><option value="3">Abstain</option></select>${reasonBox}<button data-record="${id}">Record vote</button></div></details>`);
      }
    }
    const allVoted = who.length >= Number(m.electorate); // votes and recusals
    if (st === 2 && (Number(m.closesAt) <= now || allVoted)) out.push(`<button class="primary" data-count="${id}">Count the votes</button>`);
    if (st === 3 && Number(m.executiveBy) > now && r.executive.toLowerCase() === account) out.push(`<label>Your public message <textarea data-f="exec" rows="2"></textarea></label><div class="row"><button class="primary" data-act="${id}:1">Sign it</button><button data-act="${id}:0">Veto it</button></div>`);
    if (st === 7 && Number(m.overrideBy) > now) {
      if (isMember && !voted.get(account)?.[1]) out.push(`<div class="row">${reasonBox}</div><div class="row"><button data-override="${id}:1">Override the veto</button><button data-override="${id}:0">Keep the veto</button></div>`);
    }
    const targets = others.filter((o) => o.id !== Number(m.bodyId));
    if (st === 4 && targets.length) out.push(`<details><summary>Send it to the next body</summary><div class="stack"><p class="note">For example from a committee to the council, or from the House to the Senate. It goes on that body's agenda with a link back to this decision.</p><select data-f="target">${targets.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select><button data-forward="${id}">Put it on that agenda</button></div></details>`);
    const overrideDone = Number(x.counts[3]) + Number(x.counts[4]) >= Number(m.electorate);
    if ((st === 3 && Number(m.executiveBy) <= now) || (st === 7 && (Number(m.overrideBy) <= now || overrideDone))) out.push(`<button class="primary" data-settle="${id}">Close it</button>`);
    return out.join('');
  }

  function wire(box) {
    const card = (el) => el.closest('article, .card.stack, .propose');
    const field = (el, f) => card(el).querySelector(`[data-f="${f}"]`)?.value?.trim() || '';
    const st = (el) => {
      const c = card(el);
      return c.querySelector(':scope > .status, :scope > .stack > .status') || c.querySelector('.status');
    };
    const after = async (ok) => ok && render();
    for (const sel of box.querySelectorAll('[data-f="action"]')) sel.onchange = () => {
      for (const d of card(sel).querySelectorAll('[data-show]')) d.hidden = d.dataset.show !== sel.value;
    };
    const checked = (el, f) => !!card(el).querySelector(`[data-f="${f}"]`)?.checked;
    const recordsSend = async (el, label, fn) => {
      status(el, `${label}: confirm…`);
      try {
        const k = new ethers.Contract(state.config.bodyRecordsAddress, RECORDS_ABI, ctx.activeSigner());
        await (await fn(k)).wait();
        status(el, `${label}: done.`, 'ok');
        return true;
      } catch (e) {
        let name = e.revert?.name;
        try {
          name ||= RECORD_ERRORS.parseError(e.data)?.name;
        } catch {
          /* not ours */
        }
        status(el, `${label} failed: ${ERRORS[name] || name || e.shortMessage || e.message}`, 'error');
        return false;
      }
    };
    for (const b of box.querySelectorAll('[data-propose]')) b.onclick = async () => {
      const el = st(b);
      const title = field(b, 'title');
      if (!title) return status(el, 'Give the item a title.', 'error');
      const kind = Number(field(b, 'action') || 0);
      let action = null;
      if (kind === 1) {
        const who = field(b, 'roleAccount');
        if (!ethers.isAddress(who)) return status(el, 'Enter the account that gets (or loses) the roles.', 'error');
        const until = field(b, 'roleUntil') ? Math.floor(Date.parse(field(b, 'roleUntil')) / 1000) : 0;
        action = { kind, account: ethers.getAddress(who), alternate: ethers.ZeroAddress, roles: (checked(b, 'roleChair') ? 1 : 0) | (checked(b, 'roleClerk') ? 2 : 0) | (checked(b, 'roleStaff') ? 4 : 0), until };
      } else if (kind === 2) {
        const alt = field(b, 'altAccount');
        if (alt && !ethers.isAddress(alt)) return status(el, 'Enter the alternate\'s account (0x…), or leave it empty to remove.', 'error');
        action = { kind, account: field(b, 'altMember'), alternate: alt ? ethers.getAddress(alt) : ethers.ZeroAddress, roles: 0, until: 0 };
      }
      status(el, 'Publishing the full text…');
      let files;
      try {
        files = card(b).querySelector('[data-attach]')?._picker?.list() || [];
      } catch (e) {
        return status(el, e.message, 'error');
      }
      const ref = await postDoc(state.config, ctx.activeSigner(), { title, body: field(b, 'body'), category: field(b, 'cat'), options: ['Yes', 'No'], ...(files.length ? { attachments: files } : {}) }).catch((e) => status(el, e.message, 'error'));
      const cat = ethers.id(field(b, 'cat') || 'general');
      bodyFilter[`body-${b.dataset.propose}`] = 'open'; // show the new item
      if (ref) after(await send(el, 'Put on the agenda', (k) => (action ? k.proposeAction(Number(b.dataset.propose), ref, cat, action) : k.propose(Number(b.dataset.propose), ref, cat))));
    };
    for (const b of box.querySelectorAll('[data-withdraw]')) b.onclick = async () => after(await send(st(b), 'Withdraw', (k) => k.withdraw(Number(b.dataset.withdraw))));
    for (const b of box.querySelectorAll('[data-recuse]')) b.onclick = async () => {
      if (!field(b, 'recuseWhy')) return status(st(b), 'Give your reason: it is public.', 'error');
      after(await send(st(b), 'Recuse', (k) => k.recuse(Number(b.dataset.recuse), field(b, 'recuseWhy'))));
    };
    for (const b of box.querySelectorAll('[data-votefor]')) b.onclick = async () => {
      const [id, member, c] = b.dataset.votefor.split(':');
      after(await send(st(b), `Vote ${CHOICE[Number(c)]} as alternate`, (k) => k.castVoteFor(Number(id), member, Number(c), field(b, 'reason'))));
    };
    for (const b of box.querySelectorAll('[data-draft]')) b.onclick = async () => {
      const el = st(b);
      if (!field(b, 'draftTitle')) return status(el, 'Give the draft a title.', 'error');
      status(el, 'Publishing the draft…');
      let files;
      try {
        files = card(b).querySelector('[data-attach]')?._picker?.list() || [];
      } catch (e) {
        return status(el, e.message, 'error');
      }
      const ref = await postDoc(state.config, ctx.activeSigner(), { title: field(b, 'draftTitle'), body: field(b, 'draftBody'), options: ['Yes', 'No'], draft: true, ...(files.length ? { attachments: files } : {}) }).catch((e) => status(el, e.message, 'error'));
      if (ref) after(await recordsSend(el, 'Submit draft', (k) => k.submitDraft(Number(b.dataset.draft), ref)));
    };
    for (const b of box.querySelectorAll('[data-sponsor]')) b.onclick = async () => {
      const [bodyId, draftId] = b.dataset.sponsor.split(':').map(Number);
      const d = await new ethers.Contract(state.config.bodyRecordsAddress, RECORDS_ABI, state.provider).getDraft(draftId);
      const doc = await readDoc(state.config, state.provider, d.ref);
      bodyFilter[`body-${bodyId}`] = 'open';
      after(await send(st(b), 'Sponsor', (k) => k.propose(bodyId, d.ref, ethers.id(doc.category || 'general'))));
    };
    for (const b of box.querySelectorAll('[data-closed]')) b.onclick = async () => {
      const el = st(b);
      const bodyId = Number(b.dataset.closed);
      const text = field(b, 'csMinutes');
      const by = field(b, 'csBy') ? Math.floor(Date.parse(field(b, 'csBy')) / 1000) : 0;
      if (!text || !by) return status(el, 'Write the minutes and the date by which they must be published.', 'error');
      const [r] = await reg().getBody(bodyId);
      const seal = sealOf(minutesDoc(r.name, text));
      try {
        localStorage.setItem(`mandate.minutes.${seal}`, text); // so this device can publish them later, unchanged
      } catch {
        /* keep your own copy */
      }
      if (await recordsSend(el, 'Record and seal', (k) => k.recordClosedSession(bodyId, Number(field(b, 'csReason')), field(b, 'csCite'), seal, by))) {
        status(el, 'Recorded. Keep the minutes exactly as written: only that text can be published against the seal (a copy is saved on this device).', 'ok');
        render();
      }
    };
    for (const b of box.querySelectorAll('[data-publish]')) {
      const [sid, bodyId] = b.dataset.publish.split(':').map(Number);
      const area = card(b).querySelector('[data-f="pubText"]');
      new ethers.Contract(state.config.bodyRecordsAddress, RECORDS_ABI, state.provider).getSession(sid).then(([x]) => {
        try {
          const saved = localStorage.getItem(`mandate.minutes.${x.minutesHash}`);
          if (saved && area && !area.value) area.value = saved;
        } catch {
          /* nothing saved */
        }
      }).catch(() => {});
      b.onclick = async () => {
        const el = st(b);
        const [x] = await new ethers.Contract(state.config.bodyRecordsAddress, RECORDS_ABI, state.provider).getSession(sid);
        const [r] = await reg().getBody(bodyId);
        const doc = minutesDoc(r.name, area.value.trim());
        if (sealOf(doc) !== x.minutesHash) return status(el, ERRORS.WrongMinutes, 'error');
        status(el, 'Publishing the minutes…');
        const ok = await postDoc(state.config, ctx.activeSigner(), doc).catch((e) => status(el, e.message, 'error'));
        if (ok) after(await recordsSend(el, 'Publish the minutes', (k) => k.publishMinutes(sid, x.minutesHash)));
      };
    }
    for (const a of box.querySelectorAll('[data-minutes]')) a.onclick = async (ev) => {
      ev.preventDefault();
      const d = await readDoc(state.config, state.provider, `nb:${a.dataset.minutes}`);
      a.closest('.card').querySelector('.minutes-text').innerHTML = `<p>${esc(d.body)}</p>`;
    };
    for (const b of box.querySelectorAll('[data-vote]')) b.onclick = async () => {
      const [id, c] = b.dataset.vote.split(':').map(Number);
      after(await send(st(b), `Vote ${CHOICE[c]}`, (k) => k.castVote(id, c, field(b, 'reason'))));
    };
    for (const b of box.querySelectorAll('[data-record]')) b.onclick = async () => {
      after(await send(st(b), 'Record vote', (k) => k.recordVote(Number(b.dataset.record), field(b, 'member'), Number(field(b, 'choice')), field(b, 'reason'))));
    };
    for (const b of box.querySelectorAll('[data-count]')) b.onclick = async () => after(await send(st(b), 'Count the votes', (k) => k.count(Number(b.dataset.count))));
    for (const b of box.querySelectorAll('[data-settle]')) b.onclick = async () => after(await send(st(b), 'Close it', (k) => k.settle(Number(b.dataset.settle))));
    for (const b of box.querySelectorAll('[data-act]')) b.onclick = async () => {
      const [id, sign] = b.dataset.act.split(':').map(Number);
      const el = st(b);
      const text = field(b, 'exec');
      const ref = text ? await postDoc(state.config, ctx.activeSigner(), { title: `${sign ? 'Signed' : 'Vetoed'}: motion ${id}`, body: text }).catch(() => '') : '';
      after(await send(el, sign ? 'Sign' : 'Veto', (k) => k.act(id, !!sign, ref)));
    };
    for (const b of box.querySelectorAll('[data-forward]')) b.onclick = async () => {
      const id = Number(b.dataset.forward);
      const el = st(b);
      const g = reg();
      const [m, counts] = await g.getMotion(id);
      const doc = await readDoc(state.config, state.provider, m.ref);
      const [r] = await g.getBody(m.bodyId);
      status(el, 'Publishing the item for the next body…');
      const ref = await postDoc(state.config, ctx.activeSigner(), { title: doc.title, body: doc.body, category: doc.category, options: ['Yes', 'No'], from: { motion: id, body: r.name, yes: Number(counts[0]), no: Number(counts[1]) } }).catch((e) => status(el, e.message, 'error'));
      bodyFilter[`body-${field(b, 'target')}`] = 'open';
      if (ref) after(await send(el, 'Put on the next agenda', (k) => k.propose(Number(field(b, 'target')), ref, m.category)));
    };
    for (const b of box.querySelectorAll('[data-override]')) b.onclick = async () => {
      const [id, yes] = b.dataset.override.split(':').map(Number);
      after(await send(st(b), yes ? 'Override' : 'Keep the veto', (k) => k.castOverride(id, !!yes, field(b, 'reason'))));
    };
  }

  // ----------------------------------------------------------------- admin

  function fill(t) {
    $('body-kind').value = t.kind;
    $('body-seats').value = t.seats;
    $('body-quorum').value = t.quorumPct;
    $('body-pass').value = t.passPct;
    $('body-pass-seats').checked = t.passOfSeats;
    $('body-override').value = t.overridePct;
    $('body-notice').value = +(t.noticeMinutes / 60).toFixed(2);
    $('body-vote').value = +(t.voteMinutes / 60).toFixed(2);
    $('body-exec-days').value = +(t.executiveMinutes / 1440).toFixed(2);
    $('body-silence').checked = t.silenceApproves;
    $('body-residents').value = String(t.residentTier);
    $('body-dissent').checked = t.explainDissent;
    $('body-reasons').checked = t.reasonsRequired;
    $('body-alternates').checked = !!t.allowAlternates;
    $('body-selfgov').checked = t.selfGoverned !== false;
  }
  function read() {
    const addr = (id) => {
      const v = $(id).value.trim();
      if (!v) return ethers.ZeroAddress;
      if (!ethers.isAddress(v)) throw new Error(`Enter a valid account address (0x…) for ${id === 'body-clerk' ? 'the clerk' : 'the executive'}, or leave it empty.`);
      return ethers.getAddress(v);
    };
    const executive = addr('body-executive');
    return {
      name: $('body-name').value.trim(), kind: $('body-kind').value.trim(), seats: Number($('body-seats').value), quorumPct: Number($('body-quorum').value),
      passPct: Number($('body-pass').value), passOfSeats: $('body-pass-seats').checked, overridePct: executive === ethers.ZeroAddress ? 0 : Number($('body-override').value),
      noticeMinutes: Math.round(Number($('body-notice').value) * 60), voteMinutes: Math.round(Number($('body-vote').value) * 60),
      executiveMinutes: executive === ethers.ZeroAddress ? 0 : Math.round(Number($('body-exec-days').value) * 1440), executive, silenceApproves: $('body-silence').checked,
      residentTier: Number($('body-residents').value), explainDissent: $('body-dissent').checked && $('body-residents').value !== '255', reasonsRequired: $('body-reasons').checked,
      clerk: addr('body-clerk'), active: $('body-active').checked, allowAlternates: $('body-alternates').checked, selfGoverned: $('body-selfgov').checked,
    };
  }

  async function admin() {
    const g = reg();
    const card = $('admin-bodies');
    if (!g || !me()) return (card.hidden = true);
    card.hidden = !(await g.hasRole(ethers.id('REGISTRAR_ROLE'), me()).catch(() => false));
    if (card.hidden) return;
    const n = Number(await g.bodyCount());
    const opts = ['<option value="0">A new body</option>'];
    for (let b = 1; b <= n; b++) opts.push(`<option value="${b}">${esc((await g.getBody(b))[0].name)}</option>`);
    const keep = $('body-edit').value;
    $('body-edit').innerHTML = opts.join('');
    $('body-seat-body').innerHTML = opts.slice(1).join('') || '<option value="">No bodies yet</option>';
    $('body-role-body').innerHTML = $('body-seat-body').innerHTML;
    if (keep) $('body-edit').value = keep;
  }

  // ----------------------------------------------------- whole organizations

  function orgBodies() {
    const t = ORG_TEMPLATES[$('org-type').value];
    const org = $('org-name').value.trim() || 'Our';
    return t.bodies.map((b, i) => ({ ...b, i, title: b.name.replace('{org}', org) }));
  }
  function drawOrg() {
    const t = ORG_TEMPLATES[$('org-type').value];
    $('org-about').textContent = `${t.about} Voters: ${t.who}.`;
    const bodies = orgBodies();
    $('org-bodies').innerHTML = bodies
      .map((b) => `<div class="card stack" data-org-body="${b.i}">
        <label class="row"><input type="checkbox" data-o="use" checked /> <strong>${esc(b.title)}</strong></label>
        <div class="row"><label>Seats <input type="text" data-o="seats" value="${b.seats}" inputmode="numeric" style="width:80px" /></label></div>
        ${b.executive ? `<label>${esc(b.executive)}'s account, who signs or vetoes (optional, 0x…) <input type="text" data-o="exec" autocomplete="off" spellcheck="false" /></label>` : ''}
        ${b.then !== undefined ? `<p class="note">Then: <span data-then="${b.then}">${esc(bodies[b.then]?.title || '')}</span></p>` : ''}
      </div>`)
      .join('');
    const rows = Object.entries(t.rules).map(([k, v]) => `<tr><td>${esc(RULE_WORDS[k]?.[0] || k)}</td><td>${esc(RULE_WORDS[k] ? RULE_WORDS[k][1](v) : String(v))}</td></tr>`);
    $('org-rules').innerHTML = `<details><summary>Suggested voting rules for residents' votes</summary><table class="data"><tbody>${rows.join('')}</tbody></table>
      <p class="note">The community's voting rules change only by public vote: open a rule-change poll for each one you want (Admin, Open a poll, "changes one of the community's voting rules").</p></details>`;
  }
  async function createOrg() {
    const el = $('org-status');
    if (!$('org-name').value.trim()) return status(el, 'Enter the organization\'s name.', 'error');
    const chosen = [];
    for (const b of orgBodies()) {
      const box = $('org-bodies').querySelector(`[data-org-body="${b.i}"]`);
      if (!box.querySelector('[data-o="use"]').checked) continue;
      const exec = box.querySelector('[data-o="exec"]')?.value.trim() || '';
      if (exec && !ethers.isAddress(exec)) return status(el, `Enter a valid account (0x…) for the ${b.executive}, or leave it empty.`, 'error');
      const base = TEMPLATES[b.base];
      const { label, ...baseRules } = base;
      void label;
      const executive = exec ? ethers.getAddress(exec) : ethers.ZeroAddress;
      const r = { ...baseRules, ...Object.fromEntries(Object.entries(b).filter(([k]) => k in baseRules)) };
      chosen.push({
        title: b.title,
        rules: {
          ...r, name: b.title, kind: base.kind || b.base, seats: Number(box.querySelector('[data-o="seats"]').value) || b.seats,
          executive, executiveMinutes: executive === ethers.ZeroAddress ? 0 : r.executiveMinutes || 10 * 1440, overridePct: executive === ethers.ZeroAddress ? 0 : r.overridePct,
          explainDissent: r.explainDissent && r.residentTier !== 255, clerk: ethers.ZeroAddress, active: true,
        },
      });
    }
    if (!chosen.length) return status(el, 'Choose at least one body.', 'error');
    for (const [i, c] of chosen.entries()) {
      if (!(await send(el, `Create ${c.title} (${i + 1} of ${chosen.length})`, (k) => k.createBody(c.rules)))) return;
    }
    status(el, `Created ${chosen.map((c) => c.title).join(', ')}. Seat members below; then items can go on their agendas.`, 'ok');
    await admin();
  }

  if ($('org-type')) {
    $('org-type').innerHTML = Object.entries(ORG_TEMPLATES).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join('');
    $('org-type').onchange = drawOrg;
    $('org-name').oninput = () => {
      for (const b of orgBodies()) {
        const strong = $('org-bodies').querySelector(`[data-org-body="${b.i}"] strong`);
        if (strong) strong.textContent = b.title;
        for (const t of $('org-bodies').querySelectorAll(`[data-then="${b.i}"]`)) t.textContent = b.title;
      }
    };
    $('btn-org-create').onclick = () => createOrg();
    drawOrg();
  }

  if ($('body-template')) {
    $('body-template').innerHTML = Object.entries(TEMPLATES).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join('');
    $('body-template').onchange = () => fill(TEMPLATES[$('body-template').value]);
    fill(TEMPLATES.city);
    $('body-edit').onchange = async () => {
      const b = Number($('body-edit').value);
      $('btn-body-save').textContent = b ? 'Save the new rules' : 'Set up this body';
      $('body-template-row').hidden = !!b;
      if (!b) return;
      const [r] = await reg().getBody(b);
      fill({ ...r.toObject(), noticeMinutes: Number(r.noticeMinutes), voteMinutes: Number(r.voteMinutes), executiveMinutes: Number(r.executiveMinutes), seats: Number(r.seats), quorumPct: Number(r.quorumPct), passPct: Number(r.passPct), overridePct: Number(r.overridePct), residentTier: Number(r.residentTier) });
      $('body-name').value = r.name;
      $('body-executive').value = r.executive === ethers.ZeroAddress ? '' : r.executive;
      $('body-clerk').value = r.clerk === ethers.ZeroAddress ? '' : r.clerk;
      $('body-active').checked = r.active;
    };
    $('btn-body-save').onclick = async () => {
      const el = $('body-status');
      let rules;
      try {
        rules = read();
      } catch (e) {
        return status(el, e.message, 'error');
      }
      if (!rules.name) return status(el, 'Give the body a name.', 'error');
      const b = Number($('body-edit').value);
      if (await send(el, b ? 'Save the new rules' : 'Set up the body', (k) => (b ? k.setRules(b, rules) : k.createBody(rules)))) await admin();
    };
    $('btn-body-seat').onclick = async () => {
      const el = $('body-seat-status');
      const who = $('body-seat-address').value.trim();
      if (!ethers.isAddress(who)) return status(el, 'Enter the member\'s account address (0x…).', 'error');
      if (!$('body-seat-name').value.trim()) return status(el, 'Name the seat (for example "District 3" or "At-large").', 'error');
      const remove = $('body-seat-remove').checked;
      const until = $('body-seat-until').value ? Math.floor(Date.parse($('body-seat-until').value) / 1000) : 0;
      await send(el, remove ? 'Remove from seat' : 'Seat member', (k) => (remove ? k.unseat(Number($('body-seat-body').value), ethers.getAddress(who)) : k.seat(Number($('body-seat-body').value), ethers.getAddress(who), $('body-seat-name').value.trim(), until)));
    };
    $('btn-body-role').onclick = async () => {
      const el = $('body-role-status');
      const who = $('body-role-address').value.trim();
      if (!ethers.isAddress(who)) return status(el, 'Enter their account address (0x…).', 'error');
      const roles = ($('body-role-chair').checked ? 1 : 0) | ($('body-role-clerk').checked ? 2 : 0) | ($('body-role-staff').checked ? 4 : 0);
      const until = $('body-role-until').value ? Math.floor(Date.parse($('body-role-until').value) / 1000) : 0;
      await send(el, roles ? 'Give roles' : 'Remove roles', (k) => k.setRoles(Number($('body-role-body').value), ethers.getAddress(who), roles, until));
    };
    $('btn-body-alternate').onclick = async () => {
      const el = $('body-role-status');
      const member = $('body-alt-member').value.trim();
      const alt = $('body-alt-address').value.trim();
      if (!ethers.isAddress(member) || (alt && !ethers.isAddress(alt))) return status(el, 'Enter the member\'s account, and their alternate\'s (or leave it empty to remove).', 'error');
      await send(el, 'Name alternate', (k) => k.setAlternate(Number($('body-role-body').value), ethers.getAddress(member), alt ? ethers.getAddress(alt) : ethers.ZeroAddress));
    };
  }

  /** What this account can do now in government bodies: vote, count, sign, close, publish minutes. */
  async function todos() {
    const g = reg();
    const account = me();
    if (!g || !account) return [];
    const a = account.toLowerCase();
    const [mc, block] = await Promise.all([g.motionCount(), state.provider.getBlock('latest')]);
    const now = Number(block.timestamp);
    const out = [];
    const bodyInfo = new Map();
    const info = async (b) => {
      if (!bodyInfo.has(b)) {
        const [r, , members] = await g.getBody(b);
        const alts = r.allowAlternates ? await Promise.all(members.map((m) => g.alternateOf(b, m))) : [];
        bodyInfo.set(b, { r, members, member: members.some((m) => m.toLowerCase() === a) && (await g.isMember(b, account)), staff: await g.holds(b, account, ROLE.CHAIR | ROLE.CLERK), forMe: members.filter((m, i) => alts[i]?.toLowerCase() === a) });
      }
      return bodyInfo.get(b);
    };
    for (let id = Number(mc); id >= Math.max(1, Number(mc) - 49); id--) {
      const [m, counts] = await g.getMotion(id);
      const st = Number(m.stage);
      if (![2, 3, 7].includes(st)) continue;
      const b = Number(m.bodyId);
      const x = await info(b);
      const [who, choice, , , over] = await g.rollCall(id);
      const voted = new Map(who.map((w, i) => [w.toLowerCase(), [Number(choice[i]), Number(over[i])]]));
      const title = esc((await readDoc(state.config, state.provider, m.ref)).title);
      const target = `motion-${id}`;
      const involved = x.member || x.staff;
      if (st === 2 && Number(m.closesAt) > now) {
        if (x.member && !voted.get(a)?.[0]) out.push({ action: 'Vote', text: `${esc(x.r.name)}: ${title} (closes ${countdown(m.closesAt)})`, target, urgent: true });
        for (const mm of x.forMe) if (!voted.get(mm.toLowerCase())?.[0]) out.push({ action: 'Vote as alternate', text: `${esc(x.r.name)}: ${title}`, target, urgent: true });
      }
      if (st === 2 && involved && (Number(m.closesAt) <= now || who.length >= Number(m.electorate))) out.push({ action: 'Count', text: `${esc(x.r.name)}: ${title} (voting is over)`, target, urgent: true });
      if (st === 3 && Number(m.executiveBy) > now && x.r.executive.toLowerCase() === a) out.push({ action: 'Sign or veto', text: `${esc(x.r.name)}: ${title} (by ${countdown(m.executiveBy)})`, target, urgent: true });
      if (st === 7 && Number(m.overrideBy) > now && x.member && !voted.get(a)?.[1]) out.push({ action: 'Override vote', text: `${esc(x.r.name)}: ${title}`, target, urgent: true });
      const overDone = Number(counts[3]) + Number(counts[4]) >= Number(m.electorate);
      if (involved && ((st === 3 && Number(m.executiveBy) <= now) || (st === 7 && (Number(m.overrideBy) <= now || overDone)))) out.push({ action: 'Close', text: `${esc(x.r.name)}: ${title}`, target, urgent: true });
    }
    if (state.config.bodyRecordsAddress) {
      const rec = new ethers.Contract(state.config.bodyRecordsAddress, RECORDS_ABI, state.provider);
      const sn = Number(await rec.sessionCount().catch(() => 0n));
      for (let k = sn; k >= Math.max(1, sn - 49); k--) {
        const [x, overdue] = await rec.getSession(k);
        if (Number(x.publishedAt) || (!overdue && Number(x.publishBy) - now > 7 * 86_400)) continue;
        if (!(await g.holds(x.bodyId, account, ROLE.CHAIR | ROLE.CLERK))) continue;
        out.push({ action: 'Publish minutes', text: `Closed session ${k}: ${overdue ? 'overdue' : `due ${countdown(x.publishBy)}`}`, target: `body-${x.bodyId}`, urgent: true });
      }
    }
    return out;
  }

  return { render, admin, todos: () => todos().catch(() => []) };
}

/** Dashboard: every body, its recent decisions, and how often each member sided with residents. */
export async function bodiesDashboard(cfg, provider, esc) {
  if (!cfg.bodiesAddress) return '<p class="muted">Not set up on this deployment.</p>';
  const g = new ethers.Contract(cfg.bodiesAddress, BODIES_ABI, provider);
  const [n, mc, block, names] = await Promise.all([g.bodyCount(), g.motionCount(), provider.getBlock('latest'), nameBook(cfg, provider), uploadService(cfg)]);
  if (!Number(n)) return '<p class="muted">No bodies set up yet.</p>';
  const now = Number(block.timestamp);
  const out = [];
  const sided = {}; // member => [with, against]
  const recentByBody = {};
  for (let id = Number(mc); id >= Math.max(1, Number(mc) - 49); id--) {
    const [m] = await g.getMotion(id);
    (recentByBody[m.bodyId] ||= []).push(id);
  }
  for (let b = 1; b <= Number(n); b++) {
    const [r, , members] = await g.getBody(b);
    const items = [];
    for (const id of (recentByBody[b] || []).slice(0, 8)) {
      const x = await motionHtml(cfg, provider, g, id, esc, names, now);
      const res = Number(await g.residentResult(id).catch(() => 0n));
      if (res) x.who.forEach((a, i) => {
        const c = Number(x.choice[i]);
        if (c === 1 || c === 2) (sided[a.toLowerCase()] ||= [0, 0])[c === res ? 0 : 1]++;
      });
      items.push(`<li id="dash-motion-${id}">${x.html}</li>`);
    }
    const score = members.map((a) => {
      const [w, ag] = sided[a.toLowerCase()] || [0, 0];
      return `<tr><td>${esc(names[a.toLowerCase()] || short(a))}</td><td class="num">${w + ag ? `${w} of ${w + ag}` : '-'}</td></tr>`;
    });
    let closed = '';
    if (cfg.bodyRecordsAddress) {
      const rec = new ethers.Contract(cfg.bodyRecordsAddress, RECORDS_ABI, provider);
      const sn = Number(await rec.sessionCount().catch(() => 0n));
      const rows = [];
      for (let k = sn; k >= Math.max(1, sn - 49); k--) {
        const [x, overdue] = await rec.getSession(k);
        if (Number(x.bodyId) !== b) continue;
        rows.push(`<li>${esc(CLOSED_REASONS[Number(x.reason)] || 'Other')}${x.cite ? ` (${esc(x.cite)})` : ''} · held ${countdown(x.heldAt)} · ${Number(x.publishedAt) ? 'minutes published, matching their seal' : overdue ? '<strong class="warn">▲ minutes overdue</strong>' : `minutes due ${countdown(x.publishBy)}`}</li>`);
      }
      if (rows.length) closed = `<details${rows.some((x) => x.includes('overdue')) ? ' open' : ''}><summary>Closed sessions (${rows.length})</summary><ul class="list">${rows.join('')}</ul></details>`;
    }
    out.push(`<div class="card stack"><p class="eyebrow">${esc(r.kind || 'Body')}</p><h3>${esc(r.name)}</h3>${closed}
      <details><summary>How it decides</summary>${rulesSummary(r, esc, names)}</details>
      ${score.length ? `<table class="data"><thead><tr><th>Member</th><th class="num">Sided with residents</th></tr></thead><tbody>${score.join('')}</tbody></table>` : ''}
      <ul class="list">${items.join('') || '<li class="muted">No decisions yet.</li>'}</ul></div>`);
  }
  return out.join('');
}
