/**
 * app/src/attach.js - add photos and documents to petitions, comments, agenda items, drafts,
 * polls and mandate evidence, from a phone:
 *
 *   📷 Take a photo     the camera
 *   🖼 Photo or file    the photo library or Files (PDF)
 *   📄 Scan a document  photograph pages one by one; they are straightened up for reading
 *                       (black on white) and joined into one PDF
 *
 * Before upload, photos are shrunk and re-saved, which removes hidden data such as where a
 * photo was taken. Each file is stored on IPFS; its fingerprint (SHA-256 and IPFS content ID)
 * goes into the published document, so anyone can check it later. Optionally, AI reads the
 * file: its text, a summary, a description for screen readers, and a warning if it shows
 * private details.
 */

import { uploadProof, sha256Hex } from '../../client/uploads.js';
import { lookOfFile, sameLook } from './look.js';

const MAX_SIDE = 2000;
const gateway = (cfg) => String(cfg.ipfsGateway || 'https://gateway.pinata.cloud').replace(/\/+$/, '');
const fileUrl = (cfg, cid) => `${gateway(cfg)}/ipfs/${cid}`;
/** Promissa Plus token (the assistant's own key, never the voter key): more files, bigger audio. */
const plan = () => {
  try {
    return sessionStorage.getItem('mandate.assistant.token') || '';
  } catch {
    return '';
  }
};
/**
 * Every address a file can be fetched from: its listed locations (IPFS, cloud storage), then its
 * content ID. A file is identified by its SHA-256, so any copy that hashes right is the file.
 */
const CID = /^[a-zA-Z0-9]{20,100}$/;
function fileUrls(cfg, a) {
  const urls = [];
  for (const l of Array.isArray(a.locations) ? a.locations : []) {
    if (l?.kind === 'ipfs' && CID.test(String(l.cid))) urls.push(fileUrl(cfg, l.cid));
    else if (l?.kind === 's3' && /^https:\/\/[^\s"'<>]+$/.test(String(l.url))) urls.push(l.url);
  }
  if (CID.test(String(a.cid)) && !urls.includes(fileUrl(cfg, a.cid))) urls.push(fileUrl(cfg, a.cid));
  return urls;
}

let service = null;
/** Whether this deployment accepts files (and can read them with AI), and what was taken down. */
export async function uploadService(cfg) {
  if (service) return service;
  if (!cfg.identityService) return (service = { enabled: false, ai: false, blocked: new Set() });
  try {
    const r = await (await fetch(`${cfg.identityService.replace(/\/+$/, '')}/upload/blocked`)).json();
    service = { enabled: !!r.enabled, ai: !!r.ai, blocked: new Set(r.blocked || []) };
  } catch {
    service = { enabled: false, ai: false, blocked: new Set() };
  }
  return service;
}

// ------------------------------------------------------------ preparing files

const loadImage = (file) =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('This photo could not be opened. Try a JPEG or PNG.'));
    img.src = url;
  });

/** Shrink and re-save as JPEG (drops location and other hidden data); `scan` cleans up a page photo. */
async function prepareImage(file, { scan = false } = {}) {
  const img = await loadImage(file);
  const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, c.width, c.height);
  if (scan) {
    // Grey, then stretch contrast so ink is dark and paper is white.
    const d = g.getImageData(0, 0, c.width, c.height);
    const px = d.data;
    let lo = 255;
    let hi = 0;
    for (let i = 0; i < px.length; i += 16) {
      const v = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < px.length; i += 4) {
      let v = ((0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] - lo) / span) * 255;
      v = v > 200 ? 255 : v < 60 ? 0 : v;
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    g.putImageData(d, 0, 0);
  }
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', scan ? 0.8 : 0.85));
  // How it looks, for matching copies seen elsewhere (look.js), from the picture as uploaded.
  const look = scan ? null : await lookOfFile(blob);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg', width: c.width, height: c.height, look };
}

/** Scanned pages (JPEG) joined into one PDF. */
async function pagesToPdf(pages) {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (const p of pages) {
    const img = await pdf.embedJpg(p.bytes);
    const page = pdf.addPage([p.width, p.height]);
    page.drawImage(img, { x: 0, y: 0, width: p.width, height: p.height });
  }
  pdf.setProducer('Promissa');
  pdf.setCreator('Promissa');
  return new Uint8Array(await pdf.save());
}

// ------------------------------------------------------------------- upload

async function send(ctx, bytes, type, name, read) {
  const { state } = ctx;
  if (!state.identity) throw new Error('Unlock your voter key to add files.');
  const base = state.config.identityService.replace(/\/+$/, '');
  const day = new Date().toISOString().slice(0, 10);
  const key = `mandate.uploadSlot.${day}`;
  let slot = 0;
  try {
    slot = Number(localStorage.getItem(key) || 0);
  } catch {
    /* start at 0 */
  }
  for (let tries = 0; tries < 10; tries++, slot++) {
    const proof = await uploadProof({ provider: state.provider, identityAddress: state.config.identityAddress, identity: state.identity, bytes, slot, day, artifactsBase: state.config.artifactsBase || undefined });
    const res = await fetch(`${base}/upload${read ? '?read=1' : ''}`, { method: 'POST', headers: { 'Content-Type': type, 'X-Upload-Proof': proof, 'X-File-Name': name, ...(plan() ? { 'X-Promissa-Plan': plan() } : {}) }, body: bytes });
    const out = await res.json().catch(() => ({}));
    if (res.ok) {
      try {
        localStorage.setItem(key, String(slot + 1));
      } catch {
        /* fine */
      }
      return out;
    }
    if (!/slot was already used/.test(out.error || '')) throw new Error(out.error || `Upload failed (${res.status}).`);
  }
  throw new Error('Daily upload limit reached. Please try again tomorrow.');
}

// Audio: what the upload service accepts (it checks the file's first bytes too).
const AUDIO_MAX = 25 * 1024 * 1024;
export function audioType(t) {
  const x = String(t || '').toLowerCase();
  if (/webm/.test(x)) return 'audio/webm';
  if (/mpeg|mp3/.test(x)) return 'audio/mpeg';
  if (/mp4|m4a|aac/.test(x)) return 'audio/mp4';
  if (/ogg|oga|opus/.test(x)) return 'audio/ogg';
  if (/wav/.test(x)) return 'audio/wav';
  return 'audio/webm';
}

// ------------------------------------------------------------------ picker UI

/**
 * Put the picker into `box`; returns { list(): attachments for the document, clear() }.
 * @param {{ state, esc }} ctx
 */
export function attachPicker(box, ctx) {
  const { state, esc } = ctx;
  const files = [];
  let pages = [];
  let inflight = 0;
  box.classList.add('attach', 'stack');
  box.innerHTML = '<p class="muted">Checking whether files can be added…</p>';
  const draw = (note = '') => {
    if (!service?.enabled) return (box.innerHTML = '');
    box.innerHTML = `<div class="row attach-buttons">
        <label class="button">📷 Take a photo<input type="file" accept="image/*" capture="environment" data-pick="camera" hidden /></label>
        <label class="button">🖼 Photo or file<input type="file" accept="image/*,application/pdf,audio/*" multiple data-pick="library" hidden /></label>
        ${typeof MediaRecorder !== 'undefined' ? `<button type="button" data-record>${recorder ? '⏹ Stop recording' : '🎙 Record audio'}</button>` : ''}
        <label class="button">📄 Scan a document<input type="file" accept="image/*" capture="environment" data-pick="scan" hidden /></label>
      </div>
      ${pages.length ? `<p class="note">${pages.length} page${pages.length === 1 ? '' : 's'} scanned. <label class="button">Add a page<input type="file" accept="image/*" capture="environment" data-pick="scan" hidden /></label> <button type="button" data-done>Done: make the PDF</button></p>` : ''}
      ${service.ai ? '<label class="row"><input type="checkbox" data-ai checked /> AI reads it: the text, a short summary, a description for screen readers, and a check for private details</label>' : ''}
      <p class="note">Files are public and permanent. Photos are shrunk and their hidden location data removed. Don't include anyone's private details.</p>
      <ul class="list attach-list">${files.map((f, i) => `<li>${f.type.startsWith('image/') ? `<img src="${esc(f.preview)}" alt="" class="attach-thumb" />` : f.type.startsWith('audio/') ? '🎙' : '📄'} <strong>${esc(f.name)}</strong> · ${Math.round(f.size / 1024)} KB${f.ai?.personal_info ? `<p class="warn">▲ AI noticed private details: ${esc(f.ai.personal_info_note || 'please check')}. Remove the file if they should not be public.</p>` : ''}
          ${f.type.startsWith('audio/') ? `<label>What it says: a short summary or a transcript (for people who can't listen) <textarea data-transcript="${i}" rows="2" maxlength="8000">${esc(f.transcript || '')}</textarea></label>` : `<label>Description for screen readers <input type="text" data-alt="${i}" value="${esc(f.alt || '')}" maxlength="300" /></label>`}
          <details><summary>Testimonia seal (optional)</summary><label>Seal code <input type="text" data-seal="${i}" value="${esc(f.seal || '')}" spellcheck="false" /></label></details>
          ${f.ai?.summary ? `<p class="note">AI summary: ${esc(f.ai.summary)}</p>` : ''}
          <button type="button" data-remove="${i}">Remove</button></li>`).join('')}</ul>
      <p class="status" role="status">${esc(note)}</p>`;
    for (const input of box.querySelectorAll('[data-pick]')) input.onchange = () => pick(input.dataset.pick, [...input.files]);
    for (const b of box.querySelectorAll('[data-remove]')) b.onclick = () => (files.splice(Number(b.dataset.remove), 1), draw());
    for (const a of box.querySelectorAll('[data-alt]')) a.oninput = () => (files[Number(a.dataset.alt)].alt = a.value);
    for (const a of box.querySelectorAll('[data-transcript]')) a.oninput = () => (files[Number(a.dataset.transcript)].transcript = a.value);
    for (const a of box.querySelectorAll('[data-seal]')) a.oninput = () => (files[Number(a.dataset.seal)].seal = a.value.trim());
    const rec = box.querySelector('[data-record]');
    if (rec) rec.onclick = () => (recorder ? stopRecording() : startRecording());
    const done = box.querySelector('[data-done]');
    if (done) done.onclick = () => finishScan();
  };
  const setStatus = (t, kind = '') => {
    const el = box.querySelector('.status');
    if (el) {
      el.textContent = t;
      el.className = `status ${kind}`;
    }
  };
  const readOn = () => !!box.querySelector('[data-ai]')?.checked;

  // Recording on the phone: the browser's own recorder (WebM on most phones, MP4 on iPhone).
  let recorder = null;
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = audioType(recorder.mimeType || chunks[0]?.type || 'audio/webm');
        recorder = null;
        const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
        try {
          if (bytes.length > AUDIO_MAX) throw new Error('Recordings can be up to 25 MB (about 20 minutes).');
          await add(bytes, type, `recording-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${type === 'audio/mp4' ? 'm4a' : 'webm'}`, '');
        } catch (e) {
          setStatus(e.message, 'error');
        }
      };
      recorder.start();
      draw('Recording… tap "Stop recording" when you are done.');
    } catch {
      recorder = null;
      setStatus('The microphone is not available. Allow it in your browser settings, or add an audio file instead.', 'error');
    }
  }
  function stopRecording() {
    recorder?.stop();
  }

  async function add(bytes, type, name, preview, look = null) {
    setStatus(`Adding ${name}: proving you are on the voter list, privately…`);
    inflight++;
    let out;
    try {
      out = await send(ctx, bytes, type, name, readOn());
    } finally {
      inflight--;
    }
    files.push({ ...out, name, preview, alt: out.ai?.alt || '', ...(look ? { look } : {}) });
    draw(out.ai ? `Added ${name}. AI read it: check its description below.` : `Added ${name}.`);
  }

  async function pick(kind, list) {
    try {
      for (const file of list) {
        if (kind === 'scan') {
          setStatus('Cleaning up the page…');
          pages.push(await prepareImage(file, { scan: true }));
          draw('Page added. Add another page, or tap "Done" to make the PDF.');
          continue;
        }
        if (file.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|oga|opus|webm)$/i.test(file.name || '')) {
          if (file.size > AUDIO_MAX) throw new Error('Audio can be up to 25 MB (about 20 minutes of speech). For longer pieces, post them on a platform and add the link.');
          await add(new Uint8Array(await file.arrayBuffer()), audioType(file.type || file.name), file.name || 'audio', '');
        } else if (file.type === 'application/pdf') {
          if (file.size > 10 * 1024 * 1024) throw new Error('PDFs can be up to 10 MB.');
          await add(new Uint8Array(await file.arrayBuffer()), 'application/pdf', file.name, '');
        } else {
          setStatus('Shrinking the photo and removing hidden data…');
          const img = await prepareImage(file);
          await add(img.bytes, img.type, (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', URL.createObjectURL(new Blob([img.bytes], { type: img.type })), img.look);
        }
      }
    } catch (e) {
      setStatus(e.message, 'error');
    }
  }

  async function finishScan() {
    try {
      setStatus('Making the PDF…');
      const pdf = await pagesToPdf(pages);
      const n = pages.length;
      pages = [];
      await add(pdf, 'application/pdf', `scan-${n}-page${n === 1 ? '' : 's'}.pdf`, '');
    } catch (e) {
      setStatus(e.message, 'error');
    }
  }

  uploadService(state.config).then(() => draw());
  return {
    /** For the published document: what each file is, and its fingerprint. */
    list: () => {
      if (inflight || pages.length) throw new Error(pages.length ? 'Finish the scan first: tap "Done: make the PDF".' : 'Files are still being added: wait a moment, then try again.');
      return files.map((f) => ({
        ...(f.cid ? { cid: f.cid } : {}), sha256: f.sha256, type: f.type, size: f.size, name: f.name, ...(Array.isArray(f.locations) ? { locations: f.locations } : {}), alt: String(f.alt || '').slice(0, 300), ...(f.look ? { look: f.look } : {}),
        ...(f.transcript ? { transcript: String(f.transcript).slice(0, 8000) } : {}),
        ...(f.seal ? { seal: { by: 'testimonia', code: String(f.seal).slice(0, 4000) } } : {}),
        ...(f.ai ? { ai: { summary: f.ai.summary, text: String(f.ai.text || '').slice(0, 8000), kind: f.ai.kind, model: f.ai.model, label: f.ai.label } } : {}),
      }));
    },
    clear: () => {
      files.length = 0;
      pages = [];
      draw();
    },
  };
}

// ------------------------------------------------------------------ showing

/** A document's attachments as HTML; call wireAttachments(box) after inserting it. */
export function attachmentsHtml(cfg, doc, esc) {
  const list = Array.isArray(doc?.attachments) ? doc.attachments.filter((a) => a && fileUrls(cfg, a).length) : [];
  if (!list.length) return '';
  const blocked = service?.blocked || new Set();
  return `<div class="attachments">${list
    .map((a) => {
      if (blocked.has(a.cid) || blocked.has(String(a.sha256 || '').toLowerCase())) return `<p class="muted">A file here was taken down. Its fingerprint stays on the record${a.sha256 ? ` (SHA-256 ${esc(String(a.sha256).slice(0, 12))}…)` : ''}.</p>`;
      const urls = fileUrls(cfg, a);
      const url = urls[0];
      const img = /^image\//.test(a.type);
      const audio = /^audio\//.test(a.type);
      const media = img
        ? `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="${esc(a.alt || a.name || 'Attached photo')}" loading="lazy" /></a><a class="link" href="${esc(url)}" download="${esc(a.name || 'image.jpg')}" target="_blank" rel="noopener">Download full size (to print or share)</a>`
        : audio
          ? `<p>🎙 <strong>${esc(a.name || 'Audio')}</strong></p><audio controls preload="none" src="${esc(url)}" style="width:100%"></audio>${a.transcript ? `<details><summary>What it says (written by the person who added it)</summary><p>${esc(a.transcript)}</p></details>` : ''}`
          : `<a class="button" href="${esc(url)}" target="_blank" rel="noopener">📄 ${esc(a.name || 'Document')} (PDF)</a>`;
      return `<figure class="attachment">
        ${media}
        <figcaption>${a.alt ? esc(a.alt) : ''}
          ${a.seal ? '<span class="chip">Testimonia seal: verification opens when Testimonia launches</span>' : ''}
          ${a.ai?.summary || a.ai?.text ? `<details><summary>What AI read in it (check the original)</summary>${a.ai.summary ? `<p>${esc(a.ai.summary)}</p>` : ''}${a.ai.text ? `<pre class="ai-text">${esc(a.ai.text)}</pre>` : ''}</details>` : ''}
          <button type="button" class="link" data-check="${esc(JSON.stringify(urls))}" data-sha="${esc(a.sha256 || '')}">Check it is unchanged</button>${urls.length > 1 ? ` <span class="muted">(${urls.length} copies)</span>` : ''} <span class="check-result" role="status"></span>
          ${img && a.look ? `<label class="link">Compare a copy you saw elsewhere<input type="file" accept="image/*" data-compare="${esc(JSON.stringify(a.look))}" hidden /></label> <span class="check-result" role="status"></span>` : ''}
        </figcaption></figure>`;
    })
    .join('')}</div>`;
}

/** Fingerprint checks: download the file and compare it with the fingerprint on the record. */
export function wireAttachments(root, cfg) {
  // A copy seen elsewhere (a site, a chat): compared by its look with the photo on the record.
  for (const input of root.querySelectorAll('[data-compare]')) {
    input.onchange = async () => {
      const out = input.parentElement.nextElementSibling;
      const f = input.files[0];
      if (!f) return;
      out.textContent = 'Comparing…';
      let sealed = null;
      try {
        sealed = JSON.parse(input.dataset.compare);
      } catch {}
      const m = sameLook(sealed, await lookOfFile(f));
      out.textContent = m.match ? '✓ Looks the same as this photo: probably a copy of it (re-compressed or resized). This is a visual match, not proof; small edits may not show. The original above is the one on the record.' : `▲ Doesn't look like this photo: ${m.reason}.`;
      out.className = `check-result ${m.match ? 'ok' : 'error'}`;
    };
  }
  for (const b of root.querySelectorAll('[data-check]')) {
    b.onclick = async () => {
      const out = b.nextElementSibling;
      out.textContent = 'Checking…';
      try {
        // Every copy is checked against the one fingerprint on the record.
        let urls = [];
        try {
          urls = JSON.parse(b.dataset.check);
        } catch {
          urls = [fileUrl(cfg, b.dataset.check)];
        }
        const results = [];
        for (const u of urls) {
          try {
            const bytes = new Uint8Array(await (await fetch(u)).arrayBuffer());
            results.push((await sha256Hex(bytes)) === b.dataset.sha);
          } catch {
            results.push(null);
          }
        }
        const good = results.filter((r) => r === true).length;
        const bad = results.filter((r) => r === false).length;
        if (!good && !bad) throw new Error('unreachable');
        out.textContent = bad ? `▲ ${bad} cop${bad === 1 ? 'y does' : 'ies do'} NOT match the fingerprint${good ? `; ${good} match${good === 1 ? 'es' : ''}` : ''}.` : `✓ Matches its fingerprint on the public record${results.length > 1 ? ` (${good} of ${results.length} copies checked)` : ''}.`;
        out.className = `check-result ${bad ? 'error' : 'ok'}`;
      } catch {
        out.textContent = 'Could not download it to check right now.';
      }
    };
  }
}

