/**
 * app/src/bodies.js - government bodies and organizations deciding in public:
 *   Bodies screen  each body's own rules in plain words, its members by seat, the agenda
 *                  with countdowns, residents' result beside the roll call, and the
 *                  buttons for whoever may act (members vote, the clerk records votes
 *                  taken in the room, the executive signs or vetoes, anyone counts)
 *   Admin          registrars set up a body from a template (city council, school board,
 *                  co-op...) and change any rule, and seat members
 *   Dashboard      every body's recent decisions and how often each member sided with
 *                  residents
 */

import { ethers } from 'ethers';
import { countdown } from './time.js';
import { readDoc, postDoc } from './notices.js';
import { categoryChip, categoryFromHash, categoryOptions } from './priority.js';

const RULES = 'tuple(string name, string kind, uint32 seats, uint16 quorumPct, uint16 passPct, bool passOfSeats, uint16 overridePct, uint32 noticeMinutes, uint32 voteMinutes, uint32 executiveMinutes, address executive, bool silenceApproves, uint8 residentTier, bool explainDissent, bool reasonsRequired, address clerk, bool active)';
const MOTION = 'tuple(uint256 bodyId, string ref, bytes32 category, address proposer, uint64 noticeAt, uint64 opensAt, uint64 closesAt, uint256 residentPoll, uint8 stage, uint64 executiveBy, uint64 overrideBy, uint32 version, uint32 electorate, bool overridden, string executiveRef)';
export const BODIES_ABI = [
  'function bodyCount() view returns (uint256)',
  `function getBody(uint256) view returns (${RULES} r, uint32 version, address[] members)`,
  `function rulesAt(uint256, uint32) view returns (${RULES})`,
  'function seatOf(uint256, address) view returns (string)',
  'function isMember(uint256, address) view returns (bool)',
  'function motionCount() view returns (uint256)',
  `function getMotion(uint256) view returns (${MOTION} m, uint32[5] counts)`,
  'function rollCall(uint256) view returns (address[] who, uint8[] choice, string[] reason, bool[] byClerk, uint8[] overrideChoice)',
  'function residentResult(uint256) view returns (uint8)',
  'function hasRole(bytes32, address) view returns (bool)',
  `function createBody(${RULES}) returns (uint256)`,
  `function setRules(uint256, ${RULES})`,
  'function seat(uint256, address, string)',
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
};
const BODY_ERRORS = new ethers.Interface(BODIES_ABI.filter((x) => x.startsWith('error')));

export const STAGES = ['', 'On the agenda', 'Voting', 'Awaiting the executive', 'Adopted', 'Did not pass', 'Vetoed', 'Override vote', 'Lapsed'];
const CHOICE = ['', 'Yes', 'No', 'Abstain'];
const TIERS = ['all members', 'ID-checked residents', 'residents with full voting rights'];

/** Starting points: every value can be changed before (and after) the body is set up. */
export const TEMPLATES = {
  city: { label: 'City or town council', kind: 'city council', seats: 7, quorumPct: 51, passPct: 50, passOfSeats: false, overridePct: 67, noticeMinutes: 72 * 60, voteMinutes: 7 * 24 * 60, executiveMinutes: 10 * 24 * 60, silenceApproves: true, residentTier: 2, explainDissent: true, reasonsRequired: false },
  county: { label: 'County board', kind: 'county board', seats: 5, quorumPct: 60, passPct: 50, passOfSeats: false, overridePct: 0, noticeMinutes: 72 * 60, voteMinutes: 7 * 24 * 60, executiveMinutes: 0, silenceApproves: true, residentTier: 2, explainDissent: true, reasonsRequired: false },
  legislature: { label: 'State legislature (one chamber)', kind: 'legislative chamber', seats: 100, quorumPct: 51, passPct: 50, passOfSeats: true, overridePct: 67, noticeMinutes: 5 * 24 * 60, voteMinutes: 3 * 24 * 60, executiveMinutes: 10 * 24 * 60, silenceApproves: true, residentTier: 2, explainDissent: true, reasonsRequired: false },
  school: { label: 'School board', kind: 'school board', seats: 7, quorumPct: 51, passPct: 50, passOfSeats: false, overridePct: 0, noticeMinutes: 72 * 60, voteMinutes: 3 * 24 * 60, executiveMinutes: 0, silenceApproves: true, residentTier: 2, explainDissent: false, reasonsRequired: false },
  committee: { label: 'Committee or commission', kind: 'committee', seats: 5, quorumPct: 51, passPct: 50, passOfSeats: false, overridePct: 0, noticeMinutes: 48 * 60, voteMinutes: 3 * 24 * 60, executiveMinutes: 0, silenceApproves: true, residentTier: 255, explainDissent: false, reasonsRequired: false },
  nonprofit: { label: 'Nonprofit or company board', kind: 'board of directors', seats: 9, quorumPct: 51, passPct: 50, passOfSeats: false, overridePct: 0, noticeMinutes: 7 * 24 * 60, voteMinutes: 3 * 24 * 60, executiveMinutes: 0, silenceApproves: true, residentTier: 255, explainDissent: false, reasonsRequired: true },
  coop: { label: 'Co-op, union or association board', kind: 'member board', seats: 7, quorumPct: 51, passPct: 50, passOfSeats: false, overridePct: 0, noticeMinutes: 7 * 24 * 60, voteMinutes: 7 * 24 * 60, executiveMinutes: 0, silenceApproves: true, residentTier: 0, explainDissent: true, reasonsRequired: false },
  hoa: { label: 'Neighborhood or HOA board', kind: 'neighborhood board', seats: 5, quorumPct: 60, passPct: 50, passOfSeats: false, overridePct: 0, noticeMinutes: 4 * 24 * 60, voteMinutes: 7 * 24 * 60, executiveMinutes: 0, silenceApproves: true, residentTier: 1, explainDissent: true, reasonsRequired: false },
  custom: { label: 'Custom: start from scratch', kind: '', seats: 5, quorumPct: 51, passPct: 50, passOfSeats: false, overridePct: 0, noticeMinutes: 24 * 60, voteMinutes: 3 * 24 * 60, executiveMinutes: 0, silenceApproves: true, residentTier: 255, explainDissent: false, reasonsRequired: false },
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
  const [who, choice, reason, byClerk, overrideChoice] = await g.rollCall(id);
  const total = Number(counts[0]) + Number(counts[1]) + Number(counts[2]);
  const clock =
    st === 1 ? `voting opens ${countdown(m.opensAt)}`
    : st === 2 ? (Number(m.closesAt) > now ? `voting closes ${countdown(m.closesAt)}` : 'voting closed · waiting to be counted')
    : st === 3 ? (Number(m.executiveBy) > now ? `executive must act ${countdown(m.executiveBy)}` : 'executive deadline passed · waiting to be closed')
    : st === 7 ? (Number(m.overrideBy) > now ? `override vote closes ${countdown(m.overrideBy)}` : 'override vote closed · waiting to be closed')
    : `put on the agenda ${countdown(m.noticeAt)}`;
  const resLine = res
    ? `<p><strong>Residents:</strong> ${res.yes} Yes · ${res.no} No${res.closed ? (res.result === 1 ? ' · <strong>residents said Yes</strong>' : res.result === 2 ? ' · <strong>residents said No</strong>' : ' · no clear result') : ` · residents' vote closes ${countdown(res.end)}`}</p>`
    : '';
  const rows = who.map((a, i) => {
    const c = Number(choice[i]);
    const against = res && res.result && c && c !== 3 && c !== res.result;
    return `<tr${against ? ' class="against"' : ''}><td>${esc(names[a.toLowerCase()] || short(a))}</td><td><strong>${CHOICE[c] || '-'}</strong>${Number(overrideChoice[i]) ? ` · override: ${Number(overrideChoice[i]) === 1 ? 'Yes' : 'No'}` : ''}${byClerk[i] ? ' <span class="muted">(recorded by clerk)</span>' : ''}${against ? ' <span class="warn">▲ against residents</span>' : ''}</td><td>${esc(reason[i] || '')}</td></tr>`;
  });
  return {
    m, st, r, counts, who, choice, overrideChoice, doc,
    html: `<p class="eyebrow">Motion ${id} · <strong>${STAGES[st]}</strong> · ${clock}</p>
      <h3>${esc(doc.title)} ${categoryChip(categoryFromHash(m.category), esc)}</h3>${doc.body ? `<p>${esc(doc.body)}</p>` : ''}
      ${resLine}
      <p><strong>Members:</strong> ${counts[0]} Yes · ${counts[1]} No · ${counts[2]} Abstain · ${total} of ${m.electorate} voted${st === 7 || Number(counts[3]) + Number(counts[4]) ? ` · override ${counts[3]} Yes · ${counts[4]} No` : ''}${m.overridden ? ' · <strong>veto overridden</strong>' : ''}</p>
      ${m.executiveRef ? `<p class="muted">Executive's message: ${esc((await readDoc(cfg, provider, m.executiveRef)).body || m.executiveRef)}</p>` : ''}
      ${rows.length ? `<details${st === 2 || st === 7 ? ' open' : ''}><summary>Roll call (${rows.length})</summary><table class="data"><thead><tr><th>Member</th><th>Vote</th><th>Reason</th></tr></thead><tbody>${rows.join('')}</tbody></table></details>` : ''}`,
  };
}

export function wireBodies(ctx) {
  const { state, $, status, esc } = ctx;
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
    const [n, mc, block, names] = await Promise.all([g.bodyCount(), g.motionCount(), state.provider.getBlock('latest'), nameBook(state.config, state.provider)]);
    const now = Number(block.timestamp);
    const account = me().toLowerCase();
    if (!Number(n)) return (box.innerHTML = '<p class="muted">No bodies yet. A registrar sets them up under Admin.</p>');
    const motionsOf = {};
    for (let id = Number(mc); id >= Math.max(1, Number(mc) - 49); id--) {
      const [m] = await g.getMotion(id);
      (motionsOf[m.bodyId] ||= []).push(id);
    }
    const cards = [];
    for (let b = 1; b <= Number(n); b++) {
      const [r, , members] = await g.getBody(b);
      const seats = await Promise.all(members.map((a) => g.seatOf(b, a)));
      const mine = members.some((a) => a.toLowerCase() === account);
      const clerk = r.clerk.toLowerCase() === account && account;
      const items = [];
      for (const id of motionsOf[b] || []) {
        const x = await motionHtml(state.config, state.provider, g, id, esc, names, now);
        items.push(`<article class="card stack motion" id="motion-${id}">${x.html}${actions(id, x, now, account, members, seats)}<p class="status" role="status"></p></article>`);
      }
      cards.push(`<section class="card stack" id="body-${b}">
        <p class="eyebrow">${esc(r.kind || 'Body')}${r.active ? '' : ' · inactive'}</p><h2>${esc(r.name)}</h2>
        <details><summary>How this body decides</summary>${rulesSummary(r, esc, names)}</details>
        <details><summary>Members (${members.length} of ${r.seats} seats)</summary><ul class="list">${members.map((a, i) => `<li>${esc(seats[i])}: <strong>${esc(names[a.toLowerCase()] || short(a))}</strong></li>`).join('') || '<li class="muted">No members seated yet.</li>'}</ul></details>
        ${(mine || clerk) && r.active ? `<details class="propose"><summary><strong>Put an item on the agenda</strong></summary><div class="stack">
          <label>Title <input type="text" data-f="title" /></label><label>Full text<textarea data-f="body" rows="4"></textarea></label>
          <label>Topic <select data-f="cat">${categoryOptions()}</select></label>
          <p class="note">It is published at once; voting opens after the ${dur(r.noticeMinutes)} notice period${Number(r.residentTier) === 255 ? '' : ', while residents vote on it'}.</p>
          <button class="primary" data-propose="${b}">Publish to the agenda</button><p class="status" role="status"></p></div></details>` : ''}
        <h3>Agenda and decisions</h3>${items.join('') || '<p class="muted">Nothing on the agenda.</p>'}
      </section>`);
    }
    box.innerHTML = cards.join('');
    wire(box);
  }

  /** Buttons for whoever may act on this motion now. */
  function actions(id, x, now, account, members, seats) {
    if (!account) return '';
    const { m, st, r, who, choice, overrideChoice } = x;
    const voted = new Map(who.map((a, i) => [a.toLowerCase(), [Number(choice[i]), Number(overrideChoice[i])]]));
    const isMember = members.some((a) => a.toLowerCase() === account);
    const isClerk = r.clerk.toLowerCase() === account;
    const out = [];
    const reasonBox = '<input type="text" data-f="reason" maxlength="128" placeholder="Reason (public)" />';
    if (st === 2 && Number(m.closesAt) > now) {
      if (isMember && !voted.get(account)?.[0]) out.push(`<div class="row">${reasonBox}</div><div class="row"><button data-vote="${id}:1">Vote Yes</button><button data-vote="${id}:2">Vote No</button><button data-vote="${id}:3">Abstain</button></div>`);
      if (isClerk) {
        const open = members.map((a, i) => [a, seats[i]]).filter(([a]) => !voted.get(a.toLowerCase())?.[0]);
        if (open.length) out.push(`<details><summary>Clerk: record a vote taken in the room</summary><div class="stack"><select data-f="member">${open.map(([a, s]) => `<option value="${a}">${esc(s)}</option>`).join('')}</select><select data-f="choice"><option value="1">Yes</option><option value="2">No</option><option value="3">Abstain</option></select>${reasonBox}<button data-record="${id}">Record vote</button></div></details>`);
      }
    }
    const allVoted = Number(x.counts[0]) + Number(x.counts[1]) + Number(x.counts[2]) >= Number(m.electorate);
    if (st === 2 && (Number(m.closesAt) <= now || allVoted)) out.push(`<button class="primary" data-count="${id}">Count the votes</button>`);
    if (st === 3 && Number(m.executiveBy) > now && r.executive.toLowerCase() === account) out.push(`<label>Your public message <textarea data-f="exec" rows="2"></textarea></label><div class="row"><button class="primary" data-act="${id}:1">Sign it</button><button data-act="${id}:0">Veto it</button></div>`);
    if (st === 7 && Number(m.overrideBy) > now) {
      if (isMember && !voted.get(account)?.[1]) out.push(`<div class="row">${reasonBox}</div><div class="row"><button data-override="${id}:1">Override the veto</button><button data-override="${id}:0">Keep the veto</button></div>`);
    }
    const overrideDone = Number(x.counts[3]) + Number(x.counts[4]) >= Number(m.electorate);
    if ((st === 3 && Number(m.executiveBy) <= now) || (st === 7 && (Number(m.overrideBy) <= now || overrideDone))) out.push(`<button class="primary" data-settle="${id}">Close it</button>`);
    return out.join('');
  }

  function wire(box) {
    const card = (el) => el.closest('article, .propose');
    const field = (el, f) => card(el).querySelector(`[data-f="${f}"]`)?.value?.trim() || '';
    const st = (el) => card(el).querySelector('.status');
    const after = async (ok) => ok && render();
    for (const b of box.querySelectorAll('[data-propose]')) b.onclick = async () => {
      const el = st(b);
      const title = field(b, 'title');
      if (!title) return status(el, 'Give the item a title.', 'error');
      status(el, 'Publishing the full text…');
      const ref = await postDoc(state.config, ctx.activeSigner(), { title, body: field(b, 'body'), category: field(b, 'cat'), options: ['Yes', 'No'] }).catch((e) => status(el, e.message, 'error'));
      if (ref) after(await send(el, 'Put on the agenda', (k) => k.propose(Number(b.dataset.propose), ref, ethers.id(field(b, 'cat') || 'general'))));
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
      clerk: addr('body-clerk'), active: $('body-active').checked,
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
    if (keep) $('body-edit').value = keep;
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
      await send(el, remove ? 'Remove from seat' : 'Seat member', (k) => (remove ? k.unseat(Number($('body-seat-body').value), ethers.getAddress(who)) : k.seat(Number($('body-seat-body').value), ethers.getAddress(who), $('body-seat-name').value.trim())));
    };
  }

  return { render, admin };
}

/** Dashboard: every body, its recent decisions, and how often each member sided with residents. */
export async function bodiesDashboard(cfg, provider, esc) {
  if (!cfg.bodiesAddress) return '<p class="muted">Not set up on this deployment.</p>';
  const g = new ethers.Contract(cfg.bodiesAddress, BODIES_ABI, provider);
  const [n, mc, block, names] = await Promise.all([g.bodyCount(), g.motionCount(), provider.getBlock('latest'), nameBook(cfg, provider)]);
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
    out.push(`<div class="card stack"><p class="eyebrow">${esc(r.kind || 'Body')}</p><h3>${esc(r.name)}</h3>
      <details><summary>How it decides</summary>${rulesSummary(r, esc, names)}</details>
      ${score.length ? `<table class="data"><thead><tr><th>Member</th><th class="num">Sided with residents</th></tr></thead><tbody>${score.join('')}</tbody></table>` : ''}
      <ul class="list">${items.join('') || '<li class="muted">No decisions yet.</li>'}</ul></div>`);
  }
  return out.join('');
}
