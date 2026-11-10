/**
 * app/src/mandates.js - the Mandates screen: every mandate the public created, its goal,
 * deadline, checks and budget, with the actions that fit the person looking:
 *
 *   responsible party  submit evidence that the work is done
 *   verifier           approve or reject the evidence, with reasons
 *   anyone             back the mandate with funds (held in its escrow until the outcome),
 *                      release a verified budget, open refunds for a repealed mandate,
 *                      claim their refund, apply the overdue penalty
 *
 * All text (evidence, reasons) is published on the notice board, so it is permanent.
 */

import { ethers } from 'ethers';
import { readDoc, postDoc } from './notices.js';
import { renderExplainer } from './explain.js';
import { countdown } from './time.js';

const REGISTRY_ABI = [
  'function mandateCount() view returns (uint256)',
  'function getMandate(uint256) view returns (tuple(address responsible, uint64 createdAt, uint64 deadline, uint64 settledAt, uint16 threshold, uint8 status, uint32 round, uint32 approvals, uint32 rejections, bytes32 category, string specCID, string evidenceCID, uint64 pausedAt))',
  'function isOverdue(uint256) view returns (bool)',
  'function hasRole(bytes32, address) view returns (bool)',
  'function hasAttested(uint256, uint32, address) view returns (bool)',
  'function submitEvidence(uint256, string)',
  'function attest(uint256, bool, string)',
];
const FACTORY_ABI = ['function escrowOf(uint256) view returns (address)', 'function escrowFor(uint256) returns (address)', 'function decayBps() view returns (uint16)', 'function decayInterval() view returns (uint32)'];
const ESCROW_ABI = [
  'function lockedBalance() view returns (uint256)',
  'function totalContributed() view returns (uint256)',
  'function totalClawedBack() view returns (uint256)',
  'function settlement() view returns (uint8)',
  'function canDecay() view returns (bool)',
  'function contributionOf(address) view returns (uint256)',
  'function refundClaimed(address) view returns (bool)',
  'function depositETH() payable',
  'function release()',
  'function openRefunds()',
  'function claimRefund()',
  'function progressiveDecay()',
];
const STATUS = ['', 'In progress', 'Evidence under review', 'Done and verified', 'Repealed', 'Paused for review'];
const VERIFIER = ethers.id('VERIFIER_ROLE');
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const eth = (wei) => `${Number(ethers.formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ETH`;
const day = (secs) => new Date(Number(secs) * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' });

/**
 * @param {object} ctx { state, $, status, esc, show, activeSigner, activeAddress, sendTx }
 */
export function wireMandates(ctx) {
  const { state, $, status, esc } = ctx;
  const registry = () => new ethers.Contract(state.config.registryAddress, REGISTRY_ABI, state.provider);
  const factory = () => (state.config.escrowFactoryAddress ? new ethers.Contract(state.config.escrowFactoryAddress, FACTORY_ABI, state.provider) : null);

  async function render() {
    const list = $('mandate-list');
    if (!state.config.registryAddress) return (list.innerHTML = '<p class="muted">Mandates are not set up on this deployment.</p>');
    list.innerHTML = '<p class="muted">Loading…</p>';
    const r = registry();
    const me = ctx.activeAddress();
    const [count, isVerifier, block] = await Promise.all([r.mandateCount(), r.hasRole(VERIFIER, me), state.provider.getBlock('latest')]);
    const f = factory();
    const terms = f ? await Promise.all([f.decayBps(), f.decayInterval()]) : null;
    const cards = [];
    for (let id = Number(count); id >= Math.max(1, Number(count) - 19); id--) {
      const [m, overdue] = await Promise.all([r.getMandate(id), r.isOverdue(id)]);
      const goal = await readDoc(state.config, state.provider, m.specCID);
      const st = Number(m.status);
      const open = st === 1 || st === 2;
      const mine = m.responsible.toLowerCase() === me.toLowerCase();
      const escAddr = f ? await f.escrowOf(id) : ethers.ZeroAddress;
      const e = escAddr !== ethers.ZeroAddress ? new ethers.Contract(escAddr, ESCROW_ABI, state.provider) : null;
      const [locked, contributed, clawed, settlement, canDecay, myShare, claimed] = e
        ? await Promise.all([e.lockedBalance(), e.totalContributed(), e.totalClawedBack(), e.settlement(), e.canDecay(), e.contributionOf(me), e.refundClaimed(me)])
        : [0n, 0n, 0n, 0n, false, 0n, false];
      let evidence = null;
      if (st === 2 && m.evidenceCID) evidence = await readDoc(state.config, state.provider, m.evidenceCID);
      const attested = st === 2 && isVerifier ? await r.hasAttested(id, m.round, me) : false;
      const label = overdue ? 'Overdue' : STATUS[st];
      const daysLeft = Math.ceil((Number(m.deadline) - block.timestamp) / 86_400);

      const parts = [];
      parts.push(`<p class="eyebrow">Mandate ${id} · ${esc(label)}${open && !overdue ? ` · due ${esc(day(m.deadline))} (${countdown(m.deadline)})` : ` · deadline ${esc(day(m.deadline))}${overdue ? ` (${countdown(m.deadline, 'overdue · was due ')})` : ''}`}</p>
        <h3>${esc(goal.title)}</h3>${goal.body ? `<p>${esc(goal.body)}</p>` : ''}
        <p class="muted">Responsible: <span class="code">${esc(short(m.responsible))}</span>${mine ? ' (you)' : ''} · ${m.threshold} independent check${Number(m.threshold) === 1 ? '' : 's'} needed</p>
        <p><strong>Budget:</strong> ${e ? `${esc(eth(locked))} held${contributed > locked && st !== 3 ? ` (of ${esc(eth(contributed))} backed${clawed ? `, ${esc(eth(clawed))} forfeited for lateness` : ''})` : ''}` : 'nobody has backed it yet'}${terms ? `. Paid to the responsible party once verified; refunded if repealed; ${Number(terms[0]) / 100}% forfeited to the public treasury every ${Math.round(Number(terms[1]) / 86_400)} day${Number(terms[1]) === 86_400 ? '' : 's'} while overdue.` : ''}</p>`);
      if (evidence) parts.push(`<div class="card"><p class="eyebrow">Evidence submitted (check ${m.round})</p><p>${esc(evidence.body || evidence.title)}</p><p class="muted">${m.approvals} approval${Number(m.approvals) === 1 ? '' : 's'}, ${m.rejections} rejection${Number(m.rejections) === 1 ? '' : 's'} of ${m.threshold} needed</p></div>`);

      // Actions for this person.
      const acts = [];
      if (mine && st === 1) acts.push(`<label for="evidence-${id}">What was done (with links to photos, documents or data)</label><textarea id="evidence-${id}" rows="3"></textarea><button class="primary" data-act="evidence" data-id="${id}">Submit for checking</button>`);
      if (isVerifier && st === 2 && !mine && !attested) acts.push(`<label for="reason-${id}">Your reasons (published with your decision)</label><textarea id="reason-${id}" rows="3"></textarea><div class="row"><button class="primary" data-act="approve" data-id="${id}">Approve: it's done</button><button data-act="reject" data-id="${id}">Reject: not done</button></div>`);
      if (isVerifier && attested) acts.push('<p class="muted">You have checked this round.</p>');
      if (open && f) acts.push(`<div class="row"><label>Back it with <input type="text" id="back-${id}" inputmode="decimal" placeholder="0.001" style="width:120px" /> ETH</label><button data-act="back" data-id="${id}">Back this mandate</button></div>`);
      if (e && st === 3 && Number(settlement) === 0 && locked > 0n) acts.push(`<button class="primary" data-act="release" data-id="${id}">Pay the budget to the responsible party</button>`);
      if (e && st === 4 && Number(settlement) === 0 && locked > 0n) acts.push(`<button data-act="refunds" data-id="${id}">Open refunds for backers</button>`);
      if (e && Number(settlement) === 2 && myShare > 0n && !claimed) acts.push(`<button class="primary" data-act="claim" data-id="${id}">Claim my refund</button>`);
      if (e && overdue && canDecay) acts.push(`<button data-act="decay" data-id="${id}">Apply the lateness penalty now</button>`);
      if (myShare > 0n) parts.push(`<p class="muted">You backed it with ${esc(eth(myShare))}.</p>`);
      cards.push(`<article class="card stack" id="mandate-${id}">${parts.join('')}${acts.join('')}<p class="status" id="mandate-status-${id}" role="status"></p>
        ${st === 3 || st === 4 ? `<div class="rating-box" data-id="${id}"></div>` : ''}<div class="explain-box" data-id="${id}"></div><div class="thread-box" data-id="${id}"></div></article>`);
    }
    list.innerHTML = cards.join('') || '<p class="muted">No mandates yet. A mandate is created when a binding poll passes.</p>';
    for (const b of list.querySelectorAll('button[data-act]')) b.onclick = () => act(b, Number(b.dataset.id), b.dataset.act);
    for (const box of list.querySelectorAll('.thread-box')) state.feedback?.thread(box, 'mandate', Number(box.dataset.id)).catch(() => {});
    for (const box of list.querySelectorAll('.rating-box')) state.feedback?.rating(box, 'mandate', Number(box.dataset.id)).catch(() => {});
    for (const box of list.querySelectorAll('.explain-box')) renderExplainer({ state, esc, status }, box, 'mandate', Number(box.dataset.id)).catch(() => {});
  }

  async function act(button, id, kind) {
    const el = $(`mandate-status-${id}`);
    button.disabled = true;
    const signer = ctx.activeSigner();
    const r = registry().connect(signer);
    const escrow = async () => {
      const f = factory();
      let a = await f.escrowOf(id);
      if (a === ethers.ZeroAddress) {
        status(el, 'Setting up this mandate\'s budget: confirm if asked…');
        await (await f.connect(signer).escrowFor(id)).wait();
        a = await f.escrowOf(id);
      }
      return new ethers.Contract(a, ESCROW_ABI, signer);
    };
    let ok = false;
    try {
      if (kind === 'evidence') {
        const text = $(`evidence-${id}`).value.trim();
        if (!text) throw new Error('Describe what was done first.');
        status(el, 'Publishing your evidence: confirm if asked…');
        const ref = await postDoc(state.config, signer, { title: `Evidence for mandate ${id}`, body: text });
        ok = await ctx.sendTx(el, 'Submit for checking', () => r.submitEvidence(id, ref));
      } else if (kind === 'approve' || kind === 'reject') {
        const text = $(`reason-${id}`).value.trim();
        let ref = '';
        if (text) {
          status(el, 'Publishing your reasons: confirm if asked…');
          ref = await postDoc(state.config, signer, { title: `${kind === 'approve' ? 'Approval' : 'Rejection'} for mandate ${id}`, body: text });
        }
        ok = await ctx.sendTx(el, kind === 'approve' ? 'Approve' : 'Reject', () => r.attest(id, kind === 'approve', ref));
      } else if (kind === 'back') {
        const amount = $(`back-${id}`).value.trim();
        let value;
        try {
          value = ethers.parseEther(amount);
        } catch {
          throw new Error('Enter an amount of ETH, for example 0.001.');
        }
        if (value <= 0n) throw new Error('Enter an amount of ETH, for example 0.001.');
        const e = await escrow();
        ok = await ctx.sendTx(el, 'Back this mandate', () => e.depositETH({ value }));
      } else {
        const e = await escrow();
        const fn = { release: 'release', refunds: 'openRefunds', claim: 'claimRefund', decay: 'progressiveDecay' }[kind];
        const label = { release: 'Pay the budget', refunds: 'Open refunds', claim: 'Claim refund', decay: 'Apply the penalty' }[kind];
        ok = await ctx.sendTx(el, label, () => e[fn]());
      }
    } catch (e) {
      status(el, e.shortMessage || e.message, 'error');
    }
    if (ok) {
      const msg = el.innerHTML;
      await render();
      const again = $(`mandate-status-${id}`);
      if (again) again.innerHTML = msg;
    } else button.disabled = false;
  }

  $('nav-mandates').onclick = async () => {
    ctx.show('screen-mandates');
    await render().catch((e) => ($('mandate-list').innerHTML = `<p class="error">Could not load mandates: ${esc(e.shortMessage || e.message)}</p>`));
  };
  $('btn-mandates-refresh').onclick = () => $('nav-mandates').onclick();
  return { render };
}
