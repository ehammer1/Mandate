/**
 * app/src/agenda.js - the People's Agenda: residents add the issues that matter to them, then
 * rank them with priority credits. The result is the community's own list of priorities, set by
 * residents, not by politicians. Anonymous: nobody can see who added or ranked what.
 */

import { ethers } from 'ethers';
import { AGENDA_ABI, issueProof, rankProof, cost } from '../../client/agenda.js';
import { readDoc } from './notices.js';
import { categoryChip, categoryOf, categoryOptions, categoryLabel } from './priority.js';
import { countdown } from './time.js';


/** @param {object} ctx { state, $, status, esc, activeSigner, activeAddress, nullifierFor, myTier } */
export function wireAgenda(ctx) {
  const { state, $, status, esc } = ctx;
  const at = () => state.config?.agendaAddress;
  const contract = (runner) => new ethers.Contract(at(), AGENDA_ABI, runner || state.provider);
  const when = (s) => new Date(Number(s) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  async function relay(path, body) {
    let last = 'No relayer is configured.';
    for (const url of state.config.relayers || []) {
      try {
        const res = await fetch(`${url.replace(/\/+$/, '')}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) });
        const out = await res.json().catch(() => ({}));
        if (res.ok) return out;
        last = { AlreadyProposed: 'You have already added an issue this season.', NotProposing: 'Adding issues has closed for this season.', NotRanking: 'Ranking is not open right now.', InvalidProof: 'Your voter list changed a moment ago; please try again.' }[out.error] || out.message || out.error || `relayer answered ${res.status}`;
        if (res.status < 500) break;
      } catch (e) {
        last = e.message;
      }
    }
    throw new Error(last);
  }
  const publish = async (doc) => (await relay('/notice', { text: JSON.stringify(doc) })).ref;

  async function seasonCard(id, now, organizer) {
    const k = contract();
    const s = await k.getSeason(id);
    const [refs, credits] = await k.issues(id);
    const [doc, ...docs] = await Promise.all([readDoc(state.config, state.provider, s.ref), ...refs.map((r) => readDoc(state.config, state.provider, r).catch(() => ({ title: '(not found)' })))]);
    const phase = now < Number(s.proposeEnd) ? 'propose' : now < Number(s.end) ? 'rank' : 'closed';
    const items = refs.map((ref, i) => ({ i, ref, doc: docs[i], credits: Number(credits[i]), topic: categoryOf(docs[i]) }));
    const total = items.reduce((a, x) => a + x.credits, 0) || 1;
    const ranked = [...items].sort((a, b) => b.credits - a.credits || a.i - b.i);

    let mine = '';
    if (state.identity && phase === 'propose') {
      const done = await k.proposed(id, await ctx.nullifierFor(await k.issueScope(id))).catch(() => false);
      mine = done
        ? '<p class="muted">You have added your issue this season. Ranking opens when adding closes.</p>'
        : `<details class="card" data-add><summary><strong>Add an issue that matters to you</strong></summary><div class="stack">
            <label>The issue, in one line <input type="text" data-issue-title maxlength="140" placeholder="e.g. Rents are rising faster than wages" /></label>
            <label>Why it matters (optional) <textarea data-issue-body rows="3"></textarea></label>
            <label>Topic <select data-issue-topic>${categoryOptions('general')}</select></label>
            <p class="note">One issue per person per season, anonymous: others see only the issue.</p>
            <button type="button" class="primary" data-issue-send>Add this issue</button></div></details>`;
    }
    let rankBox = '';
    if (state.identity && phase === 'rank' && items.length) {
      rankBox = `<details class="card" data-rank open><summary><strong>Rank what matters most to you</strong></summary><div class="stack">
          <p>You have <strong>${Number(s.credits)} priority credits</strong>. Putting more on one issue costs more: 1 credit costs 1, 2 cost 4, 3 cost 9, 4 cost 16. Spread them, or put them where you care most. You can change your ranking until ${esc(when(s.end))}.</p>
          ${items.map((x) => `<div class="row" style="align-items:center"><span style="flex:1">${esc(x.doc.title)} ${categoryChip(x.topic, esc)}</span><button type="button" data-minus="${x.i}" aria-label="Less">−</button><strong data-n="${x.i}" style="min-width:2ch;text-align:center">0</strong><button type="button" data-plus="${x.i}" aria-label="More">+</button></div>`).join('')}
          <p data-used class="muted">Used 0 of ${Number(s.credits)}</p>
          <button type="button" class="primary" data-rank-send disabled>Send my priorities</button></div></details>`;
    }
    const results = `<div class="stack"><p><strong>${phase === 'closed' ? 'The community\'s priorities' : phase === 'rank' ? 'Priorities so far' : 'Issues added so far'}</strong>${phase !== 'propose' ? ` · ${Number(s.participants)} of ${Number(s.electorate)} residents ranked` : ''}</p>
      ${ranked.length ? `<ol class="list">${ranked.map((x) => `<li>${esc(x.doc.title)} ${categoryChip(x.topic, esc)}${phase !== 'propose' ? `<br><span class="muted">${x.credits} credit${x.credits === 1 ? '' : 's'} · ${Math.round((100 * x.credits) / total)}%</span>` : ''}${x.doc.body ? `<details><summary>Why</summary><p>${esc(x.doc.body)}</p></details>` : ''}</li>`).join('')}</ol>` : '<p class="muted">No issues yet.</p>'}
      ${phase !== 'propose' && ranked.length ? `<p class="muted">By topic: ${Object.entries(ranked.reduce((m, x) => ((m[x.topic] = (m[x.topic] || 0) + x.credits), m), {})).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${esc(categoryLabel(t))} ${Math.round((100 * n) / total)}%`).join(' · ')}</p>` : ''}</div>`;
    const org = organizer && phase === 'propose'
      ? `<details><summary>Organizer: add a common issue</summary><div class="stack"><label>Issue <input type="text" data-org-title maxlength="140" /></label><label>Topic <select data-org-topic>${categoryOptions('general')}</select></label><button type="button" data-org-add>Add</button></div></details>`
      : '';
    const el = document.createElement('article');
    el.className = 'card stack';
    el.id = `agenda-${id}`;
    el.innerHTML = `<p class="eyebrow">People's Agenda ${id} · ${phase === 'propose' ? `adding issues until ${esc(when(s.proposeEnd))} (${countdown(s.proposeEnd)})` : phase === 'rank' ? `ranking until ${esc(when(s.end))} (${countdown(s.end)})` : `closed ${esc(when(s.end))}`}</p>
      <h3>${esc(doc.title)}</h3>${doc.body ? `<p>${esc(doc.body)}</p>` : ''}
      ${mine}${rankBox}${results}${org}<p class="status" role="status" data-status></p>`;
    wire(el, id, s, items);
    return el;
  }

  function wire(el, id, s, items) {
    const st = el.querySelector('[data-status]');
    const k = contract();
    el.querySelector('[data-issue-send]')?.addEventListener('click', async (ev) => {
      const title = el.querySelector('[data-issue-title]').value.trim();
      if (!title) return status(st, 'Write the issue first.', 'error');
      ev.target.disabled = true;
      try {
        if ((await ctx.myTier()) < 0) throw new Error('Join first to add an issue.');
        status(st, 'Publishing your issue privately…');
        const ref = await publish({ title, body: el.querySelector('[data-issue-body]').value.trim(), category: el.querySelector('[data-issue-topic]').value });
        const proof = await issueProof({ provider: state.provider, agenda: k, seasonId: id, identity: state.identity, ref, artifactsBase: state.config.artifactsBase || undefined });
        await relay('/agenda', { method: 'propose', args: [id, ref], proof });
        status(st, 'Added.', 'ok');
        render();
      } catch (e) {
        status(st, e.message, 'error');
        ev.target.disabled = false;
      }
    });
    const n = new Map();
    const draw = () => {
      for (const x of items) el.querySelector(`[data-n="${x.i}"]`) && (el.querySelector(`[data-n="${x.i}"]`).textContent = String(n.get(x.i) || 0));
      const used = cost([...n.values()]);
      const u = el.querySelector('[data-used]');
      if (u) {
        u.textContent = `Used ${used} of ${Number(s.credits)}`;
        u.className = used > Number(s.credits) ? 'error' : 'muted';
      }
      const send = el.querySelector('[data-rank-send]');
      if (send) send.disabled = !used || used > Number(s.credits);
    };
    for (const b of el.querySelectorAll('[data-plus]')) b.onclick = () => (n.set(Number(b.dataset.plus), (n.get(Number(b.dataset.plus)) || 0) + 1), draw());
    for (const b of el.querySelectorAll('[data-minus]')) b.onclick = () => (n.set(Number(b.dataset.minus), Math.max(0, (n.get(Number(b.dataset.minus)) || 0) - 1)), draw());
    el.querySelector('[data-rank-send]')?.addEventListener('click', async (ev) => {
      const picks = [...n.entries()].filter(([, v]) => v > 0).map(([i]) => i);
      const credits = picks.map((i) => n.get(i));
      ev.target.disabled = true;
      try {
        if ((await ctx.myTier()) < 0) throw new Error('Join first to rank.');
        status(st, 'Sending your priorities privately…');
        const proof = await rankProof({ provider: state.provider, agenda: k, seasonId: id, identity: state.identity, picks, credits, artifactsBase: state.config.artifactsBase || undefined });
        await relay('/agenda', { method: 'rank', args: [id, picks, credits], proof });
        status(st, 'Counted. You can change it until the season closes.', 'ok');
        render();
      } catch (e) {
        status(st, e.message, 'error');
        ev.target.disabled = false;
      }
    });
    el.querySelector('[data-org-add]')?.addEventListener('click', async () => {
      const title = el.querySelector('[data-org-title]').value.trim();
      if (!title) return;
      try {
        status(st, 'Publishing…');
        const ref = await publish({ title, category: el.querySelector('[data-org-topic]').value });
        status(st, 'Add the issue: confirm…');
        await (await contract(ctx.activeSigner()).addIssue(id, ref)).wait();
        render();
      } catch (e) {
        status(st, e.shortMessage || e.message, 'error');
      }
    });
  }

  async function render() {
    const list = $('agenda-list');
    if (!list || !at()) return;
    const k = contract();
    const me = ctx.activeAddress?.() || null;
    const [count, block, organizer] = await Promise.all([k.seasonCount(), state.provider.getBlock('latest'), me ? k.hasRole(ethers.id('ORGANIZER_ROLE'), me).catch(() => false) : false]);
    $('agenda-new').hidden = !organizer;
    const ids = [];
    for (let i = Number(count); i >= 1 && ids.length < 6; i--) ids.push(i);
    const cards = await Promise.all(ids.map((id) => seasonCard(id, block.timestamp, organizer).catch(() => null)));
    list.replaceChildren(...cards.filter(Boolean));
    if (!ids.length) list.innerHTML = '<p class="muted">No season yet. When one opens, every resident can add an issue and then rank what matters most.</p>';
  }

  $('btn-agenda-open')?.addEventListener('click', async () => {
    const el = $('agenda-status');
    const title = $('agenda-title').value.trim();
    if (!title) return status(el, 'Give the season a name, e.g. "Spring 2027: what should the city work on?"', 'error');
    try {
      status(el, 'Publishing…');
      const ref = await publish({ title, body: $('agenda-body').value.trim() });
      status(el, 'Open the season: confirm…');
      const days = (id) => Math.round(Number($(id).value) * 86_400);
      await (await contract(ctx.activeSigner()).openSeason(Number($('agenda-tier').value), days('agenda-propose-days'), days('agenda-rank-days'), Number($('agenda-credits').value), ref)).wait();
      status(el, 'Season opened.', 'ok');
      render();
    } catch (e) {
      status(el, e.shortMessage || e.message, 'error');
    }
  });

  return { render: () => render().catch((e) => ($('agenda-list').innerHTML = `<p class="error">Could not load: ${esc(e.shortMessage || e.message)}</p>`)) };
}
