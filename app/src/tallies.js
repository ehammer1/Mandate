/**
 * app/src/tallies.js - paper ballots, in-person votes and official election results:
 *   on a poll card   "Voting on paper? Check in": the voter's phone checks in at a polling
 *                    place anonymously (same one-time code as an online ballot), and shows a
 *                    code the clerk sees too; then in-person counts beside the online count,
 *                    combined with each person counted once
 *   Admin (clerks)   polling places, check-ins per place, recording a place's counts with a
 *                    photo of the tally sheet, confirming another clerk's tally, corrections
 *   Dashboard        official election and meeting results, place by place
 */

import { ethers } from 'ethers';
import { readDoc, postDoc } from './notices.js';
import { attachPicker, attachmentsHtml, wireAttachments } from './attach.js';
import { countdown } from './time.js';
import { checkInProof } from '../../client/checkin.js';

const ENTRY = 'tuple(uint32 place, uint32[] counts, uint32 ballots, string ref, uint256 replaces, string reason)';
export const TALLIES_ABI = [
  'function CLERK_ROLE() view returns (bytes32)',
  'function hasRole(bytes32, address) view returns (bool)',
  'function contestCount() view returns (uint256)',
  'function contestOfPoll(uint256) view returns (uint256)',
  'function getContest(uint256) view returns (tuple(uint8 kind, uint256 pollId, string ref, uint8 options, address createdBy, uint64 createdAt, bool closed))',
  'function getTally(uint256) view returns (tuple(uint256 contestId, uint32 place, uint32[] counts, uint32 ballots, string ref, address recordedBy, uint64 recordedAt, address confirmedBy, uint64 confirmedAt, uint256 replacedBy, string reason))',
  'function talliesOf(uint256) view returns (uint256[])',
  'function placesOf(uint256) view returns (string[])',
  'function checkIns(uint256, uint256) view returns (uint32)',
  'function checkInsOf(uint256) view returns (uint256[])',
  'function checkedInAt(uint256, uint256) view returns (uint32)',
  'function totals(uint256) view returns (uint256[] counts, uint256 ballots, uint256 places, uint256 unconfirmed)',
  'function contestForPoll(uint256, uint8) returns (uint256)',
  'function createContest(uint8, string, uint8) returns (uint256)',
  'function addPlace(uint256, string) returns (uint32)',
  `function record(uint256, ${ENTRY}) returns (uint256)`,
  'function confirm(uint256)',
  'function closeContest(uint256)',
  'event CheckedIn(uint256 indexed pollId, uint32 place, uint256 nullifier)',
  'error NotAllowed()', 'error BadInput()', 'error Unknown()', 'error AlreadyConfirmed()', 'error SameClerk()', 'error Closed()', 'error Replaced()',
  'error NotOpen()', 'error AlreadyCheckedIn()', 'error BadProof()', 'error MoreBallotsThanCheckIns()',
];
const ERRORS = {
  BadInput: 'Check the numbers: one count per option, and the choices cannot add up to more than the ballots cast. A correction needs a reason.',
  SameClerk: 'A different clerk must confirm this tally (two-person rule).',
  AlreadyConfirmed: 'Already confirmed.',
  Closed: 'This contest is closed: its results are final.',
  Replaced: 'That tally was already corrected; work from the latest one.',
  MoreBallotsThanCheckIns: 'More paper ballots than voters who checked in at this place. Every paper voter must check in first; check the count.',
  NotOpen: 'Check-in is not open for this poll (it has closed, or this place is not set up).',
  AlreadyCheckedIn: 'You have already checked in for this poll.',
  BadProof: 'Your voter list changed a moment ago; please try again.',
};
const IFACE = new ethers.Interface(TALLIES_ABI.filter((x) => x.startsWith('error')));
export const KIND = ['', 'Promissa poll', 'Official election', 'Meeting vote'];
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const num = (n) => Number(n).toLocaleString();
/** The code shown on the voter's phone after check-in, and on the clerk's list: last 6 digits. */
export const checkInCode = (nullifier) => String(nullifier).slice(-6);
// Mail-in ballots are a "place" whose name says so: voters check in on their phone at home and
// write the code on the return envelope; clerks match envelopes to check-ins the same way.
const MAIL = 'By mail:';
export const isMail = (name) => String(name).startsWith(MAIL);

const contract = (cfg, runner) => (cfg.talliesAddress ? new ethers.Contract(cfg.talliesAddress, TALLIES_ABI, runner) : null);

async function describe(cfg, provider, c, pollLabels) {
  if (Number(c.kind) === 1) return { title: `Poll ${c.pollId}`, options: pollLabels || Array.from({ length: Number(c.options) }, (_, i) => (i === 0 ? 'Yes' : i === 1 ? 'No' : `Choice ${i + 1}`)) };
  const d = await readDoc(cfg, provider, c.ref).catch(() => ({ title: 'Contest', options: null }));
  return { title: d.title, body: d.body, options: d.options && d.options.length === Number(c.options) ? d.options : Array.from({ length: Number(c.options) }, (_, i) => `Option ${i + 1}`) };
}

async function placesHtml(cfg, provider, k, contestId, options, esc) {
  const [ids, places] = await Promise.all([k.talliesOf(contestId), k.placesOf(contestId)]);
  const rows = [];
  for (const id of [...ids].reverse()) {
    const t = await k.getTally(id);
    const sheet = t.ref ? await readDoc(cfg, provider, t.ref).catch(() => null) : null;
    const state = Number(t.replacedBy) ? `corrected by tally ${t.replacedBy}` : t.confirmedBy !== ethers.ZeroAddress ? `confirmed by ${short(t.confirmedBy)}` : '<strong class="warn">awaiting a second clerk</strong>';
    rows.push(`<li${Number(t.replacedBy) ? ' class="replaced"' : ''} id="tally-${id}"><p class="eyebrow">Tally ${id} · ${esc(places[Number(t.place)] || 'place')} · recorded by ${esc(short(t.recordedBy))} ${countdown(t.recordedAt)} · ${state}</p>
      <p>${options.map((o, i) => `${esc(o)} <strong>${num(t.counts[i])}</strong>`).join(' · ')} · ${num(t.ballots)} ballots</p>
      ${t.reason ? `<p class="note">Correction: ${esc(t.reason)}</p>` : ''}
      ${sheet ? `${sheet.body ? `<p class="muted">${esc(sheet.body)}</p>` : ''}${attachmentsHtml(cfg, sheet, esc)}` : ''}</li>`);
  }
  return rows.join('');
}

/** Online ballots of people who also checked in on paper: their paper ballot is the one that counts. */
/** Which vote counts when someone votes both online and on paper: the community's rule for
 *  this poll (set in its question when it opened), else the deployment's default (paper). */
export const finalRule = (q, cfg) => ((q?.final || cfg?.finalVote) === 'latest' ? 'latest' : 'paper');

/**
 * Voters who checked in on paper and also voted online, with when each happened (block, then
 * position in it), so the combined count can keep the right one of their two votes.
 */
async function doubleVotes(state, k, pollId) {
  const checked = (await k.checkInsOf(pollId)).map(String);
  if (!checked.length) return [];
  const vote = new ethers.Contract(state.config.voteAddress, ['function nullifierUsed(uint256, uint256) view returns (bool)', 'event BallotCast(uint256 indexed id, uint256 option, uint256 nullifier)', 'function getPoll(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 quorum, uint8 options, uint8 action, bool finalized, bool passed, address proposer, uint256 bond, string questionCID, bytes actionData))'], state.provider);
  const both = [];
  for (const n of checked) if (await vote.nullifierUsed(pollId, n).catch(() => false)) both.push(n);
  if (!both.length) return [];
  // Find those ballots and check-ins: search the poll's blocks (a few seconds per block on Base).
  const poll = await vote.getPoll(pollId);
  const head = await state.provider.getBlock('latest');
  const from = Math.max(0, head.number - Math.ceil((head.timestamp - Number(poll.start)) / 2) - 2000);
  const want = new Set(both);
  const latest = new Map(); // a voter who changed their vote: only their latest ballot was counted
  const checkIn = new Map();
  const at = (l) => l.blockNumber * 1e6 + (l.index ?? l.logIndex ?? 0);
  for (let a = from; a <= head.number; a += 9000) {
    const b = Math.min(head.number, a + 8999);
    const [ballots, ins] = await Promise.all([vote.queryFilter(vote.filters.BallotCast(pollId), a, b).catch(() => []), k.queryFilter(k.filters.CheckedIn(pollId), a, b).catch(() => [])]);
    for (const l of ballots) if (want.has(String(l.args.nullifier))) latest.set(String(l.args.nullifier), { option: Number(l.args.option), at: at(l) });
    for (const l of ins) if (want.has(String(l.args.nullifier))) checkIn.set(String(l.args.nullifier), { place: Number(l.args.place), at: at(l) });
  }
  return [...latest].map(([nullifier, b]) => ({ nullifier, option: b.option, onlineLast: b.at > (checkIn.get(nullifier)?.at ?? Infinity), place: checkIn.get(nullifier)?.place ?? -1 }));
}

/** On a poll card: check in to vote on paper, and in-person counts beside the online count. */
export async function pollTallies(box, ctx, pollId, labels, online, canVote, final = 'paper') {
  const { state, esc } = ctx;
  const k = contract(state.config, state.provider);
  if (!k || !box) return;
  const contestId = await k.contestOfPoll(pollId);
  if (!Number(contestId)) return (box.innerHTML = '');
  const [c, places, [counts, ballots, confirmedPlaces, unconfirmed]] = await Promise.all([k.getContest(contestId), k.placesOf(contestId), k.totals(contestId)]);
  const all = await doubleVotes(state, k, pollId).catch(() => []);
  // Paper is final: every double voter's online ballot is left out. Latest counts: the online
  // ballot is left out only if they checked in after it; otherwise their envelope is set aside.
  const doubles = final === 'latest' ? all.filter((d) => !d.onlineLast) : all;
  const setAside = final === 'latest' ? all.filter((d) => d.onlineLast) : [];
  const combined = labels.map((l, i) => {
    const onlineHere = BigInt(online[i] || 0) - BigInt(doubles.filter((d) => d.option === i).length);
    return `${esc(l)} ${num(onlineHere + counts[i])}`;
  });
  const checkInHtml = canVote && places.length && !c.closed
    ? `<details class="checkin"><summary><strong>Voting on paper at a polling place? Check in</strong></summary><div class="stack">
        <p class="note">Check in at the desk before you get a paper ballot. Your phone proves privately that you are on the voter list, the same way an online vote does, without saying who you are. ${final === 'latest' ? 'Your paper ballot goes in an envelope marked with your check-in code. This poll counts your latest vote: if you vote online after checking in, your envelope is set aside unopened and the online vote counts.' : 'If you also vote online, only your paper ballot counts.'}</p>
        <label>Polling place <select data-place>${places.map((p, i) => `<option value="${i}">${esc(p)}</option>`).join('')}</select></label>
        ${places.some(isMail) ? '<p class="note"><strong>Voting by mail?</strong> Choose the mail option and check in at home: write the code it shows on your return envelope (not on the ballot), then mail it. Clerks match each envelope to a check-in, so nobody is counted twice.</p>' : ''}
        <button class="primary" data-checkin>Check in</button><p class="status" role="status"></p><div data-code></div></div></details>`
    : '';
  box.innerHTML = `<div class="card stack tallies">
    ${checkInHtml}
    <p><strong>In person and on paper:</strong> ${labels.map((l, i) => `${esc(l)} ${num(counts[i])}`).join(' · ')} (${num(ballots)} ballots, ${num(confirmedPlaces)} place${Number(confirmedPlaces) === 1 ? '' : 's'} confirmed${Number(unconfirmed) ? `, ${num(unconfirmed)} awaiting confirmation` : ''})</p>
    <p><strong>Everyone, online and on paper:</strong> ${combined.join(' · ')}</p>
    <p class="note"><strong>Rule for this poll:</strong> ${final === 'latest' ? 'if someone votes both online and on paper, whichever they cast last counts. Paper ballots go in envelopes marked with the check-in code, so a later online vote can replace one.' : 'if someone votes both online and on paper, the paper ballot counts (paper is final).'}</p>
    ${doubles.length ? `<p class="note">${doubles.length} ${doubles.length === 1 ? 'person' : 'people'} voted online and then on paper: the paper ballot counts, so the online one is left out above.</p>` : ''}
    ${setAside.length ? `<div class="warn stack"><p><strong>Envelopes to set aside, unopened, before counting:</strong> ${setAside.length} ${setAside.length === 1 ? 'voter' : 'voters'} checked in on paper and then voted online, so the online vote counts instead.</p><ul>${setAside.map((d) => `<li>Check-in code <span class="code" data-set-aside>${esc(checkInCode(d.nullifier))}</span>${places[d.place] ? ` · ${esc(places[d.place])}` : ''}</li>`).join('')}</ul><p class="muted">This list is final when the poll closes. Clerks remove these envelopes, then open and count the rest.</p></div>` : ''}
    <p class="note">Each paper voter checks in anonymously with their voter key, so the paper register matches the voter list: a place's paper ballots can't exceed its check-ins, and nobody is counted twice. Counts are entered by one clerk and confirmed by another, with a photo of the tally sheet.</p>
    <details><summary>Places counted</summary><ul class="list">${await placesHtml(state.config, state.provider, k, contestId, labels, esc)}</ul></details>
    ${c.closed ? '<p class="muted">Final: no more changes.</p>' : ''}</div>`;
  wireAttachments(box, state.config);
  const b = box.querySelector('[data-checkin]');
  if (b) b.onclick = async () => {
    const el = box.querySelector('.checkin .status');
    const place = Number(box.querySelector('[data-place]').value);
    b.disabled = true;
    try {
      ctx.status(el, 'Proving privately that you are on the voter list…');
      const proof = await checkInProof({ provider: state.provider, identityAddress: state.config.identityAddress, voteAddress: state.config.voteAddress, identity: state.identity, pollId, place, artifactsBase: state.config.artifactsBase || undefined });
      ctx.status(el, 'Checking in…');
      const out = await ctx.relay('/checkin', { pollId: String(pollId), place, proof });
      ctx.status(el, isMail(box.querySelector(`[data-place] option[value="${place}"]`)?.textContent || '') ? 'Checked in for a mail ballot. Write this code on your return envelope (not on the ballot), then mail it.' : 'Checked in. Show this code to the clerk, then take your paper ballot.', 'ok');
      box.querySelector('[data-code]').innerHTML = `<p class="code big" aria-label="Check-in code">${esc(out.code || checkInCode(proof.nullifier))}</p>`;
      if (ctx.onCheckedIn) setTimeout(ctx.onCheckedIn, 1500); // show the poll as voted on paper (the code stays there)
    } catch (e) {
      let name = '';
      try {
        name = IFACE.parseError(e.data)?.name || '';
      } catch {
        /* not ours */
      }
      ctx.status(el, ERRORS[name] || ERRORS[e.message] || e.message, 'error');
      b.disabled = false;
    }
  };
}

/** Admin: places, check-ins, record, confirm, correct and close; returns { render, todos }. */
export function wireTallies(ctx) {
  const { state, $, status, esc } = ctx;
  let picker = null;
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
      const tx = await fn(contract(state.config, ctx.activeSigner()));
      status(el, `${label}: waiting for the network…`);
      const rc = await tx.wait();
      status(el, `${label}: done.`, 'ok');
      return rc;
    } catch (e) {
      let name = e.revert?.name;
      try {
        name ||= IFACE.parseError(e.data)?.name;
      } catch {
        /* not ours */
      }
      status(el, `${label} failed: ${ERRORS[name] || name || e.shortMessage || e.message}`, 'error');
      return null;
    }
  }

  async function isClerk() {
    const k = contract(state.config, state.provider);
    if (!k || !me()) return false;
    return k.hasRole(await k.CLERK_ROLE(), me()).catch(() => false);
  }

  async function render() {
    const card = $('admin-tallies');
    if (!card) return;
    const k = contract(state.config, state.provider);
    card.hidden = !(await isClerk());
    if (card.hidden) return;
    if (!picker) picker = attachPicker($('tally-sheet'), { state, esc });
    const n = Number(await k.contestCount());
    const opts = [];
    const queue = [];
    for (let id = n; id >= Math.max(1, n - 49); id--) {
      const c = await k.getContest(id);
      const d = await describe(state.config, state.provider, c);
      if (!c.closed) opts.push(`<option value="${id}" data-kind="${Number(c.kind)}" data-poll="${c.pollId}" data-options="${esc(JSON.stringify(d.options))}">${esc(`${KIND[Number(c.kind)]}: ${d.title}`)}</option>`);
      const places = await k.placesOf(id);
      for (const t of await k.talliesOf(id)) {
        const x = await k.getTally(t);
        if (x.confirmedBy === ethers.ZeroAddress && !Number(x.replacedBy) && !c.closed && x.recordedBy.toLowerCase() !== me().toLowerCase()) {
          queue.push(`<li id="confirm-tally-${t}"><p><strong>${esc(d.title)}</strong> · ${esc(places[Number(x.place)] || '')}</p><p>${d.options.map((o, i) => `${esc(o)} ${num(x.counts[i])}`).join(' · ')} · ${num(x.ballots)} ballots · recorded by ${esc(short(x.recordedBy))}</p>
            ${x.ref ? attachmentsHtml(state.config, await readDoc(state.config, state.provider, x.ref).catch(() => ({})), esc) : ''}
            <div class="row"><button class="primary" data-confirm="${t}">Confirm: matches the sheet</button></div><p class="status" role="status"></p></li>`);
        }
      }
    }
    const keep = $('tally-contest').value;
    $('tally-contest').innerHTML = opts.join('') || '<option value="">No open contests yet: set one up above</option>';
    if (keep && [...$('tally-contest').options].some((o) => o.value === keep)) $('tally-contest').value = keep;
    $('tally-queue').innerHTML = queue.length ? `<ul class="list">${queue.join('')}</ul>` : '<p class="muted">Nothing to confirm.</p>';
    wireAttachments($('tally-queue'), state.config);
    for (const b of $('tally-queue').querySelectorAll('[data-confirm]')) b.onclick = async () => {
      const el = b.closest('li').querySelector('.status');
      if (await send(el, 'Confirm tally', (c) => c.confirm(Number(b.dataset.confirm)))) render();
    };
    await drawContest();
  }

  /** The chosen contest: its places, check-ins (with codes) and the count fields. */
  async function drawContest() {
    const sel = $('tally-contest').selectedOptions[0];
    const options = sel ? JSON.parse(sel.dataset.options || '[]') : [];
    $('tally-counts').innerHTML = options.map((o, i) => `<label>${esc(o)} <input type="text" inputmode="numeric" data-count="${i}" style="width:110px" /></label>`).join('');
    const k = contract(state.config, state.provider);
    const id = Number(sel?.value || 0);
    if (!id) return ($('tally-place').innerHTML = '');
    const places = await k.placesOf(id);
    $('tally-place').innerHTML = places.map((p, i) => `<option value="${i}">${esc(p)}</option>`).join('') || '<option value="">Add a place first</option>';
    const isPoll = sel.dataset.kind === '1';
    let info = '';
    if (isPoll && places.length) {
      const counts = await Promise.all(places.map((_, i) => k.checkIns(id, i)));
      const head = await state.provider.getBlockNumber();
      const logs = await k.queryFilter(k.filters.CheckedIn(BigInt(sel.dataset.poll)), Math.max(0, head - 9000), head).catch(() => []);
      const codes = places.map((_, i) => logs.filter((l) => Number(l.args.place) === i).slice(-12).map((l) => checkInCode(l.args.nullifier)));
      info = `<p class="note">Voters check in on their phones before getting a paper ballot; match the code on their screen. Paper ballots at a place cannot exceed its check-ins.</p><ul class="list">${places.map((p, i) => `<li><strong>${esc(p)}</strong>: ${num(counts[i])} checked in${codes[i].length ? ` · latest codes: ${codes[i].map((c) => `<span class="code">${c}</span>`).join(' ')}` : ''}</li>`).join('')}</ul>`;
    }
    $('tally-checkins').innerHTML = info;
  }

  if ($('btn-tally-contest')) {
    $('tally-kind').onchange = () => {
      const poll = $('tally-kind').value === 'poll';
      $('tally-poll-row').hidden = !poll;
      $('tally-new-row').hidden = poll;
    };
    $('tally-contest').onchange = () => drawContest().catch(() => {});
    $('btn-tally-contest').onclick = async () => {
      const el = $('tally-contest-status');
      const kind = $('tally-kind').value;
      if (kind === 'poll') {
        const pollId = Number($('tally-poll').value);
        if (!(pollId >= 1)) return status(el, 'Enter the poll number.', 'error');
        const p = await state.vote.getPoll(pollId).catch(() => null);
        if (!p) return status(el, 'No such poll.', 'error');
        if (await send(el, 'Set up paper voting', (c) => c.contestForPoll(pollId, Number(p.options)))) render();
        return;
      }
      const title = $('tally-title').value.trim();
      const options = $('tally-options').value.split('\n').map((x) => x.trim()).filter(Boolean);
      if (!title || options.length < 2) return status(el, 'Name the contest and list at least two options, one per line.', 'error');
      status(el, 'Publishing the contest…');
      const ref = await postDoc(state.config, ctx.activeSigner(), { title, body: $('tally-details').value.trim(), options }).catch((e) => status(el, e.message, 'error'));
      if (ref && (await send(el, 'Create contest', (c) => c.createContest(kind === 'election' ? 2 : 3, ref, options.length)))) {
        $('tally-title').value = '';
        $('tally-options').value = '';
        render();
      }
    };
    $('btn-tally-place').onclick = async () => {
      const el = $('tally-status');
      const id = Number($('tally-contest').value);
      let name = $('tally-new-place').value.trim();
      if (!id || !name) return status(el, 'Choose a contest and name the polling place, precinct or meeting.', 'error');
      if ($('tally-mail')?.checked && !isMail(name)) name = `${MAIL} ${name}`;
      if (await send(el, 'Add place', (c) => c.addPlace(id, name))) {
        $('tally-new-place').value = '';
        if ($('tally-mail')) $('tally-mail').checked = false;
        drawContest();
      }
    };
    $('btn-tally-record').onclick = async () => {
      const el = $('tally-status');
      const contestId = Number($('tally-contest').value);
      if (!contestId || $('tally-place').value === '') return status(el, 'Choose a contest and a place first.', 'error');
      const counts = [...$('tally-counts').querySelectorAll('[data-count]')].map((i) => Number(i.value));
      const ballots = Number($('tally-ballots').value);
      if (counts.some((x) => !Number.isInteger(x) || x < 0) || !Number.isInteger(ballots) || ballots < 0) return status(el, 'Fill in every count and the ballots cast (whole numbers).', 'error');
      if (counts.reduce((a, b) => a + b, 0) > ballots) return status(el, 'The counts add up to more than the ballots cast.', 'error');
      let files;
      try {
        files = picker ? picker.list() : [];
      } catch (e) {
        return status(el, e.message, 'error');
      }
      const note = $('tally-note').value.trim();
      let ref = '';
      if (files.length || note) {
        status(el, 'Publishing the tally sheet…');
        ref = await postDoc(state.config, ctx.activeSigner(), { title: `Tally sheet: ${$('tally-place').selectedOptions[0].textContent}`, body: note, ...(files.length ? { attachments: files } : {}) }).catch((e) => (status(el, e.message, 'error'), null));
        if (ref === null) return;
      }
      const replaces = Number($('tally-replaces').value || 0);
      const entry = { place: Number($('tally-place').value), counts, ballots, ref, replaces, reason: $('tally-reason').value.trim() };
      if (await send(el, replaces ? 'Record correction' : 'Record tally', (c) => c.record(contestId, entry))) {
        status(el, 'Recorded. Another clerk must confirm it before it counts.', 'ok');
        for (const id of ['tally-ballots', 'tally-note', 'tally-replaces', 'tally-reason']) $(id).value = '';
        picker?.clear();
        render();
      }
    };
  }

  async function todos() {
    const k = contract(state.config, state.provider);
    if (!k || !(await isClerk())) return [];
    const out = [];
    const n = Number(await k.contestCount());
    for (let id = n; id >= Math.max(1, n - 49); id--) {
      const c = await k.getContest(id);
      if (c.closed) continue;
      const places = await k.placesOf(id);
      for (const t of await k.talliesOf(id)) {
        const x = await k.getTally(t);
        if (x.confirmedBy === ethers.ZeroAddress && !Number(x.replacedBy) && x.recordedBy.toLowerCase() !== me().toLowerCase()) {
          out.push({ action: 'Confirm tally', text: `${esc(places[Number(x.place)] || '')}, recorded by ${esc(short(x.recordedBy))}`, target: `confirm-tally-${t}`, urgent: true });
        }
      }
    }
    return out;
  }

  return { render: () => render().catch(() => {}), todos: () => todos().catch(() => []), isClerk };
}

/** Dashboard: official election and meeting results, with each place counted. */
export async function talliesDashboard(cfg, provider, esc) {
  const k = contract(cfg, provider);
  if (!k) return '<p class="muted">Not set up on this deployment.</p>';
  const n = Number(await k.contestCount());
  const cards = [];
  for (let id = n; id >= Math.max(1, n - 19); id--) {
    const c = await k.getContest(id);
    if (Number(c.kind) === 1) continue; // polls show theirs on the poll
    const d = await describe(cfg, provider, c);
    const [counts, ballots, places, unconfirmed] = await k.totals(id);
    const max = counts.reduce((m, v) => (v > m ? v : m), 0n) || 1n;
    const rows = d.options.map((o, i) => `<span>${esc(o)}</span><span class="track"><span class="fill" style="display:block;width:${Math.round((Number(counts[i]) / Number(max)) * 100)}%"></span></span><span class="v">${num(counts[i])}</span>`).join('');
    cards.push(`<div class="card stack"><p class="eyebrow">${esc(KIND[Number(c.kind)])}${c.closed ? ' · final' : ''} · ${num(places)} place${Number(places) === 1 ? '' : 's'} confirmed${Number(unconfirmed) ? ` · ${num(unconfirmed)} awaiting confirmation` : ''} · ${num(ballots)} ballots</p>
      <h3>${esc(d.title)}</h3>${d.body ? `<p class="muted">${esc(d.body)}</p>` : ''}<div class="tally">${rows}</div>
      <details><summary>Each place counted</summary><ul class="list">${await placesHtml(cfg, provider, k, id, d.options, esc)}</ul></details></div>`);
  }
  return cards.join('') || '<p class="muted">No paper or meeting results recorded yet.</p>';
}
