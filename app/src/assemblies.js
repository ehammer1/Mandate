/**
 * app/src/assemblies.js - citizens' assemblies: residents drawn at random from the voter list,
 * like a jury, study an issue and recommend what everyone votes on.
 *   - everyone: each assembly, its question, the draw (redone here from the public seed), the
 *     seats filled and the recommendation
 *   - a drawn resident: "You were drawn", and a signed seat code to give the organizer
 *   - an organizer: announce a draw, run it, confirm seats from codes, publish the recommendation
 */

import { ethers } from 'ethers';
import { ASSEMBLIES_ABI, drawOrder, acceptCode, checkAcceptCode, endorseCode, checkEndorsements } from '../../client/assembly.js';
import { readDoc } from './notices.js';

const LISTS = ['all members', 'ID-checked residents', 'residents with full voting rights'];
const WHY = {
  BadParams: 'Check the question, the number of seats (no more than the people on the list) and the wait.',
  TooEarly: 'The draw block has not been reached yet. Try again in a minute.',
  Missed: 'The draw was not run in time: use "Set a new draw block".',
  AlreadyDrawn: 'This draw has already been run.',
  NotOrganizer: "Only this assembly's organizer can do that.",
  SeatsFull: 'All seats are filled.',
  AlreadySeated: 'That seat is already confirmed.',
  AccessControlUnauthorizedAccount: "This account can't organize assemblies. The council can allow it (Admin, Roles).",
};

/** @param {object} ctx { state, $, status, esc, show, activeSigner, activeAddress, sendTx } */
export function wireAssemblies(ctx) {
  const { state, $, status, esc } = ctx;
  const at = () => state.config?.assembliesAddress;
  const contract = (runner) => new ethers.Contract(at(), ASSEMBLIES_ABI, runner || state.provider);
  const orders = new Map();

  async function publish(doc) {
    let last = 'No relayer is configured.';
    for (const url of state.config.relayers || []) {
      try {
        const res = await fetch(`${url.replace(/\/+$/, '')}/notice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: JSON.stringify(doc) }) });
        const out = await res.json().catch(() => ({}));
        if (res.ok) return out.ref;
        last = out.error || `relayer answered ${res.status}`;
      } catch (e) {
        last = e.message;
      }
    }
    throw new Error(last);
  }

  async function send(el, label, fn) {
    status(el, `${label}: confirm…`);
    try {
      const tx = await fn(contract(ctx.activeSigner()));
      status(el, `${label}: waiting for the network…`);
      await tx.wait();
      status(el, `${label}: done.`, 'ok');
      return true;
    } catch (e) {
      let name = e.revert?.name;
      try {
        name ||= contract().interface.parseError(e.data)?.name;
      } catch {
        /* not ours */
      }
      status(el, `${label} failed: ${WHY[name] || name || e.shortMessage || e.message}`, 'error');
      return false;
    }
  }

  /** Seat positions an endorsement claims (checked properly by checkEndorsements). */
  const claimed = (codes) =>
    (codes || []).map((c) => {
      try {
        return JSON.parse(ethers.toUtf8String(ethers.decodeBase64(String(c).replace(/\s+/g, '').slice(4)))).position;
      } catch {
        return null;
      }
    }).filter((x) => Number.isInteger(x));

  /** Endorsements of a final statement, checked on this device: how many seated members agreed. */
  async function verified(id, a, report) {
    const order = await orderOf(id, a);
    const positions = [...new Set(claimed(report.endorsements))];
    const flags = await Promise.all(positions.map((p) => contract().seated(id, p).catch(() => false)));
    const seated = new Set(positions.filter((_, i) => flags[i]));
    const net = await state.provider.getNetwork();
    return checkEndorsements(report.endorsements, { chainId: net.chainId, address: at(), id, ref: report.draft, order, seated }).positions.length;
  }

  /** The assembly's statement: a recommendation, or a review panel's case for and against. */
  async function statementHtml(id, a, report, panel) {
    if (!report) return '';
    const list = (xs) => (xs?.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">None given.</p>');
    const sides = report.for || report.against ? `<div class="row" style="align-items:flex-start"><div style="flex:1;min-width:140px"><p><strong>Strongest reasons for</strong></p>${list(report.for)}</div><div style="flex:1;min-width:140px"><p><strong>Strongest reasons against</strong></p>${list(report.against)}</div></div>` : '';
    let who = '';
    if (report.stage === 'draft') who = '<p class="warn">Draft: waiting for the panel members to endorse it.</p>';
    else if (report.stage === 'final') {
      const n = await verified(id, a, report).catch(() => 0);
      who = `<p class="note">Endorsed by <strong>${n} of ${Number(a.filled)}</strong> seated members, each signature checked on this device.</p>`;
    }
    return `<div class="card"><p><strong>${panel ? 'Citizens\' review panel' : 'Recommendation'}</strong></p><p>${esc(report.title)}</p>${report.body ? `<p>${esc(report.body)}</p>` : ''}${sides}${who}</div>`;
  }

  const orderOf = async (id, a) => {
    const key = `${at()}:${id}:${a.seed}`;
    if (!orders.has(key)) orders.set(key, await drawOrder({ assemblies: contract(), provider: state.provider, id, count: Number(a.seats) * 5 }));
    return orders.get(key);
  };

  async function card(id, me, organizerRole, block) {
    const k = contract();
    const a = await k.getAssembly(id);
    const doc = await readDoc(state.config, state.provider, a.ref);
    const report = a.reportRef ? await readDoc(state.config, state.provider, a.reportRef) : null;
    const drawn = a.seed !== ethers.ZeroHash;
    const mine = me && a.organizer.toLowerCase() === me.toLowerCase();
    const seconds = Number(state.config.blockSeconds || 2);
    let drawLine;
    if (drawn) drawLine = `<strong>Drawn.</strong> ${Number(a.filled)} of ${Number(a.seats)} seats accepted.`;
    else if (block <= Number(a.drawBlock)) drawLine = `The draw happens in about ${Math.max(1, Math.round(((Number(a.drawBlock) - block + 1) * seconds) / 60))} minute(s), from a block hash nobody knows yet.`;
    else drawLine = 'Ready to draw: anyone with an account can run it.';

    // Was I drawn? Only this phone knows its voter code is mine.
    let you = '';
    if (drawn && state.identity) {
      const order = await orderOf(id, a).catch(() => []);
      const pos = order.find((o) => o.commitment === BigInt(state.identity.commitment));
      if (pos) {
        const confirmed = await k.seated(id, pos.position).catch(() => false);
        you = confirmed
          ? '<p class="ok"><strong>You have a seat on this assembly.</strong> The organizer will contact you through the details you gave them.</p>'
          : `<div class="card stack"><p><strong>🎉 You were drawn</strong> (number ${pos.position + 1} in line${pos.position >= Number(a.seats) ? ', after the first choices: a seat is yours if someone ahead of you declines' : ''}).</p>
            <p>To take your seat, give the organizer your seat code, with how to reach you. It proves you were drawn without showing your vote or anything else. If you can't serve, do nothing: the seat passes to the next person.</p>
            <button type="button" data-seat="${id}" data-pos="${pos.position}">Show my seat code</button><div data-seat-code hidden></div></div>`;
      }
    }
    // A seated member endorses the draft statement with a code signed by their voter key.
    let endorse = '';
    if (report?.stage === 'draft' && state.identity) {
      const order = await orderOf(id, a).catch(() => []);
      const pos = order.find((o) => o.commitment === BigInt(state.identity.commitment));
      if (pos && (await k.seated(id, pos.position).catch(() => false))) {
        endorse = `<div class="card stack"><p>If you agree this draft fairly states what the panel concluded, give the organizer your endorsement code. It is published with the final statement, so anyone can check how many members agreed.</p>
          <button type="button" data-endorse="${pos.position}" data-ref="${esc(a.reportRef)}">Endorse this draft</button><div data-endorse-code hidden></div></div>`;
      }
    }
    const order = drawn ? `<details data-order="${id}"><summary>Check the draw</summary><div class="stack"><p class="note">Redone on this device from the public seed, the same way for everyone: anyone can check that nobody chose who was drawn. The list shows voter codes, not names.</p><div data-order-list>Loading…</div></div></details>` : '';
    const organizer = mine
      ? `<details class="card"><summary><strong>Organizer</strong></summary><div class="stack">
          ${!drawn && block > Number(a.drawBlock) ? '<button type="button" class="primary" data-draw>Run the draw</button> <button type="button" data-reschedule>Set a new draw block</button>' : ''}
          ${drawn ? `<label>Seat code from a drawn resident <input type="text" data-code autocomplete="off" spellcheck="false" placeholder="PA1.…" /></label><button type="button" data-accept>Check and confirm the seat</button>` : ''}
          ${drawn ? `<p><strong>The statement</strong> (written with the panel; published as a draft first, so seated members can endorse it)</p>
            <label>${doc.reviewOf ? 'What the panel found, in a sentence or two' : 'The recommendation'} <textarea data-rep-title rows="2"></textarea></label>
            <label>Strongest reasons for (one per line) <textarea data-rep-for rows="3"></textarea></label>
            <label>Strongest reasons against (one per line) <textarea data-rep-against rows="3"></textarea></label>
            <button type="button" data-publish>Publish the draft for endorsement</button>` : ''}
          ${report?.stage === 'draft' ? `<label>Endorsement codes from seated members (one per line) <textarea data-endorsements rows="3" spellcheck="false"></textarea></label><button type="button" class="primary" data-final>Check them and publish the final statement</button>` : ''}
          <p class="status" role="status" data-org-status></p></div></details>`
      : !drawn && block > Number(a.drawBlock) && me ? '<button type="button" data-draw>Run the draw</button> <p class="status" role="status" data-org-status></p>' : '';
    const el = document.createElement('article');
    el.className = 'card stack';
    el.innerHTML = `<p class="eyebrow">Citizens' assembly ${id} · ${Number(a.seats)} seats · drawn from ${LISTS[Number(a.tier)]} (${Number(a.size)} on the list)</p>
      <h3>${esc(doc.title)}</h3>${doc.body ? `<p>${esc(doc.body)}</p>` : ''}
      <p>${drawLine}</p>${you}${order}
      ${await statementHtml(id, a, report, Boolean(doc.reviewOf))}${endorse}
      ${organizer}`;
    wireCard(el, id, a);
    return el;
  }

  function wireCard(el, id, a) {
    const st = () => el.querySelector('[data-org-status]');
    el.querySelector('[data-seat]')?.addEventListener('click', async (ev) => {
      const box = el.querySelector('[data-seat-code]');
      const net = await state.provider.getNetwork();
      const code = acceptCode(state.identity, { chainId: net.chainId, address: at(), id: BigInt(id), position: Number(ev.target.dataset.pos) });
      box.innerHTML = `<p class="addr">${esc(code)}</p><button type="button" data-copy>Copy</button>`;
      box.hidden = false;
      box.querySelector('[data-copy]').onclick = () => navigator.clipboard?.writeText(code);
    });
    const det = el.querySelector('[data-order]');
    det?.addEventListener('toggle', async () => {
      if (!det.open) return;
      const order = await orderOf(id, a).catch(() => null);
      const list = det.querySelector('[data-order-list]');
      if (!order) return void (list.textContent = 'Could not load the voter list.');
      const seated = await Promise.all(order.map((o) => contract().seated(id, o.position).catch(() => false)));
      list.innerHTML = `<ol class="list">${order.map((o, i) => `<li><span class="addr">${esc(String(o.commitment).slice(0, 10))}…</span>${seated[i] ? ' · <strong>seat accepted</strong>' : ''}${i === Number(a.seats) - 1 ? '<br><span class="muted">— first choices above, next in line below —</span>' : ''}</li>`).join('')}</ol>
        <p class="note">Seed ${esc(a.seed.slice(0, 18))}…, from block ${esc(String(a.drawBlock))}.</p>`;
    });
    el.querySelector('[data-draw]')?.addEventListener('click', async () => (await send(st(), 'Run the draw', (k) => k.draw(id))) && render());
    el.querySelector('[data-reschedule]')?.addEventListener('click', async () => (await send(st(), 'Set a new draw block', (k) => k.reschedule(id))) && render());
    el.querySelector('[data-accept]')?.addEventListener('click', async () => {
      const net = await state.provider.getNetwork();
      const order = await orderOf(id, a);
      const r = checkAcceptCode(el.querySelector('[data-code]').value, { chainId: net.chainId, address: at(), order });
      if (!r.ok) return status(st(), r.reason, 'error');
      if (r.id !== BigInt(id)) return status(st(), 'This seat code is for a different assembly.', 'error');
      if ((await send(st(), `Confirm seat ${r.position + 1}`, (k) => k.acceptSeat(id, r.position)))) render();
    });
    const lines = (sel) => el.querySelector(sel).value.split('\n').map((x) => x.trim()).filter(Boolean);
    el.querySelector('[data-publish]')?.addEventListener('click', async () => {
      const title = el.querySelector('[data-rep-title]').value.trim();
      if (!title) return status(st(), 'Write what the panel found first.', 'error');
      try {
        status(st(), 'Publishing the draft…');
        const ref = await publish({ title, for: lines('[data-rep-for]'), against: lines('[data-rep-against]'), stage: 'draft', assembly: String(id) });
        if (await send(st(), 'Publish the draft', (k) => k.report(id, ref))) render();
      } catch (e) {
        status(st(), e.message, 'error');
      }
    });
    el.querySelector('[data-endorse]')?.addEventListener('click', async (ev) => {
      const box = el.querySelector('[data-endorse-code]');
      const net = await state.provider.getNetwork();
      const code = endorseCode(state.identity, { chainId: net.chainId, address: at(), id: BigInt(id), position: Number(ev.target.dataset.endorse), ref: ev.target.dataset.ref });
      box.innerHTML = `<p class="addr">${esc(code)}</p><button type="button" data-copy>Copy</button>`;
      box.hidden = false;
      box.querySelector('[data-copy]').onclick = () => navigator.clipboard?.writeText(code);
    });
    el.querySelector('[data-final]')?.addEventListener('click', async () => {
      try {
        const draft = await readDoc(state.config, state.provider, a.reportRef);
        const codes = lines('[data-endorsements]');
        const n = await verified(id, a, { ...draft, draft: a.reportRef, endorsements: codes });
        if (!n) return status(st(), 'None of these codes is a valid endorsement of this draft by a seated member.', 'error');
        if (n < codes.length && !window.confirm(`${codes.length - n} of the codes could not be checked (not from a seated member, or for another text). Publish with the ${n} that check out?`)) return;
        status(st(), 'Publishing the final statement…');
        const ref = await publish({ ...draft, stage: 'final', draft: a.reportRef, endorsements: codes });
        if (await send(st(), 'Publish the final statement', (k) => k.report(id, ref))) render();
      } catch (e) {
        status(st(), e.message, 'error');
      }
    });
  }

  async function render() {
    const list = $('assembly-list');
    if (!list || !at()) return;
    const k = contract();
    const me = ctx.activeAddress?.() || null;
    const [n, block, organizerRole] = await Promise.all([k.assemblyCount(), state.provider.getBlockNumber(), me ? k.hasRole(ethers.id('ORGANIZER_ROLE'), me).catch(() => false) : false]);
    $('assembly-new').hidden = !organizerRole;
    const ids = [];
    for (let i = Number(n); i >= 1 && ids.length < 20; i--) ids.push(i);
    const cards = await Promise.all(ids.map((id) => card(id, me, organizerRole, block).catch(() => null)));
    list.replaceChildren(...cards.filter(Boolean));
    if (!ids.length) list.innerHTML = '<p class="muted">No assemblies yet.</p>';
  }

  $('btn-assembly')?.addEventListener('click', async () => {
    const el = $('assembly-status');
    const title = $('assembly-title').value.trim();
    const seats = Number($('assembly-seats').value);
    const minutes = Number($('assembly-wait').value);
    if (!title) return status(el, 'Write the question the assembly will study.', 'error');
    if (!(seats >= 1 && seats <= 500)) return status(el, 'Seats: 1 to 500.', 'error');
    try {
      status(el, 'Publishing the question…');
      const review = Number($('assembly-review')?.value || 0);
      const ref = await publish({ title, body: $('assembly-body').value.trim(), ...(review > 0 ? { reviewOf: { poll: review } } : {}) });
      const waitBlocks = Math.max(30, Math.round((minutes * 60) / Number(state.config.blockSeconds || 2)));
      if (await send(el, 'Announce the draw', (k) => k.announce(Number($('assembly-tier').value), seats, waitBlocks, ref))) {
        $('assembly-title').value = '';
        $('assembly-body').value = '';
        render();
      }
    } catch (e) {
      status(el, e.message, 'error');
    }
  });

  /** On a poll card: the review panel's statement for this poll, if there is one. */
  const reviews = new Map();
  async function renderReview(box, pollId) {
    if (!box || !at()) return;
    const k = contract();
    const n = Number(await k.assemblyCount());
    for (let id = n; id >= Math.max(1, n - 29); id--) {
      if (!reviews.has(id)) {
        const a = await k.getAssembly(id);
        reviews.set(id, { a, doc: await readDoc(state.config, state.provider, a.ref).catch(() => ({})) });
      }
      const { doc } = reviews.get(id);
      if (Number(doc.reviewOf?.poll) !== Number(pollId)) continue;
      const a = await k.getAssembly(id); // its statement may be newer than the cache
      if (!a.reportRef) {
        box.innerHTML = `<p class="note">A citizens' review panel (${Number(a.seats)} residents drawn at random) is studying this question; its statement will appear here.</p>`;
        return;
      }
      const report = await readDoc(state.config, state.provider, a.reportRef);
      box.innerHTML = (await statementHtml(id, a, report, true)).replace('Citizens\' review panel', `Citizens' review panel: ${Number(a.filled)} residents drawn at random heard both sides`);
      return;
    }
  }

  return { renderReview: (box, id) => renderReview(box, id).catch(() => {}), render: () => render().catch((e) => ($('assembly-list').innerHTML = `<p class="error">Could not load: ${esc(e.shortMessage || e.message)}</p>`)), available: () => Boolean(at()) };
}
