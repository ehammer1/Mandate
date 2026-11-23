/**
 * app/src/testimonia.js - reading a Testimonia seal attached to a Promissa file or video.
 *
 * Testimonia seals a photo or recording when it is made. Promissa does not check the seal itself:
 * it keeps the seal's identifiers next to its own SHA-256 fingerprint of the file, and links to
 * Testimonia's own checker. What is stored: { by: 'testimonia', format, keyId, sealDigest (null
 * until the seal is anchored on Base), fileHash, original (for an edited copy), proof }.
 *
 * Accepted: a Testimonia link (…#proof=<base64url of the record JSON>), the base64url text, or
 * the record JSON itself.
 */

/** Testimonia's checker (the person adds the file there; nothing is uploaded). Its address will change at launch. */
export const testimoniaUrl = (cfg) => cfg?.testimoniaUrl || 'https://ehammer1.github.io/testimonia/';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX64X = /^0x[0-9a-f]{64}$/;
const MAX_PROOF = 16_000; // characters of base64url kept with the post

function b64urlToText(s) {
  const b = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function textToB64url(t) {
  const bytes = new TextEncoder().encode(t);
  let bin = '';
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The record JSON from a link, base64url text or JSON; null if it is none of these. */
export function recordFrom(input) {
  if (input && typeof input === 'object') return input;
  const t = String(input || '').trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }
  const m = t.match(/[#&]proof=([A-Za-z0-9_-]+)/);
  const enc = m ? m[1] : /^[A-Za-z0-9_-]{40,}$/.test(t) ? t : null;
  if (!enc) return null;
  try {
    return JSON.parse(b64urlToText(enc));
  } catch {
    return null;
  }
}

const lower = (x) => (typeof x === 'string' ? x.toLowerCase() : null);
const hex64 = (x) => (HEX64.test(lower(x) || '') ? lower(x) : null);
const digest = (x) => (HEX64X.test(lower(x) || '') ? lower(x) : null);

/**
 * The seal's identifiers, or throws a plain message. kind: 'file' (photos and other files: fileHash
 * is the SHA-256 of the exact bytes), 'recording' (fileHash is of the file without its seal, so it
 * differs from Promissa's fingerprint) or 'copy' (an edited or smaller copy of `original`).
 */
export function readSeal(input) {
  const r = recordFrom(input);
  if (!r) throw new Error('That is not a Testimonia seal. Paste the Testimonia link (it has #proof= in it) or the record.');
  let kind, keyId, fileHash, sealDigest, original;
  if (r.format === 'attest-file/1') {
    kind = 'file';
    keyId = hex64(r.signer?.keyId);
    fileHash = hex64(r.file?.sha256);
    sealDigest = digest(r.anchor?.sealDigest);
  } else if (r.format === 'attest-derive/1') {
    kind = 'copy';
    keyId = hex64(r.signer?.keyId);
    fileHash = hex64(r.output?.sha256);
    sealDigest = digest(r.anchor?.sealDigest);
    original = digest(r.original);
  } else if (r.format === 'attest-record/1') {
    kind = 'recording';
    keyId = hex64(r.manifest?.meta?.keyId);
    fileHash = hex64(r.manifest?.seal?.fileHash);
    sealDigest = digest(r.sealDigest) || digest(r.manifest?.anchor?.sealDigest);
  } else if (r.meta && r.seal) {
    kind = 'recording'; // a capture manifest (the seal file)
    keyId = hex64(r.meta.keyId);
    fileHash = hex64(r.seal.fileHash);
    sealDigest = digest(r.anchor?.sealDigest);
  } else throw new Error('This Testimonia record is of a kind Promissa does not know yet.');
  if (!keyId || !fileHash) throw new Error('This Testimonia record is incomplete (no key or file fingerprint).');
  const proof = textToB64url(JSON.stringify(r));
  return { by: 'testimonia', format: r.format || 'capture-manifest', kind, keyId, sealDigest: sealDigest || null, fileHash, ...(original ? { original } : {}), ...(proof.length <= MAX_PROOF ? { proof } : {}) };
}

/** Does a file's seal belong to the file Promissa fingerprinted? (Recordings can't be compared this way.) */
export function sealMatches(seal, sha256) {
  if (!seal || seal.kind === 'recording' || !sha256) return null;
  return seal.fileHash === String(sha256).toLowerCase();
}

/** Where to check a seal: Testimonia's checker, with the record in the link when Promissa kept it. */
export const checkSealUrl = (cfg, seal) => `${testimoniaUrl(cfg)}${seal?.proof ? `#proof=${seal.proof}` : ''}`;

/** The seal line on a file or video: "Sealed by Testimonia: check it" (no check mark until Testimonia launches). */
export function sealHtml(cfg, seal, esc, { sha256 } = {}) {
  if (!seal) return '';
  if (seal.by === 'testimonia' && !seal.keyId) return '<span class="chip">Testimonia seal (older format): check it with Testimonia</span>';
  const m = sealMatches(seal, sha256);
  if (m === false) return '<span class="chip warn">▲ The Testimonia seal attached is for a different file</span>';
  return `<span class="chip">Sealed by Testimonia: <a href="${esc(checkSealUrl(cfg, seal))}" target="_blank" rel="noopener">check it</a>${seal.sealDigest ? '' : ' (not yet anchored on Base)'}</span>`;
}
