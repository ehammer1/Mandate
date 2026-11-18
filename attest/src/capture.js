// Reference implementation of the capture format (capture/FORMAT.md): a recording
// session that seals fragmented MP4 as it's written, and the verifier.
'use strict';

const crypto = require('crypto');

const TAG = 'attest-capture/1';
const MANIFEST_UUID = Buffer.from('9b2d6e1a5c4f4b8ea7d30e6f2c1b8a45', 'hex');
const ZERO32 = Buffer.alloc(32);
const AFTER_FRAGMENTS = new Set(['mfra', 'free']);

const sha256 = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
const hex = (b) => b.toString('hex');
const fromHex = (s) => Buffer.from(s, 'hex');

/** JSON with sorted keys and no whitespace, for hashing. */
function canonicalJSON(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON(v[k])}`).join(',')}}`;
}

// ------------------------------------------------------------------ boxes

/** Top-level MP4 boxes: [{ type, start, end }]. Throws on a truncated box. */
function parseBoxes(buf) {
  const boxes = [];
  let o = 0;
  while (o < buf.length) {
    if (buf.length - o < 8) throw new Error(`truncated box header at byte ${o}`);
    let size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    if (size === 1) {
      if (buf.length - o < 16) throw new Error(`truncated large box at byte ${o}`);
      const big = buf.readBigUInt64BE(o + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`box too large at byte ${o}`);
      size = Number(big);
    } else if (size === 0) {
      size = buf.length - o;
    }
    if (size < 8 || o + size > buf.length) throw new Error(`bad size for ${type} box at byte ${o}`);
    boxes.push({ type, start: o, end: o + size });
    o += size;
  }
  return boxes;
}

function isManifestBox(buf, box) {
  return box.type === 'uuid' && box.end - box.start >= 24 && buf.subarray(box.start + 8, box.start + 24).equals(MANIFEST_UUID);
}

/**
 * Split a file into { body, init, fragments, manifestJSON }. `body` is the file
 * without the manifest box (what `fileHash` covers).
 */
function splitFile(buf) {
  const boxes = parseBoxes(buf);
  let manifestJSON = null;
  let bodyEnd = buf.length;
  const last = boxes[boxes.length - 1];
  if (last && isManifestBox(buf, last)) {
    manifestJSON = buf.subarray(last.start + 24, last.end).toString('utf8');
    bodyEnd = last.start;
    boxes.pop();
  }
  if (boxes.some((b) => isManifestBox(buf, b))) throw new Error('manifest box must be the last box');

  const first = boxes.findIndex((b) => b.type === 'moof');
  if (first < 1) throw new Error('not a fragmented MP4 (no init segment before the first moof)');
  const init = buf.subarray(0, boxes[first].start);
  const fragments = [];
  let i = first;
  while (i < boxes.length && boxes[i].type === 'moof') {
    const mdat = boxes[i + 1];
    if (!mdat || mdat.type !== 'mdat') throw new Error(`moof at byte ${boxes[i].start} has no mdat after it`);
    fragments.push(buf.subarray(boxes[i].start, mdat.end));
    i += 2;
  }
  for (; i < boxes.length; i++) {
    if (!AFTER_FRAGMENTS.has(boxes[i].type)) throw new Error(`unexpected ${boxes[i].type} box at byte ${boxes[i].start}`);
  }
  return { body: buf.subarray(0, bodyEnd), init, fragments, manifestJSON };
}

// ------------------------------------------------------------------ chain

const chainStart = (initHash) => sha256(Buffer.from(TAG, 'ascii'), initHash);
const chainNext = (head, fragHash, sensorHash) => sha256(head, fragHash, sensorHash || ZERO32);

const checkpointMessage = (keyId, n, head, timeMs) => `${TAG}|checkpoint|${keyId}|${n}|${head}|${timeMs}`;
const sealMessage = (keyId, n, head, fileHash, startMs, endMs, metaHash) =>
  `${TAG}|seal|${keyId}|${n}|${head}|${fileHash}|${startMs}|${endMs}|${metaHash}`;

function keyIdOf(spkiDer) {
  return hex(sha256(spkiDer));
}

// ---------------------------------------------------------------- signing

/** A software signer for tests and the reference CLI. Phones use hardware keys. */
function softwareSigner(privateKey) {
  privateKey = privateKey || crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  if (!(privateKey instanceof crypto.KeyObject)) privateKey = crypto.createPrivateKey(privateKey);
  const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return {
    publicKeyDer: spki,
    sign: (message) => crypto.sign('sha256', Buffer.from(message, 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64'),
  };
}

function verifySig(spkiDer, message, sigB64) {
  try {
    const key = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    return crypto.verify('sha256', Buffer.from(message, 'utf8'), { key, dsaEncoding: 'der' }, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- session

/**
 * What the phone does while recording. Feed it the init segment, then each fragment as
 * the muxer emits it; call `checkpoint` at least every 10 seconds; `seal` at the end.
 */
class CaptureSession {
  constructor({ signer, meta = {}, startMs }) {
    this.signer = signer;
    const keyId = keyIdOf(signer.publicKeyDer);
    this.meta = {
      app: 'attest-capture/0.1.0',
      platform: 'reference',
      device: '',
      location: { commitment: null, mode: 'none' },
      ...meta,
      keyId,
      publicKey: signer.publicKeyDer.toString('base64'),
    };
    this.keyId = keyId;
    this.startMs = startMs ?? Date.now();
    this.fragments = [];
    this.checkpoints = [];
    this.fileHash = crypto.createHash('sha256');
    this.head = null;
  }

  init(bytes) {
    if (this.head) throw new Error('init already given');
    this.initHash = sha256(bytes);
    this.head = chainStart(this.initHash);
    this.fileHash.update(bytes);
  }

  addFragment(bytes, sensorBytes) {
    if (!this.head) throw new Error('give the init segment first');
    const fragHash = sha256(bytes);
    const sensorHash = sensorBytes ? sha256(sensorBytes) : null;
    this.head = chainNext(this.head, fragHash, sensorHash);
    this.fragments.push({ hash: hex(fragHash), sensorHash: sensorHash ? hex(sensorHash) : null });
    this.fileHash.update(bytes);
  }

  checkpoint(timeMs = Date.now()) {
    const n = this.fragments.length;
    const head = hex(this.head);
    const cp = { n, head, timeMs, sig: this.signer.sign(checkpointMessage(this.keyId, n, head, timeMs)) };
    this.checkpoints.push(cp);
    return cp;
  }

  /**
   * The manifest without a seal, for when recording stopped abnormally. The app keeps
   * fragment hashes and checkpoints on disk as it goes, and writes this on next launch.
   */
  unsealed() {
    return {
      format: TAG,
      meta: this.meta,
      startMs: this.startMs,
      endMs: null,
      initHash: hex(this.initHash),
      fragments: this.fragments,
      checkpoints: this.checkpoints,
      seal: null,
    };
  }

  /** `trailer` is any bytes the muxer writes after the last fragment (e.g. mfra). */
  seal({ endMs = Date.now(), trailer } = {}) {
    if (trailer) this.fileHash.update(trailer);
    const n = this.fragments.length;
    const head = hex(this.head);
    const fileHash = hex(this.fileHash.digest());
    const metaHash = hex(sha256(canonicalJSON(this.meta)));
    const sig = this.signer.sign(sealMessage(this.keyId, n, head, fileHash, this.startMs, endMs, metaHash));
    return {
      format: TAG,
      meta: this.meta,
      startMs: this.startMs,
      endMs,
      initHash: hex(this.initHash),
      fragments: this.fragments,
      checkpoints: this.checkpoints,
      seal: { n, head, fileHash, sig },
    };
  }
}

/** The manifest as a top-level MP4 box, to append to the file. */
function manifestBox(manifest) {
  const json = Buffer.from(JSON.stringify(manifest), 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + 16 + json.length, 0);
  header.write('uuid', 4, 'latin1');
  return Buffer.concat([header, MANIFEST_UUID, json]);
}

/**
 * Seal an existing fragmented MP4 as if it had just been recorded (reference CLI and
 * tests). Checkpoints every `checkpointEvery` fragments. Returns { file, manifest }.
 */
function simulateCapture(buf, { signer, meta, startMs = Date.now(), fragmentMs = 1000, checkpointEvery = 10 } = {}) {
  const { init, fragments, body } = splitFile(buf);
  const s = new CaptureSession({ signer: signer || softwareSigner(), meta, startMs });
  s.init(init);
  fragments.forEach((f, i) => {
    s.addFragment(f);
    if ((i + 1) % checkpointEvery === 0) s.checkpoint(startMs + (i + 1) * fragmentMs);
  });
  const trailerStart = init.length + fragments.reduce((a, f) => a + f.length, 0);
  const manifest = s.seal({ endMs: startMs + fragments.length * fragmentMs, trailer: body.subarray(trailerStart) });
  return { file: Buffer.concat([body, manifestBox(manifest)]), manifest };
}

// ---------------------------------------------------------------- verify

/**
 * Verify a sealed recording. `manifest` overrides the embedded one (for a separate
 * .manifest.json). Returns { status, fragments, verifiedFragments, alteredAt, problems, manifest }.
 *   status: 'sealed' | 'partial' | 'altered' | 'invalid'
 */
function verifyCapture(buf, { manifest } = {}) {
  const problems = [];
  const result = (status, extra = {}) => ({ status, problems, manifest: manifest || null, ...extra });

  let parts;
  try {
    parts = splitFile(buf);
  } catch (e) {
    problems.push(e.message);
    return result('invalid');
  }
  if (!manifest) {
    if (!parts.manifestJSON) {
      problems.push('no manifest in the file and none given');
      return result('invalid');
    }
    try {
      manifest = JSON.parse(parts.manifestJSON);
    } catch {
      problems.push('manifest is not valid JSON');
      return result('invalid');
    }
  }
  if (manifest.format !== TAG || !manifest.meta || !Array.isArray(manifest.fragments) || !('seal' in manifest)) {
    problems.push('manifest is malformed or a different format');
    return result('invalid');
  }

  const spki = Buffer.from(String(manifest.meta.publicKey || ''), 'base64');
  if (keyIdOf(spki) !== manifest.meta.keyId) {
    problems.push('keyId does not match the public key');
    return result('invalid');
  }
  const keyId = manifest.meta.keyId;

  // Recompute the chain over the file as it is now.
  const initHash = sha256(parts.init);
  const heads = [chainStart(initHash)];
  const fragHashes = parts.fragments.map((f) => sha256(f));
  parts.fragments.forEach((_, i) => {
    const sh = manifest.fragments[i]?.sensorHash ? fromHex(manifest.fragments[i].sensorHash) : null;
    heads.push(chainNext(heads[i], fragHashes[i], sh));
  });

  // Where does the file first differ from what was recorded?
  let alteredAt = null;
  if (hex(initHash) !== manifest.initHash) alteredAt = 'init';
  else {
    const n = Math.max(fragHashes.length, manifest.fragments.length);
    for (let i = 0; i < n; i++) {
      if (!fragHashes[i] || !manifest.fragments[i] || hex(fragHashes[i]) !== manifest.fragments[i].hash) {
        alteredAt = i;
        break;
      }
    }
  }

  // Signed checkpoints whose heads match the file as it is.
  let verifiedFragments = 0;
  let checkpointMax = 0;
  for (const cp of manifest.checkpoints || []) {
    if (!verifySig(spki, checkpointMessage(keyId, cp.n, cp.head, cp.timeMs), cp.sig)) {
      problems.push(`checkpoint at fragment ${cp.n} has a bad signature`);
      return result('invalid', { fragments: parts.fragments.length });
    }
    checkpointMax = Math.max(checkpointMax, cp.n);
    if (heads[cp.n] && hex(heads[cp.n]) === cp.head) verifiedFragments = Math.max(verifiedFragments, cp.n);
  }
  const fragments = parts.fragments.length;

  // How much of the manifest's own fragment list is signed? A signature over head_n
  // authenticates the first n fragment hashes listed, so file fragments before a change
  // that match those hashes are proven original even if no checkpoint lands there.
  const listed = [chainStart(fromHex(String(manifest.initHash)))];
  manifest.fragments.forEach((f, i) => {
    listed.push(chainNext(listed[i], fromHex(String(f.hash)), f.sensorHash ? fromHex(f.sensorHash) : null));
  });
  let signedList = 0;
  for (const cp of manifest.checkpoints || []) {
    if (listed[cp.n] && hex(listed[cp.n]) === cp.head) signedList = Math.max(signedList, cp.n);
  }
  const altered = (where) => {
    problems.push(describe(where));
    const provable = typeof where === 'number' ? Math.min(where, signedList) : 0;
    return result('altered', { fragments, verifiedFragments: provable, alteredAt: where });
  };

  const s = manifest.seal;
  if (!s) {
    // Recording stopped without a seal (app or phone died). Checkpoints still prove a prefix.
    if (alteredAt !== null && (typeof alteredAt !== 'number' || alteredAt < checkpointMax)) {
      return altered(alteredAt);
    }
    if (verifiedFragments > 0) {
      problems.push(`not sealed: only the first ${verifiedFragments} fragments are proven`);
      return result('partial', { fragments, verifiedFragments });
    }
    problems.push('not sealed and no checkpoints');
    return result('invalid', { fragments });
  }

  const metaHash = hex(sha256(canonicalJSON(manifest.meta)));
  if (!verifySig(spki, sealMessage(keyId, s.n, s.head, s.fileHash, manifest.startMs, manifest.endMs, metaHash), s.sig)) {
    problems.push('seal signature is not valid (the manifest was changed or forged)');
    return result('invalid', { fragments });
  }
  if (listed[s.n] && hex(listed[s.n]) === s.head) signedList = Math.max(signedList, s.n);
  const fileHashOk = hex(sha256(parts.body)) === s.fileHash;
  const chainOk = s.n === fragments && heads[s.n] && hex(heads[s.n]) === s.head;
  if (alteredAt === null && fileHashOk && chainOk) return result('sealed', { fragments, verifiedFragments: s.n });
  if (alteredAt === null) alteredAt = fileHashOk ? 'seal' : 'outside-fragments';
  return altered(alteredAt);
}

function describe(where) {
  if (typeof where === 'number') return `fragment ${where} differs from what was recorded; fragments before it are original`;
  if (where === 'init') return 'the file header differs from what was recorded';
  if (where === 'outside-fragments') return 'bytes outside the fragments were changed';
  return 'the seal does not match the fragments';
}

module.exports = {
  TAG,
  MANIFEST_UUID,
  canonicalJSON,
  parseBoxes,
  splitFile,
  chainStart,
  chainNext,
  checkpointMessage,
  sealMessage,
  keyIdOf,
  softwareSigner,
  verifySig,
  CaptureSession,
  manifestBox,
  simulateCapture,
  verifyCapture,
};
