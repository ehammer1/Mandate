// Browser (and Node 20+) verifier for the capture format, using WebCrypto only.
// Same results as src/capture.js; see capture/FORMAT.md. The verify page inlines this file.

const TAG = 'attest-capture/1';
const MANIFEST_UUID = '9b2d6e1a5c4f4b8ea7d30e6f2c1b8a45';
const AFTER_FRAGMENTS = new Set(['mfra', 'free']);
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (s) => Uint8Array.from(String(s).match(/../g) || [], (h) => parseInt(h, 16));
const fromB64 = (s) => Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
async function sha256(...parts) {
  return new Uint8Array(await subtle.digest('SHA-256', parts.length === 1 ? parts[0] : concat(...parts)));
}

/** JSON with sorted keys and no whitespace, matching the Node and phone implementations. */
export function canonicalJSON(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON(v[k])}`).join(',')}}`;
}

// ------------------------------------------------------------------ boxes

export function parseBoxes(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const boxes = [];
  let o = 0;
  while (o < u8.length) {
    if (u8.length - o < 8) throw new Error(`truncated box header at byte ${o}`);
    let size = dv.getUint32(o);
    const type = String.fromCharCode(...u8.subarray(o + 4, o + 8));
    if (size === 1) {
      if (u8.length - o < 16) throw new Error(`truncated large box at byte ${o}`);
      size = Number(dv.getBigUint64(o + 8));
    } else if (size === 0) {
      size = u8.length - o;
    }
    if (size < 8 || o + size > u8.length) throw new Error(`bad size for ${type} box at byte ${o}`);
    boxes.push({ type, start: o, end: o + size });
    o += size;
  }
  return boxes;
}

const isManifestBox = (u8, b) => b.type === 'uuid' && b.end - b.start >= 24 && hex(u8.subarray(b.start + 8, b.start + 24)) === MANIFEST_UUID;

export function splitFile(u8) {
  const boxes = parseBoxes(u8);
  let manifestJSON = null;
  let bodyEnd = u8.length;
  const last = boxes[boxes.length - 1];
  if (last && isManifestBox(u8, last)) {
    manifestJSON = new TextDecoder().decode(u8.subarray(last.start + 24, last.end));
    bodyEnd = last.start;
    boxes.pop();
  }
  if (boxes.some((b) => isManifestBox(u8, b))) throw new Error('manifest box must be the last box');
  const first = boxes.findIndex((b) => b.type === 'moof');
  if (first < 1) throw new Error('not a fragmented MP4 (no init segment before the first moof)');
  const init = u8.subarray(0, boxes[first].start);
  const fragments = [];
  let i = first;
  while (i < boxes.length && boxes[i].type === 'moof') {
    const mdat = boxes[i + 1];
    if (!mdat || mdat.type !== 'mdat') throw new Error(`moof at byte ${boxes[i].start} has no mdat after it`);
    fragments.push(u8.subarray(boxes[i].start, mdat.end));
    i += 2;
  }
  for (; i < boxes.length; i++) {
    if (!AFTER_FRAGMENTS.has(boxes[i].type)) throw new Error(`unexpected ${boxes[i].type} box at byte ${boxes[i].start}`);
  }
  return { body: u8.subarray(0, bodyEnd), init, fragments, manifestJSON };
}

// ------------------------------------------------------------------ chain

const ZERO32 = new Uint8Array(32);
const chainStart = (initHash) => sha256(enc.encode(TAG), initHash);
const chainNext = (head, fragHash, sensorHash) => sha256(head, fragHash, sensorHash || ZERO32);
const checkpointMessage = (keyId, n, head, timeMs) => `${TAG}|checkpoint|${keyId}|${n}|${head}|${timeMs}`;
const sealMessage = (keyId, n, head, fileHash, startMs, endMs, metaHash) =>
  `${TAG}|seal|${keyId}|${n}|${head}|${fileHash}|${startMs}|${endMs}|${metaHash}`;

/** DER ECDSA signature to the raw r||s form WebCrypto expects (P-256: 64 bytes). */
function derToRaw(der) {
  let o = 0;
  if (der[o++] !== 0x30) throw new Error('not a DER signature');
  if (der[o] & 0x80) o += (der[o] & 0x7f) + 1;
  else o += 1;
  const part = () => {
    if (der[o++] !== 0x02) throw new Error('not a DER integer');
    const len = der[o++];
    let v = der.subarray(o, o + len);
    o += len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) throw new Error('integer too long');
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  return concat(part(), part());
}

async function verifySig(key, message, sigB64) {
  try {
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(fromB64(sigB64)), enc.encode(message));
  } catch {
    return false;
  }
}

function describe(where) {
  if (typeof where === 'number') return `fragment ${where} differs from what was recorded; fragments before it are original`;
  if (where === 'init') return 'the file header differs from what was recorded';
  if (where === 'outside-fragments') return 'bytes outside the fragments were changed';
  return 'the seal does not match the fragments';
}

// ---------------------------------------------------------------- verify

/**
 * Verify a recording from the capture app.
 * @param {Uint8Array} u8  the file
 * @param {{manifest?: object}} opts  a separate .manifest.json, if the file has none
 * @returns {Promise<{status: 'sealed'|'partial'|'altered'|'invalid', problems: string[],
 *   manifest: object|null, fragments?: number, verifiedFragments?: number,
 *   alteredAt?: number|string, checks: object}>}
 */
export async function verifyCapture(u8, { manifest } = {}) {
  const problems = [];
  // Each check: true (passed), false (failed) or null (not reached).
  const checks = { format: null, signer: null, seal: null, fragments: null, wholeFile: null };
  const result = (status, extra = {}) => ({ status, problems, manifest: manifest || null, checks, ...extra });

  let parts;
  try {
    parts = splitFile(u8);
  } catch (e) {
    checks.format = false;
    problems.push(e.message);
    return result('invalid');
  }
  if (!manifest) {
    if (!parts.manifestJSON) {
      checks.format = false;
      problems.push('no seal in this file, and no manifest file was added');
      return result('invalid');
    }
    try {
      manifest = JSON.parse(parts.manifestJSON);
    } catch {
      checks.format = false;
      problems.push('the seal inside the file is damaged');
      return result('invalid');
    }
  }
  if (manifest.format !== TAG || !manifest.meta || !Array.isArray(manifest.fragments) || !('seal' in manifest)) {
    checks.format = false;
    problems.push('the seal is malformed or from a different format');
    return result('invalid');
  }
  checks.format = true;

  let key;
  const spki = fromB64(manifest.meta.publicKey || '');
  try {
    if (hex(await sha256(spki)) !== manifest.meta.keyId) throw new Error('key id mismatch');
    key = await subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    checks.signer = false;
    problems.push('the signing key in the seal is invalid');
    return result('invalid');
  }
  checks.signer = true;
  const keyId = manifest.meta.keyId;

  const initHash = await sha256(parts.init);
  const fragHashes = [];
  for (const f of parts.fragments) fragHashes.push(await sha256(f));
  const heads = [await chainStart(initHash)];
  for (let i = 0; i < parts.fragments.length; i++) {
    const sh = manifest.fragments[i]?.sensorHash ? fromHex(manifest.fragments[i].sensorHash) : null;
    heads.push(await chainNext(heads[i], fragHashes[i], sh));
  }

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
  checks.fragments = alteredAt === null;

  let verifiedFragments = 0;
  let checkpointMax = 0;
  for (const cp of manifest.checkpoints || []) {
    if (!(await verifySig(key, checkpointMessage(keyId, cp.n, cp.head, cp.timeMs), cp.sig))) {
      checks.seal = false;
      problems.push(`the signature at fragment ${cp.n} is not valid`);
      return result('invalid', { fragments: parts.fragments.length });
    }
    checkpointMax = Math.max(checkpointMax, cp.n);
    if (heads[cp.n] && hex(heads[cp.n]) === cp.head) verifiedFragments = Math.max(verifiedFragments, cp.n);
  }
  const fragments = parts.fragments.length;

  const listed = [await chainStart(fromHex(manifest.initHash))];
  for (let i = 0; i < manifest.fragments.length; i++) {
    const f = manifest.fragments[i];
    listed.push(await chainNext(listed[i], fromHex(f.hash), f.sensorHash ? fromHex(f.sensorHash) : null));
  }
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
    checks.seal = false;
    if (alteredAt !== null && (typeof alteredAt !== 'number' || alteredAt < checkpointMax)) return altered(alteredAt);
    if (verifiedFragments > 0) {
      problems.push(`not sealed: only the first ${verifiedFragments} fragments are proven`);
      return result('partial', { fragments, verifiedFragments });
    }
    problems.push('not sealed, and no signed checkpoints');
    return result('invalid', { fragments });
  }

  const metaHash = hex(await sha256(enc.encode(canonicalJSON(manifest.meta))));
  if (!(await verifySig(key, sealMessage(keyId, s.n, s.head, s.fileHash, manifest.startMs, manifest.endMs, metaHash), s.sig))) {
    checks.seal = false;
    problems.push('the seal signature is not valid: the seal was changed or forged');
    return result('invalid', { fragments });
  }
  checks.seal = true;
  if (listed[s.n] && hex(listed[s.n]) === s.head) signedList = Math.max(signedList, s.n);
  const fileHashOk = hex(await sha256(parts.body)) === s.fileHash;
  checks.wholeFile = fileHashOk;
  const chainOk = s.n === fragments && heads[s.n] && hex(heads[s.n]) === s.head;
  if (alteredAt === null && fileHashOk && chainOk) return result('sealed', { fragments, verifiedFragments: s.n });
  if (alteredAt === null) alteredAt = fileHashOk ? 'seal' : 'outside-fragments';
  return altered(alteredAt);
}
