/**
 * services/identity/mdl.js - sign-up with a state mobile ID (mobile driver's licence, mDL)
 * through the browser's Digital Credentials API, following ISO/IEC 18013-7 Annex C
 * ("org-iso-mdoc"): the wallet on the phone (Apple Wallet, Google Wallet, a state app)
 * checks that its owner is present (Face ID, fingerprint or passcode) and returns only the
 * fields asked for, signed by the issuing state and encrypted to this service.
 *
 * Mandate never receives a photo, a name or any biometric. It asks for:
 *   document_number, issuing_jurisdiction / issuing_country, expiry_date, age_over_18,
 *   resident_postal_code, resident_city
 * and turns the document into the same keyed fingerprint a clerk desk makes for a licence
 * or state ID, so one person still gets one voter code whichever way they verify.
 *
 * Trust: only credentials whose issuer chain ends at a configured IACA root certificate
 * (the states' published roots, e.g. from AAMVA's Digital Trust Service) are accepted.
 *
 * NOTE: tested end to end against credentials built to the specification with the same
 * library real verifiers use, not yet against a production wallet. Keep it switched off
 * (no MDL_IACA_ROOTS) until it has been tried with real phones.
 */

'use strict';

const crypto = require('crypto');
const { Encoder, Tag } = require('cbor-x');

// Plain, minimal CBOR as wallets expect: real maps with minimal length headers, byte
// strings without extra tags, no cbor-x record extensions.
const cbor = new Encoder({ useRecords: false, mapsAsObjects: true, variableMapSize: true, tagUint8Array: false, pack: false });
const encode = (v) => cbor.encode(v);
const decode = (b) => cbor.decode(b);
const { CipherSuite, DhkemP256HkdfSha256, HkdfSha256, Aes128Gcm } = require('@hpke/core');
const { Verifier, DataItem } = require('@auth0/mdl');

const MDL_DOCTYPE = 'org.iso.18013.5.1.mDL';
const NS = 'org.iso.18013.5.1';
const FIELDS = ['document_number', 'issuing_jurisdiction', 'issuing_country', 'expiry_date', 'age_over_18', 'resident_postal_code', 'resident_city'];

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const suite = () => new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });

/** COSE_Key (EC2, P-256) from a 65-byte uncompressed public key. */
function coseKey(raw) {
  const k = new Map();
  k.set(1, 2); // kty: EC2
  k.set(-1, 1); // crv: P-256
  k.set(-2, Buffer.from(raw.subarray(1, 33)));
  k.set(-3, Buffer.from(raw.subarray(33, 65)));
  return k;
}

/** SessionTranscript for the Digital Credentials API: [null, null, ["dcapi", SHA-256(cbor([encryptionInfo, origin]))]]. */
function sessionTranscript(encryptionInfoB64, origin) {
  const dcapiInfoHash = crypto.createHash('sha256').update(encode([encryptionInfoB64, origin])).digest();
  return [null, null, ['dcapi', dcapiInfoHash]];
}

/**
 * @param {object} o
 * @param {string[]} o.roots         trusted IACA root certificates (PEM)
 * @param {string[]} [o.zips]        accepted resident ZIP codes or prefixes (empty: residency not checked here)
 * @param {string} [o.city]          accepted resident city (case-insensitive), alternative to zips
 * @param {number} [o.ttlMs]         how long a request stays valid (default 5 minutes)
 */
function createMdlVerifier(o) {
  const sessions = new Map(); // id -> { key, encryptionInfo, at, commitment }
  const ttl = o.ttlMs || 5 * 60 * 1000;

  /** Make a request for the browser to pass to navigator.credentials.get({ digital: ... }). */
  async function start(commitment) {
    const s = suite();
    const kp = await s.kem.generateKeyPair();
    const pub = new Uint8Array(await s.kem.serializePublicKey(kp.publicKey));
    const nonce = crypto.randomBytes(16);
    const encryptionInfo = b64u(encode(['dcapi', { nonce, recipientPublicKey: coseKey(pub) }]));
    const items = { docType: MDL_DOCTYPE, nameSpaces: { [NS]: Object.fromEntries(FIELDS.map((f) => [f, false])) } }; // false: not kept
    const deviceRequest = b64u(encode({ version: '1.0', docRequests: [{ itemsRequest: new Tag(encode(items), 24) }] }));
    const id = crypto.randomBytes(16).toString('hex');
    for (const [k, v] of sessions) if (Date.now() - v.at > ttl) sessions.delete(k);
    sessions.set(id, { key: kp.privateKey, encryptionInfo, at: Date.now(), commitment });
    return { session: id, request: { protocol: 'org-iso-mdoc', data: { deviceRequest, encryptionInfo } } };
  }

  /**
   * Decrypt and verify the wallet's answer.
   * @returns {{ commitment, jurisdiction, documentNumber, postalCode, city, expiry }}
   * @throws Error with .userMessage
   */
  async function finish(sessionId, response, origin) {
    const sess = sessions.get(String(sessionId || ''));
    sessions.delete(String(sessionId || ''));
    const fail = (m) => Object.assign(new Error(m), { userMessage: m });
    if (!sess || Date.now() - sess.at > ttl) throw fail('This mobile ID request has expired. Please try again.');
    let enc;
    let cipherText;
    try {
      const outer = decode(unb64u(typeof response === 'string' ? response : response?.response));
      if (!Array.isArray(outer) || outer[0] !== 'dcapi') throw new Error();
      ({ enc, cipherText } = outer[1]);
    } catch {
      throw fail('The wallet sent an answer this service does not understand.');
    }
    const transcript = sessionTranscript(sess.encryptionInfo, origin);
    let deviceResponse;
    try {
      const r = await suite().createRecipientContext({ recipientKey: sess.key, enc: new Uint8Array(enc), info: encode(transcript) });
      deviceResponse = Buffer.from(await r.open(new Uint8Array(cipherText)));
    } catch {
      throw fail('Could not open the wallet\'s answer (it was not made for this request).');
    }
    let mdoc;
    try {
      mdoc = await new Verifier(o.roots).verify(deviceResponse, { encodedSessionTranscript: encode(DataItem.fromData(transcript)) });
    } catch (e) {
      throw Object.assign(fail('This mobile ID could not be verified: it is not from an accepted issuer, or it is not valid.'), { cause: e });
    }
    const doc = mdoc.documents.find((d) => d.docType === MDL_DOCTYPE);
    if (!doc) throw fail('That credential is not a mobile driver\'s licence or state ID.');
    const v = doc.getIssuerNameSpace(NS) || {};
    if (v.age_over_18 !== true) throw fail('Mobile ID sign-up is for adults (18 and over).');
    const expiry = v.expiry_date ? new Date(String(v.expiry_date)) : null;
    if (expiry && expiry.getTime() < Date.now()) throw fail('This mobile ID has expired.');
    const jurisdiction = String(v.issuing_jurisdiction || '').toUpperCase().replace(/^US-/, '') || String(v.issuing_country || '').toUpperCase();
    const documentNumber = String(v.document_number || '');
    if (!jurisdiction || !documentNumber) throw fail('The mobile ID did not share its document number and issuing state.');
    const postalCode = String(v.resident_postal_code || '').slice(0, 5);
    const city = String(v.resident_city || '');
    if ((o.zips || []).length || o.city) {
      const zipOk = (o.zips || []).some((z) => postalCode.startsWith(String(z)));
      const cityOk = o.city && city.toLowerCase() === String(o.city).toLowerCase();
      if (!zipOk && !cityOk) throw fail('The address on this mobile ID is not in this community.');
    }
    return { commitment: sess.commitment, jurisdiction, documentNumber, postalCode, city, expiry };
  }

  return { start, finish, sessionTranscript };
}

module.exports = { createMdlVerifier, sessionTranscript, MDL_DOCTYPE, NS, FIELDS };
