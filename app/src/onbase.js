/**
 * app/src/onbase.js - "📜 On Base": where a published item is recorded on the Base blockchain.
 * Every proposal, petition, poll question, statement and comment is stored on Promissa's notice
 * board contract, with the fingerprints (SHA-256) and addresses of its photos, documents, audio
 * and videos, so they can be checked against the record. This shows when it was published, by
 * which account, the block, and a link to the transaction on the block explorer.
 */

import { ethers } from 'ethers';

const ABI = [
  'function postedAt(bytes32) view returns (uint64)',
  'function postedBlock(bytes32) view returns (uint64)',
  'function author(bytes32) view returns (address)',
  'event Posted(bytes32 indexed id, address indexed author, uint256 length)',
];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ID = /^nb:(0x[0-9a-fA-F]{64})$/;

/** The "📜 On Base" button for a notice-board reference (nothing for other kinds of reference). */
export const onBaseButton = (ref) => (ID.test(String(ref)) ? `<button type="button" class="link" data-onbase="${esc(ref)}">📜 On Base</button><span data-onbase-out></span>` : '');

/** The block a timestamp falls in (older notice boards don't store the block): a binary search. */
export async function blockAt(provider, ts) {
  let lo = 0;
  let hi = await provider.getBlockNumber();
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await provider.getBlock(mid);
    if (Number(b.timestamp) < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Where `ref` is recorded: { at, block, author, tx } or null. */
export async function locate(cfg, provider, ref) {
  const id = String(ref).match(ID)?.[1];
  if (!id || !cfg.noticeBoardAddress) return null;
  const nb = new ethers.Contract(cfg.noticeBoardAddress, ABI, provider);
  const [at, author] = await Promise.all([nb.postedAt(id), nb.author(id)]);
  if (!Number(at)) return null;
  let block = Number(await nb.postedBlock(id).catch(() => 0n));
  if (!block) block = await blockAt(provider, Number(at));
  const logs = await provider.getLogs({ address: cfg.noticeBoardAddress, topics: [nb.interface.getEvent('Posted').topicHash, id], fromBlock: block, toBlock: block }).catch(() => []);
  return { at: Number(at), block, author, tx: logs[0]?.transactionHash || null };
}

/** Wire every "On Base" button on the page, now and later. */
export function wireOnBase(getState) {
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-onbase]');
    if (!b) return;
    const out = b.nextElementSibling;
    const { config: cfg, provider } = getState();
    out.textContent = ' Looking it up on Base…';
    try {
      const r = await locate(cfg, provider, b.dataset.onbase);
      if (!r) return void (out.textContent = ' Not found on the notice board.');
      const ex = (cfg.explorer || '').replace(/\/+$/, '');
      out.innerHTML = ` <span class="note">Published on Base ${esc(new Date(r.at * 1000).toLocaleString())}, block ${r.block}, by <span class="code">${esc(`${r.author.slice(0, 6)}…${r.author.slice(-4)}`)}</span>${r.tx && ex ? ` · <a href="${esc(`${ex}/tx/${r.tx}`)}" target="_blank" rel="noopener">View the transaction</a>` : ex ? ` · <a href="${esc(`${ex}/block/${r.block}`)}" target="_blank" rel="noopener">View the block</a>` : ''}. This record holds its text and the fingerprints and addresses of its files and videos; it can never be edited.</span>`;
    } catch {
      out.textContent = ' Could not reach Base right now.';
    }
  });
}
