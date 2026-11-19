// Copied from Testimonia src/timeline.js by scripts/sync-testimonia.js. Do not edit here.
'use strict';
// When things happened, provably: a capture and every edit after it, each bracketed by Base.
//
//   not before   a Base block hash sealed into the record when it was made (start-time proof):
//                nobody knows a block's hash before the block exists
//   not after    the record's anchor on Base: its digest was posted in a batch by that block
//
// The phone's clock is shown too, but never trusted: anyone can change it. A timeline is
// the capture (a sealed recording or photo) followed by redacted copies made from it, each
// linked to the one before by its digest and checked in order.

const { ethers } = require('ethers');
const capture = require('./capture');
const { sealDigest } = require('./anchor');
const derive = require('./derive');
const register = require('./register');

const ANCHORS_ABI = ['function anchoredAt(bytes32,bytes32,bytes32,bytes32[]) view returns (uint64,uint64)'];
const hex32 = (h) => (String(h).startsWith('0x') ? String(h) : `0x${h}`).toLowerCase();

/** What an item is, its digest (what's anchored), its signer and its claimed times. */
function describe(item) {
  if (item.manifest) {
    const m = item.manifest;
    return { kind: m.format === 'attest-clip/1' ? 'clip' : 'recording', digest: sealDigest(m), keyId: hex32(m.meta.keyId), notBefore: m.meta.notBefore || null, clockMs: m.startMs, anchor: item.anchor || m.anchor || null };
  }
  const r = item.record;
  if (r?.format === 'attest-file/1') {
    return { kind: r.capture?.mode === 'photo' ? 'photo' : 'file', digest: register.recordDigest(r), keyId: hex32(r.signer.keyId), notBefore: r.notBefore || null, clockMs: r.capture?.takenMs ?? r.timeMs, anchor: item.anchor || r.anchor || null, fileSha256: r.file.sha256 };
  }
  if (r?.format === 'attest-derive/1') {
    return { kind: 'edit', digest: derive.recordDigest(r), keyId: hex32(r.signer.keyId), notBefore: r.notBefore || null, clockMs: r.timeMs, anchor: item.anchor || r.anchor || null, original: r.original, summary: derive.summarize(r) };
  }
  throw new Error('a timeline item is a recording ({ manifest }) or a record ({ record })');
}

/**
 * Check one item's window on Base. `chain`: { provider, anchors (AnchorRegistry address),
 * chainId }. Returns { notBefore: { block, time, ok } | null, notAfter: { block, time, ok } | null, problems }.
 */
async function windowOf(d, chain) {
  const problems = [];
  let notBefore = null;
  let notAfter = null;
  if (d.notBefore) {
    const nb = d.notBefore;
    notBefore = { block: nb.blockNumber, time: null, ok: null };
    if (chain?.provider) {
      if (chain.chainId && nb.chainId !== chain.chainId) problems.push(`its start-time proof is from another chain (${nb.chainId})`);
      const b = await chain.provider.getBlock(nb.blockNumber);
      notBefore.ok = !!b && b.hash.toLowerCase() === String(nb.blockHash).toLowerCase();
      notBefore.time = b ? Number(b.timestamp) * 1000 : null;
      if (!notBefore.ok) problems.push(`its start-time proof doesn't match Base block ${nb.blockNumber}`);
    }
  }
  if (d.anchor) {
    notAfter = { block: d.anchor.block ?? null, time: null, ok: null };
    if (chain?.provider && (chain.anchors || chain.anchoredAt)) {
      // `chain.anchoredAt` stands in for the contract call in tests and other runtimes.
      const anchors = chain.anchoredAt ? { anchoredAt: chain.anchoredAt } : new ethers.Contract(chain.anchors, ANCHORS_ABI, chain.provider);
      const keyId = hex32(d.anchor.keyId || d.keyId);
      const digest = hex32(d.anchor.sealDigest || d.anchor.digest || d.digest);
      if (keyId !== d.keyId || digest !== hex32(d.digest)) {
        notAfter.ok = false;
        problems.push('its anchor proof is for something else');
      } else {
        const [t, block] = await anchors.anchoredAt(keyId, digest, d.anchor.root, d.anchor.proof);
        notAfter.ok = t !== 0n;
        notAfter.time = Number(t) * 1000 || null;
        notAfter.block = Number(block) || notAfter.block;
        if (!notAfter.ok) problems.push('its anchor proof does not match a root posted on Base');
      }
    }
  }
  return { notBefore, notAfter, problems };
}

/**
 * The timeline of a capture and its edits. `items`: the capture first ({ manifest } for a
 * recording, { record } for a sealed photo), then redaction records ({ record }) in order.
 * `chain`: as windowOf, optional (without it, block numbers are shown unchecked).
 * Returns { ok, events: [{ kind, keyId, clockMs, notBefore, notAfter, summary }], problems }.
 */
async function timeline(items, chain = null) {
  const problems = [];
  const events = [];
  let prev = null;
  for (const [i, item] of items.entries()) {
    const d = describe(item);
    if (i === 0 && d.kind === 'edit') problems.push('a timeline starts with the capture, not an edit');
    if (i > 0) {
      if (d.kind !== 'edit') problems.push(`item ${i + 1} is not an edit record`);
      // An edit names what it was made from: the seal digest of a recording, the SHA-256 of
      // a photo file, or the output of the previous edit.
      const from = prev.kind === 'photo' || prev.kind === 'file' ? hex32(prev.fileSha256) : prev.kind === 'edit' ? hex32(prev.outputSha256) : hex32(prev.digest);
      if (hex32(d.original) !== from) problems.push(`edit ${i} wasn't made from the item before it`);
    }
    const w = await windowOf(d, chain);
    problems.push(...w.problems.map((p) => `${d.kind}${i ? ` ${i}` : ''}: ${p}`));
    const event = { kind: d.kind, keyId: d.keyId, digest: hex32(d.digest), clockMs: d.clockMs, notBefore: w.notBefore, notAfter: w.notAfter, ...(d.summary ? { summary: d.summary } : {}) };
    // Order: an edit can't provably precede what it was made from.
    const prevEvent = events[events.length - 1];
    if (prevEvent?.notAfter?.ok !== false && event.notAfter?.block && prevEvent?.notBefore?.block && event.notAfter.block < prevEvent.notBefore.block) {
      problems.push(`${d.kind} ${i} was anchored before the item it was made from could exist`);
    }
    events.push(event);
    prev = { ...d, outputSha256: item.record?.output?.sha256 };
  }
  return { ok: problems.length === 0, events, problems };
}

/** Plain words for one event's window, e.g. "between 10:02 and 10:05 UTC on 3 Jun 2027 (Base)". */
function windowWords(e) {
  const t = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const nb = e.notBefore?.ok ? t(e.notBefore.time) : null;
  const na = e.notAfter?.ok ? t(e.notAfter.time) : null;
  if (nb && na) return `between ${nb} and ${na} (proven on Base)`;
  if (nb) return `after ${nb} (proven on Base); not yet anchored`;
  if (na) return `by ${na} (proven on Base)`;
  return `at ${t(e.clockMs)} by the phone's clock only (not proven)`;
}

module.exports = { timeline, windowOf, windowWords, describe };
