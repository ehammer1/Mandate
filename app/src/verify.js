/**
 * app/src/verify.js - "Is this real?": a public page (verify.html?ref=nb:0x...) that shows a
 * published item exactly as it is recorded on Base: its text, when and by which account it was
 * published, and the fingerprints of its files and videos. Anyone can check a file they were
 * sent against it, on their own device. Sealing recordings is Testimonia's part: files sealed by
 * Testimonia are checked with Testimonia's own checker (config `testimoniaUrl`), not here.
 */
import { startI18n, langSwitchHtml, wireLangSwitch } from './i18n.js';
import { startCounter } from './analytics.js';
import { loadConfig, keepOrgInLinks, withOrg } from './community.js';
import { ethers } from 'ethers';
import { readDoc, isNoticeRef } from './notices.js';
import { locate } from './onbase.js';
import { attachmentsHtml, wireAttachments, uploadService } from './attach.js';
import { videosHtml, wireVideos } from './videos.js';
import { copyBtn, wireCopy } from './copy.js';
import { sameLook, lookOfFile } from './look.js';
import { sha256Hex } from '../../client/uploads.js';
import { testimoniaUrl } from './testimonia.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The Verify page's address for a notice-board reference. */
export const verifyUrl = (ref) => withOrg(new URL(`verify.html?ref=${encodeURIComponent(ref)}`, location.href).href);

/** A reference from a pasted link or reference (verify links, #… item links don't carry one). */
export function refFrom(text) {
  const t = String(text || '').trim();
  if (isNoticeRef(t)) return t;
  try {
    const r = new URL(t).searchParams.get('ref');
    if (isNoticeRef(r)) return r;
  } catch {
    /* not a link */
  }
  const m = t.match(/nb:0x[0-9a-fA-F]{64}/);
  return m ? m[0] : null;
}

/** Compare a file someone has with the files on the record. */
export async function checkFile(file, attachments) {
  const sha = await sha256Hex(new Uint8Array(await file.arrayBuffer()));
  const exact = attachments.find((a) => String(a.sha256 || '').toLowerCase() === sha);
  if (exact) return { kind: 'exact', name: exact.name || 'a file', sha, sealed: !!exact.seal };
  if (/^image\//.test(file.type)) {
    const look = await lookOfFile(file).catch(() => null);
    for (const a of attachments.filter((x) => x.look)) {
      const m = sameLook(a.look, look);
      if (m.match) return { kind: 'look', name: a.name || 'a photo', sha };
    }
  }
  return { kind: 'none', sha };
}

async function render(cfg, provider, ref) {
  const out = document.getElementById('verify');
  const [doc, where] = await Promise.all([readDoc(cfg, provider, ref), locate(cfg, provider, ref).catch(() => null)]);
  if (doc.missing || !where) {
    out.innerHTML = '<p class="warn">▲ This is not on the public record of this community. A real Promissa post is always on Base; if someone sent you this link as proof, be careful.</p>';
    return;
  }
  await uploadService(cfg);
  const ex = (cfg.explorer || '').replace(/\/+$/, '');
  const when = new Date(where.at * 1000).toLocaleString();
  const url = verifyUrl(ref);
  const atts = Array.isArray(doc.attachments) ? doc.attachments : [];
  const videos = Array.isArray(doc.videos) ? doc.videos : [];
  const sealed = atts.some((a) => a.seal) || videos.some((x) => x.seal);
  document.title = `Verify: ${doc.title} · Promissa`;
  out.innerHTML = `
    <div class="card stack">
      <p class="ok" style="margin:0"><strong>✓ On the public record.</strong> Published on Base ${esc(when)}, block ${where.block}, by account <span class="code">${esc(where.author)}</span>${where.tx && ex ? ` · <a href="${esc(`${ex}/tx/${where.tx}`)}" target="_blank" rel="noopener">View the transaction</a>` : ''}.</p>
      <p class="note">This record can never be edited. What you see below is exactly what was published; the files' fingerprints (SHA-256) are part of it.</p>
      <h2 style="margin:0">${esc(doc.title)}</h2>
      ${doc.body ? `<p style="white-space:pre-wrap">${esc(doc.body)}</p>` : ''}
      ${attachmentsHtml(cfg, doc, esc)}
      ${videosHtml(videos, cfg)}
    </div>
    <div class="card stack">
      <h3 style="margin:0">Check a file you were sent</h3>
      <p class="note">A photo, poster, PDF or recording someone forwarded you: it is compared with the fingerprints on this record, on your device (nothing is uploaded).</p>
      <input type="file" id="verify-file" />
      <p class="status" id="verify-result" role="status"></p>
    </div>
    ${sealed ? `<div class="card stack"><p>Some files here carry a Testimonia seal (made when they were recorded). To check a seal, open <a href="${esc(testimoniaUrl(cfg))}" target="_blank" rel="noopener">Testimonia's checker</a> and add the file there; nothing is uploaded.</p></div>` : ''}
    <div class="card stack">
      <h3 style="margin:0">Share it so others can check</h3>
      <p>Verify link: <span class="code">${esc(url)}</span> ${copyBtn(url, 'Copy')}</p>
      <p>A line to add to a post, a video's description or a printed flyer:</p>
      <p class="code">${esc(`Verify: ${url}`)}</p>
      <p class="row">${copyBtn(`Verify: ${url}`, 'Copy the line')}</p>
    </div>`;
  wireAttachments(out, cfg);
  wireVideos(out);
  const res = document.getElementById('verify-result');
  document.getElementById('verify-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    res.textContent = 'Comparing…';
    const r = await checkFile(f, atts).catch(() => ({ kind: 'error' }));
    res.className = `status ${r.kind === 'exact' ? 'ok' : r.kind === 'look' ? '' : 'error'}`;
    res.textContent =
      r.kind === 'exact' ? `✓ This is exactly ${r.name}, as published in this record.${r.sealed ? " It also carries a Testimonia seal: check it with Testimonia's checker (link above)." : ''}`
      : r.kind === 'look' ? `This looks like a copy of ${r.name} (resized or re-compressed), but it is not the exact file. Small edits may not show; the original on this page is the one on the record.`
      : r.kind === 'none' ? '▲ This file is not on this record. It may have been changed, or come from somewhere else.'
      : 'This file could not be read.';
  };
}

(async () => {
  if (typeof document === 'undefined' || !document.getElementById('verify')) return;
  startI18n();
  const ls = document.getElementById('lang-switch');
  if (ls) ls.innerHTML = langSwitchHtml();
  wireLangSwitch(document);
  keepOrgInLinks(document);
  wireCopy(document);
  const cfg = await loadConfig();
  startCounter(cfg);
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, undefined, { staticNetwork: true });
  const ref = refFrom(new URLSearchParams(location.search).get('ref'));
  const out = document.getElementById('verify');
  if (!ref) {
    out.innerHTML = `<div class="card stack"><p>Paste a Promissa verify link or a text reference (it starts with <span class="code">nb:0x</span>; "Copy text reference" on any post gives it).</p><input id="verify-ref" placeholder="Verify link or reference" /><button type="button" id="verify-go">Check it</button><p class="status" id="verify-ref-status" role="status"></p></div>`;
    document.getElementById('verify-go').onclick = () => {
      const r = refFrom(document.getElementById('verify-ref').value);
      if (!r) return void (document.getElementById('verify-ref-status').textContent = 'That is not a verify link or a reference.');
      location.href = verifyUrl(r);
    };
    return;
  }
  await render(cfg, provider, ref);
})().catch((e) => {
  const out = typeof document !== 'undefined' && document.getElementById('verify');
  if (out) out.innerHTML = `<p class="error">${esc(e.message || 'Could not reach Base right now.')}</p>`;
});
