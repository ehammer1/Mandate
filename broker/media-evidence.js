'use strict';
/**
 * broker/media-evidence.js - checks Testimonia photos and videos in mandate evidence.
 *
 * Evidence often is a photo or a video: "the bridge is repaired", "the clinic is open".
 * Uploaded files prove nothing about when or how they were made. Testimonia seals them on
 * the phone as they're captured, and its records bracket each capture (and any redacted
 * copy made from it) on Base: not before a block hash sealed in, not after an anchor.
 *
 * Evidence names its media in a fenced block (CIDs on IPFS):
 *
 *   ```testimonia
 *   [ { "file": "<cid of the .mp4 or .jpg>",
 *       "record": "<cid of the photo's .record.json, or a recording's .manifest.json if not inside the file>",
 *       "edits": [ { "file": "<cid of the redacted copy>", "record": "<cid of its .derive.json>" } ] } ]
 *   ```
 *
 * A spec turns the check on with "checks": ["media"] and can set
 *   "media": { "required": 1, "capturedAfter": "2027-05-01T00:00:00Z",
 *              "capturedBefore": "2027-06-01T00:00:00Z", "proof": "base" }
 * proof "base" (default) accepts only times proven on Base; "clock" accepts the phone's clock
 * (for pilots without anchoring; reports say so).
 *
 * The result has `failures` (each one rejects the evidence) and `facts`: plain sentences
 * added to the evidence the AI reviewer reads, so it judges the content against the
 * criteria while authenticity and timing are settled here, by checks, not by a model.
 */

const capture = require('../vendor/testimonia/capture');
const register = require('../vendor/testimonia/register');
const derive = require('../vendor/testimonia/derive');
const { timeline, windowWords } = require('../vendor/testimonia/timeline');

const BLOCK_RE = /```testimonia\s*\n([\s\S]*?)```/g;

/** The media references in an evidence text: [{ file, record?, edits: [{ file, record }] }]. */
function parseMediaRefs(text) {
  const refs = [];
  for (const m of String(text).matchAll(BLOCK_RE)) {
    let list;
    try {
      list = JSON.parse(m[1]);
    } catch {
      throw new Error('a ```testimonia block is not valid JSON');
    }
    for (const r of Array.isArray(list) ? list : [list]) {
      if (!r || typeof r.file !== 'string') throw new Error('each Testimonia item needs a "file" CID');
      refs.push({ file: r.file, record: r.record || null, edits: Array.isArray(r.edits) ? r.edits : [] });
    }
  }
  return refs;
}

const isPhotoRecord = (r) => r?.format === 'attest-file/1';
const parseJSON = (bytes, what) => {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
};

/**
 * Check one item: its seal or record, every edit, and the timeline. `fetchBytes(cid)`
 * returns a Buffer. Returns { ok, kind, events, words, problems }.
 */
async function checkItem(ref, { fetchBytes, chain }) {
  const problems = [];
  const file = await fetchBytes(ref.file);
  const record = ref.record ? parseJSON(await fetchBytes(ref.record), 'the record') : null;
  const items = [];
  let kind;
  if (isPhotoRecord(record)) {
    kind = 'photo';
    const v = register.verifyRegistration(record, { bytes: file });
    if (!v.ok) problems.push(`the photo doesn't match its seal: ${v.reason}`);
    items.push({ record });
  } else {
    kind = 'recording';
    const v = capture.verifyCapture(file, record ? { manifest: record } : {});
    if (v.status !== 'sealed') problems.push(`the recording is ${v.status}: ${v.problems[0] || 'its seal does not check out'}`);
    if (v.manifest) items.push({ manifest: v.manifest, anchor: record?.anchor });
  }
  for (const [i, e] of ref.edits.entries()) {
    if (!e?.file || !e?.record) {
      problems.push(`edit ${i + 1} needs both "file" and "record"`);
      continue;
    }
    const copy = await fetchBytes(e.file);
    const rec = parseJSON(await fetchBytes(e.record), `edit ${i + 1}'s record`);
    const v = derive.verifyDerive(rec, { file: copy });
    if (!v.ok) problems.push(`edit ${i + 1}: ${v.reason}`);
    items.push({ record: rec });
  }
  if (!items.length) return { ok: false, kind, events: [], words: [], problems };
  const t = await timeline(items, chain);
  problems.push(...t.problems);
  const words = t.events.map((e) => `${e.kind === 'edit' ? `Redacted copy (${e.summary})` : kind === 'photo' ? 'Photo' : 'Recording'}: made ${windowWords(e)}`);
  return { ok: problems.length === 0, kind, events: t.events, words, problems };
}

/** The capture's proven window, in ms: { from, to } (either may be null), per `proof`. */
function captureWindow(event, proof) {
  if (proof === 'clock') return { from: event.clockMs, to: event.clockMs };
  return { from: event.notBefore?.ok ? event.notBefore.time : null, to: event.notAfter?.ok ? event.notAfter.time : null };
}

/**
 * Check the media in an evidence text against the spec. Options: `fetchBytes(cid)`,
 * `chain` ({ provider, anchors, chainId } on the network Testimonia anchors to).
 * Returns { failures, facts, items }.
 */
async function checkMedia(spec, evidenceText, { fetchBytes, chain }) {
  const rules = spec.media || {};
  const proof = rules.proof === 'clock' ? 'clock' : 'base';
  const required = Number.isInteger(rules.required) ? rules.required : 1;
  const after = rules.capturedAfter ? Date.parse(rules.capturedAfter) : null;
  const before = rules.capturedBefore ? Date.parse(rules.capturedBefore) : null;
  const failures = [];
  const facts = [];
  let refs;
  try {
    refs = parseMediaRefs(evidenceText);
  } catch (e) {
    return { failures: [e.message], facts, items: [] };
  }
  const items = [];
  let qualifying = 0;
  for (const [i, ref] of refs.entries()) {
    const n = `Media ${i + 1}`;
    let r;
    try {
      r = await checkItem(ref, { fetchBytes, chain });
    } catch (e) {
      if (e?.constructor?.name === 'TransientError') throw e; // retried later, never a rejection
      r = { ok: false, events: [], words: [], problems: [e.message] };
    }
    items.push({ ref, ...r });
    if (!r.ok) {
      facts.push(`${n}: does NOT check out (${r.problems.join('; ')}).`);
      continue;
    }
    const w = captureWindow(r.events[0], proof);
    const late = [];
    if (proof === 'base' && (w.from === null || w.to === null)) late.push('its capture time is not proven on Base (needs both a start block and an anchor)');
    if (after !== null && (w.from === null || w.from < after)) late.push(`it may have been captured before ${rules.capturedAfter}`);
    if (before !== null && (w.to === null || w.to > before)) late.push(`it may have been captured after ${rules.capturedBefore}`);
    facts.push(`${n}: sealed ${r.kind}, unaltered. ${r.words.join('. ')}.${late.length ? ` Doesn't meet the mandate's timing: ${late.join('; ')}.` : ''}`);
    if (!late.length) qualifying++;
  }
  if (qualifying < required) {
    failures.push(
      refs.length
        ? `${qualifying} of ${refs.length} Testimonia media items meet the mandate's requirements; ${required} needed`
        : `the evidence includes no Testimonia media; ${required} needed`,
    );
  }
  return { failures, facts, items };
}

/** The facts as a section to append to the evidence the reviewer reads. */
function factsSection(facts) {
  if (!facts.length) return '';
  return `\n\n## Verified media facts (checked by the verifier node, not claims)\n\n${facts.map((f) => `- ${f}`).join('\n')}\n`;
}

module.exports = { parseMediaRefs, checkItem, checkMedia, factsSection, captureWindow };
