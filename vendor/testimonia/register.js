// Copied from Testimonia src/register.js by scripts/sync-testimonia.js. Do not edit here.
'use strict';
// File registrations (attest-file/1, FORMAT.md section 8): a signed record that this exact
// file (a song, a document, an image, any file) was registered by this key, no earlier than
// a public Base block. It proves which file, who registered it and when (earliest, and
// latest once anchored); it does not prove who created it.

const crypto = require('crypto');
const { canonicalJSON, keyIdOf, verifySig } = require('./capture');

const FORMAT = 'attest-file/1';
const KINDS = ['music', 'audio', 'document', 'image', 'video', 'dataset', 'code', 'other'];

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const message = (r) => `${FORMAT}|${canonicalJSON({ file: r.file, kind: r.kind, claim: r.claim, notBefore: r.notBefore, timeMs: r.timeMs, keyId: r.signer.keyId, ...(r.capture ? { capture: r.capture } : {}) })}`;

/**
 * Register `bytes`. `name` and `mediaType` describe the file; `kind` is its sort; `claim`
 * is what the registrant states (e.g. { role: 'author', name: 'Jane Doe' }), shown as a
 * claim, never as verified. `notBefore` is a recent Base block ({ chainId, blockNumber,
 * blockHash }) or null.
 */
function signRegistration({ signer, bytes, name = '', mediaType = '', kind = 'other', claim = null, notBefore = null, capture = null, timeMs = Date.now() }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown kind ${kind}`);
  const r = {
    format: FORMAT,
    file: { sha256: sha256hex(bytes), bytes: bytes.length, name, mediaType },
    kind,
    claim,
    notBefore,
    timeMs,
    ...(capture ? { capture } : {}),
    signer: { keyId: keyIdOf(signer.publicKeyDer), publicKey: signer.publicKeyDer.toString('base64') },
  };
  // A phone or software key signs at once; an HSM (src/keys.js recordSigner) returns a promise.
  const sig = signer.sign(message(r));
  return typeof sig?.then === 'function' ? sig.then((v) => ({ ...r, sig: v })) : { ...r, sig };
}

/** Check a registration, and that `bytes` (if given) is the registered file. */
function verifyRegistration(r, { bytes } = {}) {
  if (!r || r.format !== FORMAT) return { ok: false, reason: 'not a file registration' };
  const spki = Buffer.from(String(r.signer?.publicKey || ''), 'base64');
  if (keyIdOf(spki) !== r.signer?.keyId) return { ok: false, reason: 'the signer key does not match its ID' };
  if (!verifySig(spki, message(r), r.sig)) return { ok: false, reason: 'the signature is not valid: the record was changed or forged' };
  if (bytes && (sha256hex(bytes) !== r.file.sha256 || bytes.length !== r.file.bytes)) return { ok: false, reason: 'this is not the registered file (it differs, even slightly)' };
  return { ok: true, file: r.file, kind: r.kind, claim: r.claim, notBefore: r.notBefore, keyId: r.signer.keyId };
}

const recordDigest = (r) => '0x' + crypto.createHash('sha256').update(message(r)).digest('hex');

module.exports = { FORMAT, KINDS, signRegistration, verifyRegistration, message, recordDigest };
