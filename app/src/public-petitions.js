/**
 * app/src/public-petitions.js - petitions to deliver outside Promissa (PublicPetitions.sol,
 * client/petitions.js): to a city clerk, a legislature, a board or a company.
 *
 *   Sign by name       a resident on the voter list signs under their own name and place,
 *                      once; their name is public and goes to the recipient.
 *   Paper sheets       where the law wants ink: a circulator files each signed sheet's photo
 *                      fingerprint (the photo itself stays with the organizer: it shows
 *                      people's handwriting and addresses), its count and their statement,
 *                      optionally with the Testimonia seal made when it was photographed.
 *   Custody            each person who receives a sheet records it, checking the photo.
 *   Check and deliver  everything re-read from the chain and checked; a printable packet,
 *                      a spreadsheet, and a link the recipient can open to check it themselves.
 */

import { ethers } from 'ethers';
import { PETITIONS_ABI, CONSENT, petitionText, signatureText, sheetText, custodyText, signProof, sheetProof, custodyProof, checkPetition, packetCsv, readRef } from '../../client/petitions.js';
import { readSeal } from './testimonia.js';

const TIER_WHO = ['members', 'ID-checked residents', 'residents with full voting rights'];
const BOARD_ABI = ['function read(bytes32) view returns (string)'];
const when = (secs) => new Date(Number(secs) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const sha256 = async (bytes) => '0x' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

/** @param {object} ctx { state, $, status, esc, myTier } */
export function wirePublicPetitions(ctx) {
  const { state, $, status, esc } = ctx;
  const contract = () => (state.config.petitionsAddress ? new ethers.Contract(state.config.petitionsAddress, PETITIONS_ABI, state.provider) : null);
  const board = () => new ethers.Contract(state.config.noticeBoardAddress, BOARD_ABI, state.provider);

  /** POST to the first relayer that answers. */
  async function relay(path, body) {
    let last = 'No relayer is configured.';
    for (const url of state.config.relayers || []) {
      try {
        const res = await fetch(`${url.replace(/\/+$/, '')}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) });
        const out = await res.json().catch(() => ({}));
        if (res.ok) return out;
        last = { NullifierUsed: 'You have already done this.', PhotoAlreadyFiled: 'That photo has already been filed.', InvalidProof: 'Your voter list changed a moment ago; please try again.', WrongMessage: 'Something changed while signing; please try again.' }[out.error] || out.message || out.error || `relayer answered ${res.status}`;
        if (res.status < 500) break;
      } catch (e) {
        last = e.message;
      }
    }
    throw new Error(last);
  }
  const publish = async (doc) => (await relay('/notice', { text: JSON.stringify(doc) })).ref;
  const needKey = () => {
    if (!state.identity) throw new Error('Unlock your voter key first (Account).');
  };

  async function render() {
    const box = $('ppetition-list');
    if (!box) return;
    const pp = contract();
    $('ppetition-section').hidden = !pp;
    if (!pp) return;
    const n = Number(await pp.petitionCount());
    if (!n) return (box.innerHTML = '<p class="muted">No petitions to deliver yet.</p>');
    const ids = Array.from({ length: Math.min(n, 30) }, (_, i) => n - i);
    const cards = [];
    for (const id of ids) {
      const p = await pp.getPetition(id);
      const doc = (await readRef(board(), p.ref)).doc || {};
      cards.push(`<article class="card stack" id="ppetition-${id}">
        <p class="eyebrow"><span>Petition to deliver ${id}</span> · <span>started</span> ${esc(when(p.createdAt))} · <span>signed by name by ${esc(TIER_WHO[Number(p.tier)])}</span></p>
        <h3>${esc(doc.title || '(untitled)')}</h3>
        <p><span>To:</span> <strong>${esc(doc.recipient || '')}</strong></p>
        ${doc.body ? `<p>${esc(doc.body)}</p>` : ''}
        <p class="muted"><span>${Number(p.named)} named signature${Number(p.named) === 1 ? '' : 's'}</span>${doc.paper || Number(p.sheets) ? ` · <span>${Number(p.sheets)} paper sheet${Number(p.sheets) === 1 ? '' : 's'}, ${Number(p.paperSignatures)} signature${Number(p.paperSignatures) === 1 ? '' : 's'} on them (as their circulators counted)</span>` : ''}</p>
        <details><summary>Sign by name</summary><div class="stack">
          <label for="pp-name-${id}">Your full name</label><input type="text" id="pp-name-${id}" autocomplete="name" maxlength="120" />
          <label for="pp-place-${id}">Your city, town or district (not your street address)</label><input type="text" id="pp-place-${id}" maxlength="80" />
          <label class="row"><input type="checkbox" id="pp-consent-${id}" /> <span>${esc(CONSENT)}</span></label>
          <button class="primary" data-pp-sign="${id}">Sign by name</button>
          <p class="note">Your voter key proves, privately, that you're on the voter list and haven't signed this before. Your name is as you type it: the recipient may check it against their own records.</p>
        </div></details>
        ${doc.paper || Number(p.sheets) ? `<details><summary>Paper sheets: file one, or record receiving one</summary><div class="stack">
          <p class="note">Where the law wants signatures on paper. Photograph each signed sheet (ideally with Testimonia, which seals the photo when it's taken). Only the photo's fingerprint is published: the photo stays with you, because it shows people's handwriting and addresses. Hand the sheets themselves to the recipient.</p>
          <label for="pp-photo-${id}">The photo of the sheet</label><input type="file" id="pp-photo-${id}" accept="image/*" />
          <label for="pp-count-${id}">Signatures on the sheet</label><input type="text" id="pp-count-${id}" inputmode="numeric" style="width:100px" />
          <label for="pp-circ-${id}">Circulator’s full name (yours)</label><input type="text" id="pp-circ-${id}" autocomplete="name" maxlength="120" />
          <label for="pp-seal-${id}">Testimonia seal of the photo (optional: paste its link)</label><input type="text" id="pp-seal-${id}" autocomplete="off" spellcheck="false" />
          <button data-pp-sheet="${id}">File the sheet, with my circulator’s statement</button>
          <hr />
          <label for="pp-rsheet-${id}">Receiving a sheet: its number</label><input type="text" id="pp-rsheet-${id}" inputmode="numeric" style="width:100px" />
          <label for="pp-rphoto-${id}">Its photo (to check it’s the sheet that was filed)</label><input type="file" id="pp-rphoto-${id}" accept="image/*" />
          <label for="pp-rname-${id}">Your full name</label><input type="text" id="pp-rname-${id}" autocomplete="name" maxlength="120" />
          <label for="pp-rrole-${id}">Your role (e.g. organizer, county clerk)</label><input type="text" id="pp-rrole-${id}" maxlength="120" />
          <button data-pp-receive="${id}">Record that I received it</button>
        </div></details>` : ''}
        <div class="row"><button data-pp-check="${id}">Check and deliver</button></div>
        <p class="status" role="status"></p>
        <div class="pp-report"></div>
      </article>`);
    }
    box.innerHTML = cards.join('');
    for (const b of box.querySelectorAll('[data-pp-sign]')) b.onclick = () => signByName(Number(b.dataset.ppSign));
    for (const b of box.querySelectorAll('[data-pp-sheet]')) b.onclick = () => fileSheet(Number(b.dataset.ppSheet));
    for (const b of box.querySelectorAll('[data-pp-receive]')) b.onclick = () => receive(Number(b.dataset.ppReceive));
    for (const b of box.querySelectorAll('[data-pp-check]')) b.onclick = () => check(Number(b.dataset.ppCheck));
  }

  const card = (id) => $(`ppetition-${id}`);
  const say = (id, text, kind = '') => status(card(id).querySelector('.status'), text, kind);

  async function start() {
    const el = $('ppetition-status');
    try {
      needKey();
      const doc = petitionText({ title: $('ppetition-title').value, body: $('ppetition-body').value, recipient: $('ppetition-recipient').value, paper: $('ppetition-paper').checked });
      status(el, 'Publishing the petition…');
      const ref = await publish(doc);
      const out = await relay('/petitions', { method: 'create', args: [Number($('ppetition-tier').value), ref] });
      status(el, `Petition to deliver ${out.id} started. Share it so people can sign.`, 'ok');
      for (const k of ['title', 'body', 'recipient']) $(`ppetition-${k}`).value = '';
      await render();
    } catch (e) {
      status(el, e.message, 'error');
    }
  }

  async function signByName(id) {
    try {
      needKey();
      if (!$(`pp-consent-${id}`).checked) throw new Error('Tick the box to agree that your name is published with the petition.');
      const pp = contract();
      const p = await pp.getPetition(id);
      say(id, 'Publishing your signature…');
      const ref = await publish(await signatureText(pp, id, { name: $(`pp-name-${id}`).value, place: $(`pp-place-${id}`).value }));
      say(id, 'Proving you’re on the voter list, privately…');
      const proof = await signProof({ provider: state.provider, petitions: pp, identity: state.identity, tier: Number(p.tier), petitionId: id, ref, artifactsBase: state.config.artifactsBase || undefined });
      await relay('/petitions', { method: 'sign', args: [id, ref], proof });
      await render();
      say(id, 'Signed by name. Thank you.', 'ok');
    } catch (e) {
      say(id, e.message, 'error');
    }
  }

  async function fileSheet(id) {
    try {
      needKey();
      const f = $(`pp-photo-${id}`).files?.[0];
      if (!f) throw new Error('Choose the photo of the sheet.');
      const photo = await sha256(await f.arrayBuffer());
      let testimonia = null;
      const pasted = $(`pp-seal-${id}`).value.trim();
      if (pasted) {
        const s = readSeal(pasted);
        if (s.kind !== 'file' || `0x${s.fileHash}` !== photo) throw new Error('That Testimonia seal is for a different file than this photo.');
        testimonia = { keyId: s.keyId, sealDigest: s.sealDigest, format: s.format }; // identifiers only: check it with Testimonia
      }
      const signatures = Number($(`pp-count-${id}`).value);
      const pp = contract();
      const tier = Math.max(0, await ctx.myTier());
      const doc = await sheetText(pp, id, { photo, signatures, name: $(`pp-circ-${id}`).value, testimonia });
      say(id, 'Publishing the sheet’s record…');
      const ref = await publish(doc);
      say(id, 'Proving you’re on the voter list, privately…');
      const proof = await sheetProof({ provider: state.provider, petitions: pp, identity: state.identity, tier, petitionId: id, photo, signatures, ref, artifactsBase: state.config.artifactsBase || undefined });
      await relay('/petitions', { method: 'sheet', args: [id, photo, signatures, ref, tier], proof });
      await render();
      say(id, `Sheet filed: ${signatures} signature${signatures === 1 ? '' : 's'}. Keep the photo and the sheet; hand the sheet over in person.`, 'ok');
    } catch (e) {
      say(id, e.message, 'error');
    }
  }

  async function receive(id) {
    try {
      needKey();
      const pp = contract();
      const n = Number($(`pp-rsheet-${id}`).value);
      const [sh] = n >= 1 ? await pp.sheets(id, n - 1, 1) : [];
      if (!sh) throw new Error('There is no sheet with that number.');
      const f = $(`pp-rphoto-${id}`).files?.[0];
      if (!f) throw new Error('Choose the sheet’s photo, to check it’s the one that was filed.');
      if ((await sha256(await f.arrayBuffer())) !== sh.photo) throw new Error('That photo isn’t the one filed for this sheet: its fingerprint differs.');
      const tier = Math.max(0, await ctx.myTier());
      const ref = await publish(await custodyText(pp, id, { sheet: n - 1, photo: sh.photo, name: $(`pp-rname-${id}`).value, role: $(`pp-rrole-${id}`).value }));
      say(id, 'Proving you’re on the voter list, privately…');
      const proof = await custodyProof({ provider: state.provider, petitions: pp, identity: state.identity, tier, petitionId: id, sheet: n - 1, ref, artifactsBase: state.config.artifactsBase || undefined });
      await relay('/petitions', { method: 'receive', args: [id, n - 1, ref, tier], proof });
      say(id, `Recorded: you received sheet ${n}.`, 'ok');
    } catch (e) {
      say(id, e.message, 'error');
    }
  }

  /** Check everything from the chain, then offer the packet: print, spreadsheet, check link. */
  async function check(id) {
    const out = card(id).querySelector('.pp-report');
    try {
      say(id, 'Checking every signature and sheet on the blockchain…');
      const c = await checkPetition({ petitions: contract(), board: board(), id });
      say(id, c.ok ? 'Everything checks.' : 'Problems found: see below.', c.ok ? 'ok' : 'error');
      const link = `${location.origin}${location.pathname}#ppetition-${id}`;
      out.innerHTML = `<div class="stack">
        ${c.problems.length ? `<ul class="error">${c.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
        <p><strong>${c.totals.named}</strong> <span>named signature${c.totals.named === 1 ? '' : 's'}, each by a different person on the voter list</span>${c.totals.sameName ? ` <span>(${c.totals.sameName} name${c.totals.sameName === 1 ? '' : 's'} appear more than once: different people, or worth a look)</span>` : ''}${c.totals.sheets ? `; <strong>${c.totals.sheets}</strong> <span>paper sheet${c.totals.sheets === 1 ? '' : 's'} with</span> <strong>${c.totals.paperSignatures}</strong> <span>signatures, as their circulators counted (the recipient counts the sheets themselves)</span>` : ''}.</p>
        <div class="row"><button data-pp-print>Print the delivery packet</button> <button data-pp-csv>Download the list (CSV)</button> <button data-pp-json>Download everything (JSON)</button> <button data-pp-link>Copy the check link</button></div>
        <p class="note">Electronic signatures count for a petition only where the recipient or the law accepts them. The check link lets the recipient check the count on the blockchain themselves.</p>
      </div>`;
      const save = (name, text, type) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type }));
        a.download = name;
        a.click();
      };
      out.querySelector('[data-pp-csv]').onclick = () => save(`petition-${id}-signatures.csv`, packetCsv(c), 'text/csv');
      out.querySelector('[data-pp-json]').onclick = () => save(`petition-${id}.json`, JSON.stringify(c, null, 2), 'application/json');
      out.querySelector('[data-pp-link]').onclick = () => navigator.clipboard?.writeText(link).then(() => say(id, 'Check link copied.', 'ok'));
      out.querySelector('[data-pp-print]').onclick = () => printPacket(c, link);
    } catch (e) {
      say(id, e.message, 'error');
    }
  }

  /** A printable delivery packet (the browser's Print, or Save as PDF). */
  function printPacket(c, link) {
    const w = window.open('', '_blank');
    if (!w) return;
    const rows = c.named.map((s) => `<tr><td>${s.n}</td><td>${esc(s.name)}</td><td>${esc(s.place)}</td><td>${esc(when(s.at))}</td></tr>`).join('');
    const sheets = c.sheets.map((s) => `<tr><td>${s.n}</td><td>${s.signatures}</td><td>${esc(s.circulator)}</td><td class="mono">${esc(s.photo)}</td><td>${s.custody.map((h) => `${esc(h.name)}${h.role ? ` (${esc(h.role)})` : ''}, ${esc(when(h.at))}`).join('<br>') || '—'}</td></tr>`).join('');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Petition ${c.petition.id}: ${esc(c.petition.title || '')}</title>
      <style>body{font:14px/1.45 system-ui,sans-serif;margin:2rem;color:#111}table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top}.mono{font-family:monospace;font-size:11px;word-break:break-all}.note{color:#444;font-size:12px}</style>
      <h1>${esc(c.petition.title || '')}</h1>
      <p><strong>To:</strong> ${esc(c.petition.recipient || '')}</p>
      ${c.petition.body ? `<p>${esc(c.petition.body)}</p>` : ''}
      <p><strong>${c.totals.named}</strong> named signatures${c.totals.sheets ? `, and <strong>${c.totals.sheets}</strong> paper sheets with <strong>${c.totals.paperSignatures}</strong> signatures (as their circulators counted; the sheets are delivered with this packet)` : ''}. ${c.ok ? 'Checked on the blockchain: every record matches.' : `Problems: ${esc(c.problems.join('; '))}`}</p>
      ${rows ? `<h2>Named signatures</h2><table><tr><th>#</th><th>Name</th><th>Place</th><th>Signed</th></tr>${rows}</table>` : ''}
      ${sheets ? `<h2>Paper sheets</h2><table><tr><th>#</th><th>Signatures</th><th>Circulator</th><th>Photo fingerprint (SHA-256)</th><th>Received by</th></tr>${sheets}</table>` : ''}
      <p class="note">How to check: open ${esc(link)}, choose “Check and deliver”. Each named signature was made by a different person on the community's voter list (an anonymous proof, recorded on the Base blockchain); the names are as each person wrote them. Each paper sheet's photo fingerprint was recorded when it was filed, with the circulator's statement; a sheet whose photo doesn't match was changed. Petition ${c.petition.id}, contract ${esc(c.petition.contract)}, chain ${c.petition.chainId}. Electronic signatures count only where the recipient or the law accepts them.</p>`);
    w.document.close();
    w.print();
  }

  $('btn-ppetition')?.addEventListener('click', start);
  return { render };
}
