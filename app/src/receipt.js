/**
 * app/src/receipt.js - "Check my vote": find your own ballot in the public count.
 *
 * Every online ballot is published with its one-time code (nullifier). Your phone recomputes
 * your code for a poll from your voter key, so it can find your ballot on any device where
 * you unlocked your key; nobody else can link that code to you. A receipt ("12:<code>") lets
 * anyone confirm a ballot was counted, through Search, without learning who cast it.
 */

import { ethers } from 'ethers';

const VOTE = [
  'event BallotCast(uint256 indexed id, uint256 option, uint256 nullifier)',
  'function nullifierUsed(uint256, uint256) view returns (bool)',
  'function getPoll(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 quorum, uint8 options, uint8 action, bool finalized, bool passed, address proposer, uint256 bond, string questionCID, bytes actionData))',
];
const DELEGATE_BASE = 1_000_000;
export const receiptCode = (pollId, nullifier) => `${pollId}:${nullifier}`;
export const parseReceipt = (s) => {
  const m = /^\s*(\d+)\s*:\s*(\d{20,})\s*$/.exec(String(s || ''));
  return m ? { pollId: Number(m[1]), nullifier: m[2] } : null;
};

/** The ballot with this one-time code in this poll: { option, txHash, block, at } or null. */
export async function findBallot(state, pollId, nullifier) {
  const vote = new ethers.Contract(state.config.voteAddress, VOTE, state.provider);
  if (!(await vote.nullifierUsed(pollId, nullifier))) return null;
  const poll = await vote.getPoll(pollId);
  const head = await state.provider.getBlock('latest');
  // Search the blocks since the poll opened (about 2 seconds per block on Base), newest first.
  const start = Math.max(0, head.number - Math.ceil((head.timestamp - Number(poll.start)) / 2) - 2000);
  for (let to = head.number; to >= start; to -= 9000) {
    const from = Math.max(start, to - 8999);
    const logs = await vote.queryFilter(vote.filters.BallotCast(pollId), from, to).catch(() => []);
    const hit = logs.findLast((l) => String(l.args.nullifier) === String(nullifier)); // the latest, if the vote was changed
    if (hit) return { option: Number(hit.args.option), txHash: hit.transactionHash, block: hit.blockNumber, at: (await hit.getBlock()).timestamp };
  }
  return { option: null, txHash: null, block: null }; // counted, but the record was not found in range
}

/** What happened to this ballot, in plain words (HTML). */
export async function receiptHtml(state, esc, pollId, nullifier, labels = ['Yes', 'No']) {
  const b = await findBallot(state, pollId, nullifier);
  if (!b) return '<p class="warn">No ballot with this code in this poll.</p>';
  const explorer = state.config.explorer && b.txHash ? ` <a href="${esc(`${state.config.explorer.replace(/\/+$/, '')}/tx/${b.txHash}`)}" target="_blank" rel="noopener">See it on the blockchain</a>` : '';
  let choice = b.option === null ? 'recorded' : labels[b.option] ? `<strong>${esc(labels[b.option])}</strong>` : '';
  if (b.option !== null && b.option >= DELEGATE_BASE) {
    let who = `delegate ${b.option - DELEGATE_BASE}`;
    if (state.config.officialsAddress) {
      const o = await new ethers.Contract(state.config.officialsAddress, ['function getOfficial(uint256) view returns (tuple(address account, string name, string office, string jurisdiction, uint64 termEnd, bool official, bool delegate, bool active, string statementRef))'], state.provider).getOfficial(b.option - DELEGATE_BASE).catch(() => null);
      if (o) who = o.name;
    }
    choice = `handed to <strong>${esc(who)}</strong> (it counts the way they state before the poll closes)`;
  }
  let paper = '';
  if (state.config.talliesAddress) {
    const t = new ethers.Contract(state.config.talliesAddress, ['function checkedInAt(uint256, uint256) view returns (uint32)'], state.provider);
    if (Number(await t.checkedInAt(pollId, nullifier).catch(() => 0n))) paper = '<p class="note">This voter also checked in to vote on paper: the paper ballot is the one that counts, so this online ballot is left out of the combined count.</p>';
  }
  return `<p class="ok">✓ Counted: this ballot (${choice}) is in the public count${b.at ? `, cast ${new Date(b.at * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : ''}.${explorer}</p>${paper}`;
}
