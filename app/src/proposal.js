/**
 * app/src/proposal.js - one council proposal, in full, on its own page (proposal.html?id=9):
 * what it changes in plain words, every value it sets, the reason given, who has approved,
 * and what happens next. Read-only and public, so it can be shared before anyone decides.
 */
import { startI18n, langSwitchHtml, wireLangSwitch } from './i18n.js';
import { ethers } from 'ethers';
import { COUNCIL_ABI, readProposal, describeCall, callDetails, shortenAddresses, proposalUrl } from './council.js';
import { readDoc } from './notices.js';
import { copyBtn, wireCopy } from './copy.js';
import { countdown, startTicker } from './time.js';

startI18n();
if (typeof document !== 'undefined' && document.getElementById('lang-switch')) document.getElementById('lang-switch').innerHTML = langSwitchHtml();
wireLangSwitch(document);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (t) => new Date(Number(t) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const STATES = ['', 'Collecting approvals', 'Waiting period', 'Ready to run', 'Done', 'Rejected (cancelled)', 'Expired'];
const GRACE = 14 * 86_400;
const NEXT = [
  '',
  'Council members decide: each can approve, or reject it. Once enough approve, a public waiting period starts so anyone can object before it runs.',
  'Enough members approved. It can run when the waiting period ends; until then any member can still reject it, and members can undo their approval.',
  'The waiting period is over. Anyone can run it now from the Admin screen; any member can still reject it until it runs.',
  'It has run: the change is in effect.',
  'A member rejected it, so it can never run. A member can propose the same change again.',
  'Nobody ran it within 14 days of it becoming ready, so it lapsed. A member can propose it again.',
];

(async () => {
  const q = new URLSearchParams(location.search);
  const prefix = q.get('c') === 'prevcouncil' ? 'prevcouncil' : 'council';
  const id = Number(q.get('id') || /\d+/.exec(location.hash)?.[0]);
  const cfg = await (await fetch(`config.json?t=${Date.now()}`, { cache: 'no-store' })).json();
  const address = prefix === 'council' ? cfg.councilAddress : cfg.previousCouncilAddress;
  if (!address || !id) throw new Error('This link does not name a council change.');
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, undefined, { staticNetwork: true });
  const c = new ethers.Contract(address, COUNCIL_ABI, provider);
  const [count, members, threshold, delay] = await Promise.all([c.proposalCount(), c.members(), c.effectiveThreshold(), c.delay()]);
  if (id > Number(count)) throw new Error(`There is no council change #${id} yet.`);
  const [p, s, approvals] = await readProposal(c, id);
  const st = Number(s);
  const approvedBy = await Promise.all(members.map((m) => c.hasApproved(id, m).catch(() => false)));
  const d = callDetails(cfg, p.target, p.data);
  let reason = p.description ? `<p>${shortenAddresses(esc(p.description))}</p>` : '<p class="muted">No reason was given.</p>';
  if (/^nb:0x[0-9a-f]{64}$/i.test(p.description)) {
    const doc = await readDoc(cfg, provider, p.description).catch(() => null);
    if (doc && !doc.missing) reason = `<p><strong>${esc(doc.title)}</strong></p>${doc.body ? `<p style="white-space:pre-wrap">${esc(doc.body)}</p>` : ''}`;
  }
  const name = prefix === 'council' ? 'Council' : 'Previous council';
  const explorer = cfg.explorer?.replace(/\/+$/, '');
  const addrHtml = (a) => `<span class="code">${esc(a)}</span> ${copyBtn(a)}${explorer ? ` <a href="${esc(`${explorer}/address/${a}`)}" target="_blank" rel="noopener">view</a>` : ''}`;
  const approvedAt = Number(p.readyAt) ? Number(p.readyAt) - (p.fast ? 0 : Number(delay)) : 0;
  document.title = `${name} change #${id} · Promissa`;
  $('proposal').innerHTML = `<div class="card stack" id="${prefix}-${id}">
    <p class="eyebrow">${esc(name)} change #${id} · ${esc(STATES[st] || '')}${st >= 1 && st <= 3 ? ` · ${approvals} of ${threshold} approvals` : ''}</p>
    <h1 style="font-size:1.4rem">${esc(describeCall(cfg, p.target, p.data))}</h1>
    <p class="row">${copyBtn(proposalUrl(prefix, id), '🔗 Copy link')} ${copyBtn(`${name} change #${id} (council ${address})`, 'Copy ID')}</p>
    <h2>Reason given</h2>${reason}
    <h2>What happens next</h2><p>${esc(NEXT[st] || '')}</p>
    ${p.emergency ? `<p class="warn"><strong>Emergency change:</strong> it runs as soon as it is approved, then residents vote to keep it${Number(p.ratifyPoll) ? ` (poll ${p.ratifyPoll})` : ''}; it is undone unless they ratify it.</p>` : ''}
    <h2>Timeline</h2>
    <ul class="list">
      <li>Proposed ${esc(when(p.proposedAt))} (${countdown(p.proposedAt)}) by ${addrHtml(p.proposer)}</li>
      ${approvedAt ? `<li>Enough approvals ${esc(when(approvedAt))} (${countdown(approvedAt)})</li>` : ''}
      ${Number(p.readyAt) ? `<li>${st === 2 ? 'Can run from' : 'Could run from'} ${esc(when(p.readyAt))} (${countdown(p.readyAt)})</li>` : `<li>Then a public wait of ${Number(delay) / 3600} hours${p.fast ? ' (none: it only removes power)' : ''}</li>`}
      ${st >= 1 && st <= 3 && Number(p.readyAt) ? `<li>Lapses if not run by ${esc(when(Number(p.readyAt) + GRACE))}</li>` : ''}
    </ul>
    <h2>Who has approved</h2>
    <ul class="list">${members.map((m, i) => `<li>${approvedBy[i] ? '✓ Approved' : '○ Not yet'} · ${addrHtml(m)}</li>`).join('')}</ul>
    <h2>Exactly what it changes</h2>
    <p>Contract: ${d.contract.name ? `<strong>${esc(d.contract.name)}</strong><br>` : ''}${addrHtml(d.contract.address)}</p>
    <p>Action: <span class="code">${esc(d.fn)}</span>${d.known ? '' : ' <span class="warn">(not one the app recognises: check the raw data below carefully before approving)</span>'}</p>
    ${d.args.length ? `<table class="data"><thead><tr><th>Setting</th><th>Value</th></tr></thead><tbody>${d.args.map((a) => `<tr><td>${esc(a.name)}</td><td><span class="code" style="word-break:break-all">${esc(a.value)}</span>${a.note ? `<br><span class="muted">${esc(a.note)}</span>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}
    ${Number(p.value) ? `<p>Sends ${esc(ethers.formatEther(p.value))} ETH with it.</p>` : ''}
    <details><summary>Raw transaction data</summary><p class="code" style="word-break:break-all">${esc(p.data)}</p></details>
    <p class="row"><a class="button primary" href="./#${prefix}-${id}">Approve, reject or run it in the app</a></p>
    <p class="muted">Only council members can approve or reject. Anyone can run a change once it is ready.</p>
  </div>`;
  wireCopy(document);
  startTicker(provider);
})().catch((e) => {
  $('proposal').innerHTML = `<div class="card"><p class="error">${esc(e.shortMessage || e.message)}</p><p><a href="dashboard.html#h-council">See all council changes</a></p></div>`;
});
