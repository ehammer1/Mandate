/**
 * app/src/notice.js - a printable notice for libraries, city hall and community boards:
 * what is open for a vote now, when it closes, and a QR code to the app.
 */
import { ethers } from 'ethers';
import QRCode from 'qrcode';
import { readDoc } from './notices.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (secs) => new Date(Number(secs) * 1000).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });

(async () => {
  const cfg = await (await fetch(`config.json?t=${Date.now()}`, { cache: 'no-store' })).json();
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, undefined, { staticNetwork: true });
  const appUrl = new URL('./', location.href).toString();
  $('address').textContent = appUrl;
  await QRCode.toCanvas($('qr'), appUrl, { width: 150, margin: 1 });
  $('when').textContent = `Printed ${new Date().toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })}. Check the app for the latest.`;
  const now = (await provider.getBlock('latest')).timestamp;
  const items = [];
  const vote = new ethers.Contract(cfg.voteAddress, ['function pollCount() view returns (uint256)', 'function getPoll(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 quorum, uint8 options, uint8 action, bool finalized, bool passed, address proposer, uint256 bond, string questionCID, bytes actionData))'], provider);
  const n = Number(await vote.pollCount());
  for (let id = n; id >= Math.max(1, n - 20); id--) {
    const p = await vote.getPoll(id);
    if (p.finalized || Number(p.end) <= now) continue;
    const d = await readDoc(cfg, provider, p.questionCID);
    items.push(`<div class="item"><p class="eyebrow">Poll ${id} · closes ${esc(when(p.end))}${Number(p.action) ? ' · binding' : ''}</p><h2>${esc(d.title)}</h2>${d.body ? `<p>${esc(d.body)}</p>` : ''}</div>`);
  }
  if (cfg.budgetAddress) {
    const b = new ethers.Contract(cfg.budgetAddress, ['function roundCount() view returns (uint256)', 'function getRound(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 credits, uint256 budget, string ref, bool finalized, uint256 participants, uint256 spent, uint256 fundedMask))', 'function getProposals(uint256) view returns (string[] refs, uint256[] costs, uint256[] votes)'], provider);
    const m = Number(await b.roundCount());
    for (let id = m; id >= Math.max(1, m - 5); id--) {
      const r = await b.getRound(id);
      if (r.finalized || Number(r.end) <= now) continue;
      const [refs] = await b.getProposals(id);
      const d = await readDoc(cfg, provider, r.ref);
      items.push(`<div class="item"><p class="eyebrow">Budget round · closes ${esc(when(r.end))}</p><h2>${esc(d.title)}</h2><p>Spend your ${r.credits} civic credits on: ${esc(refs.slice(0, 8).join(' · '))}</p></div>`);
    }
  }
  $('items').innerHTML = items.join('') || '<p>Nothing is open for a vote right now. Check back soon.</p>';
})().catch((e) => ($('items').innerHTML = `<p>Could not load: ${esc(e.message)}</p>`));
