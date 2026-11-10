/**
 * client/clerk.js - shared by the clerk desk (browser) and the identity service (Node).
 *
 *  - Voter-code QR payloads: what the voter's phone shows and the desk scans.
 *  - ID document canonical form: the same document always yields the same text, so
 *    the service's fingerprint (HMAC with its secret pepper) matches at every desk and
 *    one document can back only one voter code.
 *  - Clerk desk session message: signed once by the clerk's account, then reused for
 *    every fingerprint request until it expires.
 */

'use strict';

// BN254 scalar field: every Semaphore identity commitment is below this.
const FIELD = 21888242871839275222246405745257275088548364400416873803624922411808186133249n;
const QR_PREFIX = 'MANDATE:';

/** Text to put in the voter-code QR (uppercase + digits: QR "alphanumeric" mode, small and robust). */
function voterCodeQr(commitment) {
  return QR_PREFIX + BigInt(commitment).toString();
}

/**
 * Read a voter code from a scan or from typing/pasting. Accepts "MANDATE:<digits>" or bare
 * digits, ignoring spaces and line breaks.
 * @returns {bigint}
 * @throws Error with a message fit to show the clerk
 */
function parseVoterCode(text) {
  let t = String(text || '').trim();
  if (t.toUpperCase().startsWith(QR_PREFIX)) t = t.slice(QR_PREFIX.length);
  t = t.replace(/\s+/g, '');
  if (!/^\d{1,78}$/.test(t)) throw new Error("That isn't a Mandate voter code. Ask the person to open \"My voter code\" in the app.");
  const c = BigInt(t);
  if (c === 0n || c >= FIELD) throw new Error("That isn't a valid voter code. Please scan it again.");
  return c;
}

/**
 * Kinds of document. A driver's licence, a state ID card and a mobile ID from the same state
 * share one number series in most states, so they count as one kind: whichever the person
 * brings, they get the same fingerprint.
 */
const DOC_KINDS = {
  state: "Driver's licence, state ID or mobile ID",
  passport: 'Passport or passport card',
  other: 'Other government photo ID',
};

/**
 * @param {{ kind: string, region: string, number: string }} doc
 *   region: issuing US state (2 letters) for state IDs; issuing country (2-3 letters) for passports
 * @returns {string} canonical text, e.g. "doc|v1|state|CA|D1234567"
 */
function canonicalDoc({ kind, region, number }) {
  if (!Object.hasOwn(DOC_KINDS, kind)) throw new Error('Choose the type of ID.');
  const r = String(region || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (r.length < 2 || r.length > 3) throw new Error(kind === 'state' ? 'Enter the state that issued the ID, e.g. CA.' : 'Enter the issuing country, e.g. US.');
  const n = String(number || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (n.length < 4 || n.length > 30) throw new Error('Enter the ID number exactly as printed on the document.');
  return `doc|v1|${kind}|${r}|${n}`;
}

/** What the clerk's account signs to open a desk session (no personal data in it). */
function clerkSessionMessage({ serviceUrl, address, expires }) {
  return [
    'Mandate clerk desk',
    'Open a session to fingerprint ID documents.',
    `Service: ${String(serviceUrl).replace(/\/+$/, '')}`,
    `Clerk: ${address}`,
    `Valid until: ${new Date(Number(expires)).toISOString()}`,
  ].join('\n');
}

const CLERK_SESSION_MAX_MS = 12 * 3600 * 1000;

module.exports = { FIELD, voterCodeQr, parseVoterCode, DOC_KINDS, canonicalDoc, clerkSessionMessage, CLERK_SESSION_MAX_MS };
