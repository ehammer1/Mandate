/**
 * app/src/pollsettings.js - each poll's own settings (voting contract v5), on the poll card and
 * in "Open a poll":
 *   - changing a vote: until the close, until a cutoff before it, or never (first vote final)
 *   - how people vote: online and on paper, online only, or on paper only
 *   - ranked choice: voters rank the choices; the result is an instant runoff anyone can redo
 *     from the public counts
 *   - who can vote: the main voter lists, or a smaller list (a district, a ward, a union local)
 * and the Admin card where clerks manage those smaller lists.
 */

import { ethers } from 'ethers';
import { Group } from '@semaphore-protocol/group';
import { encodeRanking, instantRunoff } from '../../client/ballot.js';
import { countdown } from './time.js';

export const V5_ABI = [
  'function settingsOf(uint256) view returns (uint32 changeCutoff, uint8 channels, bool ranked)',
  'function rankings(uint256) view returns (uint256[] codes, uint256[] counts)',
  'function voterGroups() view returns (address)',
  'function NO_CHANGES() view returns (uint32)',
  'function createPollWith(tuple(uint256 groupId, uint64 duration, uint32 quorum, uint8 options, uint8 action, bytes actionData, string questionCID, uint256 bond, tuple(uint32 changeCutoff, uint8 channels, bool ranked) settings) n) returns (uint256)',
  'error ChangesClosed()',
  'error OnlineClosed()',
  'error BadRanking()',
];
export const GROUPS_ABI = [
  'function GROUP_CREATOR_ROLE() view returns (bytes32)',
  'function hasRole(bytes32, address) view returns (bool)',
  'function groupIds() view returns (uint256[])',
  'function getGroup(uint256) view returns (tuple(string name, address manager, uint8 baseTier, uint64 createdAt) g, uint256 size)',
  'function isMember(uint256, uint256) view returns (bool)',
  'function isGroup(uint256) view returns (bool)',
  'function leaves(uint256, uint256, uint256) view returns (uint256[] commitments, uint64[] removedAt)',
  'function createGroup(string name, uint8 baseTier, address manager) returns (uint256)',
  'function addMembers(uint256 groupId, uint256[] commitments)',
  'function removeMember(uint256 groupId, uint256 commitment, uint256[] siblings)',
  'event GroupCreated(uint256 indexed groupId, string name, address manager, uint8 baseTier)',
  'error NotManager()', 'error UnknownGroup()', 'error BadInput()', 'error NotOnVoterList(uint256 commitment)', 'error AlreadyMember(uint256 commitment)', 'error NotMember()',
];
const NO_CHANGES = 2 ** 32 - 1;
export const DEFAULTS = { changeCutoff: 0, channels: 0, ranked: false };
export const ERRORS = {
  ChangesClosed: 'Votes can no longer be changed in this poll (its rules fix them before the close).',
  OnlineClosed: 'This poll is on paper only: check in and vote at a polling place.',
  BadRanking: 'Rank each choice at most once, starting with your first choice.',
};
const TIERS = ['basic members', 'verified residents', 'residents with full voting rights'];
const short = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;

const vote5 = (state) => new ethers.Contract(state.config.voteAddress, V5_ABI, state.provider);
const groupsContract = async (state, runner) => {
  if (state.voterGroupsAddress === undefined) {
    state.voterGroupsAddress = state.config.voterGroupsAddress || (await vote5(state).voterGroups().catch(() => ethers.ZeroAddress));
  }
  return state.voterGroupsAddress && state.voterGroupsAddress !== ethers.ZeroAddress ? new ethers.Contract(state.voterGroupsAddress, GROUPS_ABI, runner || state.provider) : null;
};

/** Does the voting contract support settings (v5)? Cached. */
export async function hasSettings(state) {
  if (state.voteV5 === undefined) state.voteV5 = await vote5(state).settingsOf(0).then(() => true, () => false);
  return state.voteV5;
}

export async function readSettings(state, id) {
  if (!(await hasSettings(state))) return DEFAULTS;
  const s = await vote5(state).settingsOf(id).catch(() => null);
  return s ? { changeCutoff: Number(s.changeCutoff), channels: Number(s.channels), ranked: s.ranked } : DEFAULTS;
}

/** Can a cast vote still be changed now? */
export const changesOpen = (st, poll, now) => st.changeCutoff !== NO_CHANGES && Number(now) + st.changeCutoff < Number(poll.end);

/** One line on the poll card saying how this poll runs (empty for the usual settings). */
export function settingsNote(st, poll, now, esc) {
  const bits = [];
  if (st.ranked) bits.push('<strong>Ranked choice:</strong> rank the choices in order; counted by instant runoff');
  if (st.channels === 1) bits.push('Online only');
  if (st.channels === 2) bits.push('<strong>On paper only:</strong> check in and vote at a polling place');
  if (st.changeCutoff === NO_CHANGES) bits.push('Your first vote is final: it cannot be changed');
  else if (st.changeCutoff > 0) {
    const until = Number(poll.end) - st.changeCutoff;
    bits.push(until > Number(now) ? `Votes can be changed until ${esc(new Date(until * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))} (${countdown(until)})` : 'Votes can no longer be changed');
  }
  return bits.length ? `<p class="note">${bits.join(' · ')}</p>` : '';
}

// ------------------------------------------------------------------ ranked choice

/** The ranking picker: tap choices in order of preference, then send. */
export function rankedPickerHtml(id, labels, esc) {
  return `<div class="ranker stack" data-poll="${id}">
    <p class="note">Tap the choices in order: your favourite first. You don't have to rank them all.</p>
    <div class="choices">${labels.map((l, i) => `<button type="button" class="rank-opt" data-option="${i}">${esc(l)}</button>`).join('')}</div>
    <ol class="ranking" aria-live="polite"></ol>
    <div class="row"><button type="button" class="primary choice" data-ranked disabled>Send my ranking</button> <button type="button" data-rank-reset>Start over</button></div>
  </div>`;
}

/** Wire every ranking picker under `root`; `cast(pollId, message, button)` sends the ballot. */
export function wireRankers(root, labels, cast, esc) {
  for (const box of root.querySelectorAll('.ranker')) {
    const order = [];
    const list = box.querySelector('.ranking');
    const send = box.querySelector('[data-ranked]');
    const draw = () => {
      list.innerHTML = order.map((o) => `<li>${esc(labels(box.dataset.poll)[o])}</li>`).join('');
      for (const b of box.querySelectorAll('.rank-opt')) {
        const at = order.indexOf(Number(b.dataset.option));
        b.disabled = at !== -1;
        b.dataset.rank = at === -1 ? '' : String(at + 1);
      }
      send.disabled = !order.length;
    };
    for (const b of box.querySelectorAll('.rank-opt')) b.onclick = () => (order.push(Number(b.dataset.option)), draw());
    box.querySelector('[data-rank-reset]').onclick = () => (order.splice(0), draw());
    send.onclick = () => cast(BigInt(box.dataset.poll), encodeRanking(order), send);
    draw();
  }
}

/** Results of a ranked poll: first choices, then each runoff round, and the winner. */
export async function rankedResultsHtml(state, id, labels, esc) {
  const [codes, counts] = await vote5(state).rankings(id);
  const r = instantRunoff(labels.length, codes, counts);
  if (!r.rounds.length || !r.rounds[0].counts.some((x) => x)) return '<p class="muted">No rankings yet.</p>';
  const rounds = r.rounds.map((x, i) => `<li><strong>Round ${i + 1}:</strong> ${labels.map((l, j) => `${esc(l)} ${x.counts[j]}`).join(' · ')}${x.exhausted ? ` · ${x.exhausted} with no choice left` : ''}${x.eliminated !== null ? ` → <em>${esc(labels[x.eliminated])}</em> has the fewest and drops out; its ballots move to their next choice` : ''}</li>`).join('');
  return `<p><strong>${r.winner === null ? 'No winner yet' : `Leading: ${esc(labels[r.winner])}`}</strong> (instant runoff, from the public counts)</p><ol class="list">${rounds}</ol>`;
}

// ------------------------------------------------------------------ smaller voter lists

/** A poll limited to a smaller list: its name, and whether this voter is on it. */
export async function groupInfo(state, groupId, commitment) {
  const g = await groupsContract(state);
  if (!g) return null;
  const [[info], member] = await Promise.all([g.getGroup(groupId).catch(() => [null]), commitment ? g.isMember(groupId, commitment).catch(() => false) : false]);
  return info ? { name: info.name, member } : null;
}

/** <option>s for "Who can vote": the smaller lists, after the main ones. */
export async function groupOptionsHtml(state, esc) {
  const g = await groupsContract(state);
  if (!g) return '';
  const ids = await g.groupIds().catch(() => []);
  const rows = await Promise.all(ids.map(async (id) => [id, await g.getGroup(id).catch(() => null)]));
  const opts = rows.filter(([, r]) => r).map(([id, [info, size]]) => `<option value="g:${id}">${esc(info.name)} (${Number(size)} voters, advisory only)</option>`);
  return opts.length ? `<optgroup label="Smaller lists (districts, wards…)">${opts.join('')}</optgroup>` : '';
}

/** Admin card: create smaller lists (council-approved creators) and manage their members (managers). */
export function wireVoterGroups(ctx) {
  const { state, $, status, esc } = ctx;
  async function render() {
    const box = $('admin-groups');
    const g = await groupsContract(state);
    if (!g || !box) return box && (box.hidden = true);
    const me = ctx.activeAddress();
    const creator = me ? await g.hasRole(await g.GROUP_CREATOR_ROLE(), me).catch(() => false) : false;
    const ids = await g.groupIds().catch(() => []);
    const rows = (await Promise.all(ids.map(async (id) => [id, await g.getGroup(id).catch(() => null)]))).filter(([, r]) => r);
    const mine = rows.filter(([, [info]]) => me && info.manager.toLowerCase() === me.toLowerCase());
    box.hidden = !creator && !mine.length;
    if (box.hidden) return;
    box.innerHTML = `<h3>Smaller voter lists</h3>
      <p class="note">For polls only some people decide: a district or ward, a union local, a school's parents. Everyone on one must already be on the main voter list, so nobody can be added who isn't, and each person still votes once. Polls for a smaller list are advisory.</p>
      ${creator ? `<details><summary><strong>Create a list</strong></summary><div class="stack">
        <label>Name <input type="text" data-f="g-name" maxlength="80" placeholder="e.g. Ward 3" /></label>
        <label>Members must be <select data-f="g-tier"><option value="1">ID-checked residents (or higher)</option><option value="2">Residents with full voting rights</option><option value="0">Any member (or higher)</option></select></label>
        <label>Manager (who adds and removes members; account address 0x…) <input type="text" data-f="g-manager" value="${esc(me || '')}" /></label>
        <button type="button" class="primary" data-g-create>Create list</button></div></details>` : ''}
      ${mine.map(([id, [info, size]]) => `<div class="card stack" data-group="${id}"><p><strong>${esc(info.name)}</strong> · ${Number(size)} added · members must be ${TIERS[Number(info.baseTier)]} or higher</p>
        <label>Add voters by their voter codes (one per line; each person finds theirs under "My voter code")<textarea data-f="g-codes" rows="3"></textarea></label>
        <button type="button" data-g-add>Add to the list</button>
        <label>Remove a voter (their voter code) <input type="text" data-f="g-remove" inputmode="numeric" /></label>
        <button type="button" data-g-remove>Remove from the list</button>
        <p class="muted">Removing someone from the main voter list does not remove them here: remove them here too.</p></div>`).join('')}
      <p class="status" role="status" data-g-status></p>`;
    const el = box.querySelector('[data-g-status]');
    const send = async (label, fn) => {
      status(el, `${label}: confirm…`);
      try {
        await (await fn(await groupsContract(state, ctx.activeSigner()))).wait();
        status(el, `${label}: done.`, 'ok');
        await render();
      } catch (e) {
        let name = e.revert?.name;
        try {
          name ||= new ethers.Interface(GROUPS_ABI.filter((x) => x.startsWith('error'))).parseError(e.data)?.name;
        } catch {
          /* not ours */
        }
        const why = { NotOnVoterList: 'That voter code is not on the main voter list at the level this list requires.', AlreadyMember: 'That voter is already on this list.', NotManager: 'Only this list\'s manager can change it.', NotMember: 'That voter code is not on this list.', BadInput: 'Check the name, the level and the manager address.' }[name];
        status(el, `${label} failed: ${why || name || e.shortMessage || e.message}`, 'error');
      }
    };
    const f = (root, k) => root.querySelector(`[data-f="${k}"]`)?.value.trim() || '';
    box.querySelector('[data-g-create]')?.addEventListener('click', () => {
      const name = f(box, 'g-name');
      const manager = f(box, 'g-manager');
      if (!name || !ethers.isAddress(manager)) return status(el, 'Give the list a name and a valid manager address.', 'error');
      send('Create list', (k) => k.createGroup(name, Number(f(box, 'g-tier')), ethers.getAddress(manager)));
    });
    for (const card of box.querySelectorAll('[data-group]')) {
      const id = BigInt(card.dataset.group);
      card.querySelector('[data-g-add]').onclick = () => {
        const codes = f(card, 'g-codes').split(/[\s,]+/).filter(Boolean);
        if (!codes.length || codes.some((x) => !/^\d{10,}$/.test(x))) return status(el, 'Paste voter codes (long numbers), one per line.', 'error');
        send(`Add ${codes.length} voter${codes.length === 1 ? '' : 's'}`, (k) => k.addMembers(id, codes.map(BigInt)));
      };
      card.querySelector('[data-g-remove]').onclick = async () => {
        const code = f(card, 'g-remove');
        if (!/^\d{10,}$/.test(code)) return status(el, 'Enter the voter code to remove.', 'error');
        const k = await groupsContract(state);
        const [leaves, removedAt] = await k.leaves(id, 0, 100_000);
        const grp = new Group(leaves);
        removedAt.forEach((r, j) => Number(r) && grp.removeMember(j)); // the list as it is now
        const i = leaves.findIndex((x) => String(x) === code);
        if (i === -1 || Number(removedAt[i])) return status(el, 'That voter code is not on this list.', 'error');
        send('Remove voter', (c) => c.removeMember(id, BigInt(code), grp.generateMerkleProof(i).siblings));
      };
    }
  }
  return { render: () => render().catch(() => {}), short };
}
