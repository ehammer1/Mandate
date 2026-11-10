/**
 * app/src/budget.js - civic credits: participatory budgeting rounds in the voter app.
 *
 * Each eligible person gets the same allowance of credits per round and spreads them
 * across proposals; n votes on one proposal cost n x n credits. The allocation is an
 * anonymous proof (one per person per round), sent through the relayers like a ballot.
 */

import { ethers } from 'ethers';
import { buildAllocation, cost } from '../../client/budget.js';
import { readDoc, postDoc, isNoticeRef } from './notices.js';

const BUDGET_ABI = [
  'function roundCount() view returns (uint256)',
  'function identity() view returns (address)',
  'function scopeOf(uint256) view returns (uint256)',
  'function nullifierUsed(uint256, uint256) view returns (bool)',
  'function getRound(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 credits, uint256 budget, string ref, bool finalized, uint256 participants, uint256 spent, uint256 fundedMask))',
  'function getProposals(uint256) view returns (string[] refs, uint256[] costs, uint256[] votes)',
  'function hasRole(bytes32, address) view returns (bool)',
  'function createRound(uint256 groupId, uint64 duration, uint32 credits, uint256 budget, string ref, string[] refs, uint256[] costs)',
  'function finalize(uint256)',
  'error RoundTooShort(uint64 minSeconds)',
];
const PROPOSER = ethers.id('PROPOSER_ROLE');
const GROUP_LABEL = ['All members', 'ID-checked residents', 'Residents with full voting rights'];
const money = (n) => `$${Number(n).toLocaleString()}`;
const when = (secs) => new Date(Number(secs) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A proposal's text: a notice-board reference or the plain title stored on-chain. */
async function proposalTitle(cfg, provider, ref) {
  if (!isNoticeRef(ref)) return ref;
  return (await readDoc(cfg, provider, ref)).title;
}

/**
 * @param {object} ctx { state, $, status, esc, show, activeSigner, activeAddress, sendTx, nullifierFor }
 */
export function wireBudget(ctx) {
  const { state, $, status, esc } = ctx;
  const budget = () => new ethers.Contract(state.config.budgetAddress, BUDGET_ABI, state.provider);

  async function render() {
    const list = $('budget-list');
    if (!state.config.budgetAddress) return (list.innerHTML = '<p class="muted">Civic budgeting is not set up on this deployment.</p>');
    list.innerHTML = '<p class="muted">Loading…</p>';
    const b = budget();
    const [count, block, groups] = await Promise.all([b.roundCount(), state.provider.getBlock('latest'), Promise.all([0, 1, 2].map((t) => state.registry.groupId(t)))]);
    let myTier = -1;
    try {
      const m = await state.registry.members(state.identity.commitment);
      if (m.active) myTier = Number(m.tier);
    } catch {
      /* not enrolled */
    }
    const cards = [];
    for (let id = Number(count); id >= Math.max(1, Number(count) - 9); id--) {
      const [r, [refs, costs, votes]] = await Promise.all([b.getRound(id), b.getProposals(id)]);
      const doc = await readDoc(state.config, state.provider, r.ref);
      const titles = await Promise.all(refs.map((x) => proposalTitle(state.config, state.provider, x)));
      const open = !r.finalized && block.timestamp < Number(r.end);
      const tier = groups.findIndex((g) => g === r.groupId);
      const eligible = myTier >= tier;
      const done = await b.nullifierUsed(id, await ctx.nullifierFor(await b.scopeOf(id)));
      const canVote = open && eligible && !done;
      const rows = titles
        .map((t, i) => {
          const funded = r.finalized && (r.fundedMask >> BigInt(i)) & 1n;
          return `<li class="budget-row" data-i="${i}">
            <div><strong>${esc(t)}</strong> <span class="muted">${esc(money(costs[i]))}</span>${r.finalized ? (funded ? ' <span class="ok">✓ funded</span>' : ' <span class="muted">not funded</span>') : ''}<br><span class="muted">${votes[i]} vote${votes[i] === 1n ? '' : 's'}${r.finalized ? '' : ' so far'}</span></div>
            ${canVote ? `<div class="stepper"><button data-step="-1" aria-label="One vote less for ${esc(t)}">−</button><span class="n" aria-live="polite">0</span><button data-step="1" aria-label="One vote more for ${esc(t)}">+</button></div>` : ''}
          </li>`;
        })
        .join('');
      cards.push(`<article class="card stack" id="round-${id}" data-credits="${r.credits}">
        <p class="eyebrow">Budget round ${id} · ${open ? `open until ${esc(when(r.end))}` : r.finalized ? `closed · ${esc(money(r.spent))} of ${esc(money(r.budget))} allocated` : 'voting ended · results not yet counted'} · ${esc(GROUP_LABEL[tier] || 'Members')}</p>
        <h3>${esc(doc.title)}</h3>${doc.body ? `<p>${esc(doc.body)}</p>` : ''}
        <p class="muted">Budget ${esc(money(r.budget))} · ${r.credits} credits per person · ${r.participants} of ${r.electorate} have taken part</p>
        ${canVote ? `<p class="note">Spread your ${r.credits} credits. 1 vote costs 1 credit, 2 votes cost 4, 3 votes cost 9: strong preferences count, but cost more. Nobody sees how you spent them.</p>` : ''}
        <ul class="budget-rows">${rows}</ul>
        ${canVote ? `<p class="credits" id="credits-${id}">0 of ${r.credits} credits used</p><button class="primary" data-act="allocate" data-id="${id}">Submit my choices</button>` : ''}
        ${open && !eligible ? `<p class="note">${myTier < 0 ? 'Join first to take part.' : `Only ${esc((GROUP_LABEL[tier] || '').toLowerCase())} can take part in this round.`}</p>` : ''}
        ${done ? '<p class="ok">Your choices are recorded. Nobody can see how you spent your credits.</p>' : ''}
        ${!open && !r.finalized ? `<button data-act="count" data-id="${id}">Count the results</button>` : ''}
        <p class="status" id="round-status-${id}" role="status"></p>
      </article>`);
    }
    list.innerHTML = cards.join('') || '<p class="muted">No budget rounds yet.</p>';
    for (const card of list.querySelectorAll('article[data-credits]')) wireSteppers(card);
    for (const btn of list.querySelectorAll('button[data-act]')) btn.onclick = () => act(btn, Number(btn.dataset.id), btn.dataset.act);
  }

  function choices(card) {
    return [...card.querySelectorAll('.budget-row')].map((row) => Number(row.querySelector('.n')?.textContent || 0));
  }

  function wireSteppers(card) {
    const credits = Number(card.dataset.credits);
    const id = card.id.slice('round-'.length);
    for (const btn of card.querySelectorAll('button[data-step]')) {
      btn.onclick = () => {
        const n = btn.parentElement.querySelector('.n');
        const next = Math.max(0, Number(n.textContent) + Number(btn.dataset.step));
        const trial = choices(card);
        trial[Number(btn.closest('.budget-row').dataset.i)] = next;
        if (cost(trial) > credits) return status($(`round-status-${id}`), `That would cost ${cost(trial)} credits; you have ${credits}.`, 'warn');
        n.textContent = String(next);
        status($(`round-status-${id}`), '');
        $(`credits-${id}`).textContent = `${cost(choices(card))} of ${credits} credits used`;
      };
    }
  }

  async function act(btn, id, kind) {
    const el = $(`round-status-${id}`);
    btn.disabled = true;
    if (kind === 'count') {
      if (await ctx.sendTx(el, 'Count the results', () => budget().connect(ctx.activeSigner()).finalize(id))) await render();
      else btn.disabled = false;
      return;
    }
    const votes = choices($(`round-${id}`));
    if (!votes.some((v) => v > 0)) {
      btn.disabled = false;
      return status(el, 'Give at least one vote first.', 'warn');
    }
    status(el, 'Building your private choices on this device… this can take a few seconds.');
    let allocation;
    try {
      allocation = await buildAllocation({ provider: state.provider, budget: budget(), roundId: id, identity: state.identity, votes, artifactsBase: state.config.artifactsBase || undefined });
    } catch (e) {
      btn.disabled = false;
      return status(el, /not eligible/.test(e.message) ? 'You were not on the voter list when this round opened.' : e.message, 'error');
    }
    status(el, 'Sending…');
    let last = 'No relayer is configured.';
    for (const url of state.config.relayers || []) {
      try {
        const res = await fetch(`${url.replace(/\/+$/, '')}/allocation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roundId: String(id), allocation }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
        });
        const out = await res.json().catch(() => ({}));
        if (res.ok || res.status === 409) {
          await render();
          return status($(`round-status-${id}`), 'Your choices are recorded.', 'ok');
        }
        last = out.message || out.error || `relayer answered ${res.status}`;
        if (res.status === 422) break;
      } catch (e) {
        last = e.message;
      }
    }
    btn.disabled = false;
    status(el, `Could not record your choices: ${last}`, 'error');
  }

  // Admin: open a round.
  async function openRound() {
    const el = $('round-status');
    const title = $('round-title').value.trim();
    const lines = $('round-proposals').value.split('\n').map((l) => l.trim()).filter(Boolean);
    const props = lines.map((l) => {
      const m = l.match(/^(.*?)[|,;]\s*\$?\s*([\d,.]+)\s*(k)?\s*$/i);
      return m ? { title: m[1].trim(), cost: Math.round(Number(m[2].replace(/,/g, '')) * (m[3] ? 1000 : 1)) } : null;
    });
    const total = Math.round(Number($('round-budget').value.replace(/[$,\s]/g, '')));
    const credits = Number($('round-credits').value);
    const days = Number($('round-days').value);
    if (!title) return status(el, 'Give the round a title.', 'error');
    if (!props.length || props.some((p) => !p || !p.title || !(p.cost > 0))) return status(el, 'Write one proposal per line as "Title | cost", e.g. "Repave Oak Street | 50000".', 'error');
    if (props.length > 20) return status(el, 'At most 20 proposals per round.', 'error');
    if (!(total > 0) || !(credits >= 1) || !(days > 0)) return status(el, 'Fill in the total budget, credits per person and days.', 'error');
    const b = budget().connect(ctx.activeSigner());
    const groupId = await state.registry.groupId(Number($('round-group').value));
    const args = (ref) => [groupId, Math.round(days * 86_400), credits, total, ref, props.map((p) => p.title.slice(0, 120)), props.map((p) => p.cost)];
    try {
      await b.createRound.staticCall(...args(`nb:0x${'0'.repeat(64)}`)); // check the rules before publishing anything
    } catch (e) {
      let name = e.revert?.name;
      try {
        name ||= b.interface.parseError(e.data)?.name;
      } catch {
        /* other */
      }
      return status(el, name === 'RoundTooShort' ? "This round is shorter than the community's rules allow (see Rules)." : `Open round failed: ${name || e.shortMessage || e.message}`, 'error');
    }
    let ref;
    try {
      status(el, 'Publishing the round: confirm if asked…');
      ref = await postDoc(state.config, ctx.activeSigner(), { title, body: $('round-body').value.trim() });
    } catch (e) {
      return status(el, `Could not publish the round: ${e.shortMessage || e.message}`, 'error');
    }
    if (await ctx.sendTx(el, 'Open budget round', () => b.createRound(...args(ref)))) {
      for (const id of ['round-title', 'round-body', 'round-proposals']) $(id).value = '';
    }
  }

  async function canOpen(address) {
    if (!state.config.budgetAddress) return false;
    return budget().hasRole(PROPOSER, address);
  }

  $('nav-budget').onclick = async () => {
    ctx.show('screen-budget');
    await render().catch((e) => ($('budget-list').innerHTML = `<p class="error">Could not load budget rounds: ${esc(e.shortMessage || e.message)}</p>`));
  };
  $('btn-open-round').onclick = () => openRound().catch((e) => status($('round-status'), e.message, 'error'));
  return { render, canOpen };
}
