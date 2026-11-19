// Copied from Testimonia src/derive.js by scripts/sync-testimonia.js. Do not edit here.
'use strict';
// Derived copies with proof (attest-derive/1, FORMAT.md section 6e): a redacted, trimmed or
// otherwise edited copy of a sealed recording, with a signed record of exactly what was done.
//
// Blurring faces or muting a name changes the file, so the original seal no longer matches
// it. The derive record links the copy to the sealed original (its seal digest) and lists
// every change: what kind, where in the frame, when, which tool and model found it, and who
// reviewed it. Anyone can read what changed; anyone holding the original can check nothing
// else did. The original stays sealed and encrypted.

const crypto = require('crypto');
const { canonicalJSON, keyIdOf, verifySig } = require('./capture');

const FORMAT = 'attest-derive/1';
const OPS = ['blur', 'box', 'pixelate', 'crop', 'mute', 'trim'];
const PICTURE = ['blur', 'box', 'pixelate', 'crop'];
const REASONS = ['face', 'license-plate', 'personal-data', 'nudity', 'minor', 'voice', 'classified', 'other'];

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Returns null if an edit is well formed, else what's wrong. */
function editProblem(e) {
  if (!e || !OPS.includes(e.op)) return `unknown edit ${JSON.stringify(e?.op)}`;
  if (e.reason !== undefined && !REASONS.includes(e.reason)) return `unknown reason ${JSON.stringify(e.reason)}`;
  const t = e.time;
  const needsTime = !PICTURE.includes(e.op);
  if (t === undefined && needsTime) return `a ${e.op} edit needs a time range { startMs, endMs }`;
  if (t !== undefined && (!t || !Number.isInteger(t.startMs) || !Number.isInteger(t.endMs) || t.startMs < 0 || t.endMs <= t.startMs)) return 'a time range is { startMs, endMs }, with endMs after startMs';
  if (PICTURE.includes(e.op)) {
    const r = e.region;
    const ok = r && [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && v >= 0 && v <= 1) && r.x + r.w <= 1 && r.y + r.h <= 1 && r.w > 0 && r.h > 0;
    if (!ok) return 'picture edits need a region { x, y, w, h } as fractions of the frame';
  }
  return null;
}

function editsProblem(edits) {
  for (const e of edits) {
    const p = editProblem(e);
    if (p) return p;
  }
  if (edits.filter((e) => e.op === 'crop').length > 1) return 'a copy can be cropped only once';
  return null;
}

const message = (r) => `${FORMAT}|${canonicalJSON({ original: r.original, output: r.output, edits: r.edits, tools: r.tools, reviewedBy: r.reviewedBy, timeMs: r.timeMs, keyId: r.signer.keyId, ...(r.notBefore ? { notBefore: r.notBefore } : {}) })}`;

/**
 * Sign a derive record. `notBefore`: the latest Base block when the copy was made
 * ({ chainId, blockNumber, blockHash }): proof the edit happened after that block. `original`: the sealed recording's seal digest (0x hex). `output`:
 * the derived file's bytes (its SHA-256 is recorded). `edits`: [{ op, reason, region, time,
 * detector }]. `tools`: what found and applied the edits (name and version, model).
 * `reviewedBy`: who checked them, or null if none did (shown as "not reviewed").
 */
function signDerive({ signer, original, output, edits, tools = [], reviewedBy = null, notBefore = null, timeMs = Date.now() }) {
  if (!/^0x[0-9a-f]{64}$/.test(original)) throw new Error('original must be the seal digest, 0x hex');
  if (!Array.isArray(edits) || !edits.length) throw new Error('a derived copy needs at least one edit');
  const p = editsProblem(edits);
  if (p) throw new Error(p);
  const r = {
    format: FORMAT,
    original,
    output: { sha256: sha256hex(output), bytes: output.length },
    edits,
    tools,
    reviewedBy,
    timeMs,
    ...(notBefore ? { notBefore } : {}),
    signer: { keyId: keyIdOf(signer.publicKeyDer), publicKey: signer.publicKeyDer.toString('base64') },
  };
  return { ...r, sig: signer.sign(message(r)) };
}

/**
 * Check a derive record and, optionally, that `file` is the copy it describes. Returns
 * { ok, summary } or { ok: false, reason }.
 */
function verifyDerive(r, { file, original } = {}) {
  if (!r || r.format !== FORMAT) return { ok: false, reason: 'not a derive record' };
  const p = editsProblem(r.edits || []);
  if (p) return { ok: false, reason: p };
  if (!r.edits?.length) return { ok: false, reason: 'no edits listed' };
  const spki = Buffer.from(String(r.signer?.publicKey || ''), 'base64');
  if (keyIdOf(spki) !== r.signer?.keyId) return { ok: false, reason: 'the signer key does not match its ID' };
  if (!verifySig(spki, message(r), r.sig)) return { ok: false, reason: 'the signature is not valid: the record was changed or forged' };
  if (original && original !== r.original) return { ok: false, reason: 'this copy was made from a different recording' };
  if (file && (sha256hex(file) !== r.output.sha256 || file.length !== r.output.bytes)) return { ok: false, reason: 'this file is not the copy the record describes' };
  return { ok: true, summary: summarize(r) };
}

/** Plain-words summary, e.g. "3 faces blurred, 1 voice muted · reviewed by Jane Doe". */
function summarize(r) {
  const counts = new Map();
  for (const e of r.edits) {
    const verb = { blur: 'blurred', box: 'covered', pixelate: 'pixelated', crop: 'cropped', mute: 'muted', trim: 'cut' }[e.op];
    const what = e.op === 'trim' ? 'section' : e.op === 'crop' ? 'frame' : e.op === 'mute' && !e.reason ? 'sound' : (e.reason || 'area').replace('-', ' ');
    const k = `${what}|${verb}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const parts = [...counts].map(([k, n]) => {
    const [what, verb] = k.split('|');
    return `${n} ${what}${n > 1 ? 's' : ''} ${verb}`;
  });
  return `${parts.join(', ')} · ${r.reviewedBy ? `reviewed by ${r.reviewedBy}` : 'not reviewed by a person'}`;
}

const recordDigest = (r) => '0x' + sha256hex(Buffer.from(message(r)));

module.exports = { FORMAT, OPS, PICTURE, REASONS, editsProblem, recordDigest, message, signDerive, verifyDerive, summarize };
