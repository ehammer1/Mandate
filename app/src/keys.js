/**
 * app/src/keys.js - the voter's keys, unlocked with a passkey.
 *
 * One passkey (Face ID, fingerprint, Windows Hello, or a phone PIN) unlocks two
 * independent keys:
 *
 *   voting key  -> the Semaphore identity used for anonymous ballots
 *   account key -> an optional account for play credits and backing mandates
 *
 * Both come from the passkey's PRF output (a secret the authenticator computes
 * for this site), run through HKDF with different labels. They cannot be linked
 * to each other, and nothing secret is ever stored by the app: the passkey
 * recomputes them on every unlock. Passkeys synced by Apple, Google or
 * Microsoft give the same keys on every device the person signs in on, so a
 * phone and a laptop vote as the same person.
 *
 * Browsers or authenticators without PRF support fall back to a device key:
 * a random secret kept in this browser, plus a backup code the person must save
 * to use another device or recover.
 */

import { encodeBackupCode, decodeBackupCode } from './backup-code.mjs';

const PRF_SALT = new TextEncoder().encode('mandate/passkey-prf/v1');
const STORE = 'mandate.keys.v1';

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const random = (n) => crypto.getRandomValues(new Uint8Array(n));

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) || {};
  } catch {
    return {};
  }
}
function save(state) {
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
  } catch {
    /* private mode: the passkey still works, we just can't remember the choice */
  }
}

async function hkdf(secret, label) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('mandate'), info: enc.encode(label) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

// Which community these keys are for. Communities share one web address (and so one passkey),
// so each added community (?org=<slug>) gets its own voter key from the same passkey or backup
// code: the same person's voter codes can't be linked across communities. The original
// community (no slug) keeps the original voter key. The account key (roles, credits) stays
// shared, so an admin's account is the same everywhere.
let community = '';
export function setCommunity(slug) {
  community = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(String(slug || '')) ? String(slug) : '';
}

async function deriveKeys(rootSecret, method) {
  const votingInfo = community ? `mandate/voting/v1/c/${community}` : 'mandate/voting/v1';
  const [voting, account] = await Promise.all([hkdf(rootSecret, votingInfo), hkdf(rootSecret, 'mandate/account/v1')]);
  return { votingKey: voting, accountKeyHex: '0x' + toHex(account), method };
}

export function passkeysAvailable() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
}

/** Remembered method ('passkey' | 'device') and credential id, if any. */
export function savedMethod() {
  return load().method || null;
}

/** True if this browser remembers a Promissa passkey (even if a browser-saved key is in use now). */
/** Is a voter key saved in this browser (the "no passkey" kind)? */
export function hasSavedDeviceKey() {
  return !!load().deviceSecret;
}

export function hasSavedPasskey() {
  return !!load().credentialId;
}

/**
 * Create a passkey for this site and unlock the keys from it.
 * Never makes a second passkey when this browser already knows one: the known
 * credential is excluded, so the phone refuses to create a duplicate and we
 * unlock the existing one instead. (Reusing the same user id would *replace* the
 * passkey and change the voter key, so that is deliberately not done.)
 */
export async function createPasskey({ remember = true, onPhone = false, displayName } = {}) {
  const known = remember ? load().credentialId : null;
  if (known) return unlockWithPasskey();
  const label = displayName || `Promissa voter · ${new Date().toISOString().slice(0, 10)}`;
  // onPhone (shared computers): ask the browser to create the passkey on the person's phone
  // via a QR code, not on this computer.
  const selection = { residentKey: 'required', userVerification: 'required', ...(onPhone ? { authenticatorAttachment: 'cross-platform' } : {}) };
  let cred;
  try {
    cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Promissa' },
      user: { id: random(16), name: label, displayName: label },
      challenge: random(32),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: selection,
      ...(onPhone ? { hints: ['hybrid'] } : {}),
      // Ask for the key at creation too; browsers that support it save a second Face ID prompt.
      extensions: { prf: { eval: { first: PRF_SALT } } },
    },
  });
  } catch (e) {
    // InvalidStateError: this authenticator already holds a credential we excluded.
    if (e?.name === 'InvalidStateError') return unlockWithPasskey();
    throw e;
  }
  const ext = cred.getClientExtensionResults?.() || {};
  if (!ext.prf?.enabled && !ext.prf?.results?.first) {
    throw Object.assign(new Error('This passkey cannot derive keys (no PRF support). Use a device key instead.'), { code: 'NO_PRF' });
  }
  if (remember) save({ ...load(), method: 'passkey', credentialId: b64url(cred.rawId) });
  if (ext.prf?.results?.first) return deriveKeys(new Uint8Array(ext.prf.results.first), remember ? 'passkey' : 'public');
  return unlockWithPasskey({ remember });
}

/**
 * Ask the passkey (Face ID / fingerprint / PIN) to recompute the keys.
 * remember=false (shared or public computers): nothing is read from or written to this
 * browser, and with no saved passkey the browser offers "use a phone" (scan a QR code),
 * so the passkey stays on the person's own phone.
 */
export async function unlockWithPasskey({ remember = true } = {}) {
  const state = remember ? load() : {};
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      userVerification: 'required',
      allowCredentials: state.credentialId ? [{ type: 'public-key', id: fromB64url(state.credentialId) }] : [],
      extensions: { prf: { eval: { first: PRF_SALT } } },
    },
  });
  const out = assertion.getClientExtensionResults?.()?.prf?.results?.first;
  if (!out) throw Object.assign(new Error('The passkey did not return a key. Try another passkey or a device key.'), { code: 'NO_PRF' });
  if (remember) save({ ...state, method: 'passkey', credentialId: b64url(assertion.rawId) });
  return deriveKeys(new Uint8Array(out), remember ? 'passkey' : 'public');
}

/** Fallback: a random secret kept in this browser. Returns keys plus the backup code to show once. */
/**
 * A key kept in this browser, with a backup code. remember=false (shared computers, people
 * without a smartphone): nothing is saved; the backup code is the only copy, to write down
 * or print, and typing it in later restores the same voter.
 */
export async function createDeviceKey({ remember = true } = {}) {
  // Never replace a key already saved here: that would lose the voter and their backup code.
  // (Restoring from a typed backup code is the only way to change it.)
  if (remember && load().deviceSecret) return unlockDeviceKey();
  const secret = random(32);
  if (remember) save({ ...load(), method: 'device', deviceSecret: b64url(secret) }); // keep any known passkey
  return { ...(await deriveKeys(secret, remember ? 'device' : 'public')), backupCode: backupCodeFor(secret) };
}

export async function unlockDeviceKey() {
  const s = load().deviceSecret;
  if (!s) throw new Error('No device key in this browser. Restore one with a backup code.');
  return deriveKeys(fromB64url(s), 'device');
}

/** Written backup code for a secret (see backup-code.mjs). */
export function backupCodeFor(secret) {
  return encodeBackupCode(secret);
}

/** The backup code of the key saved in this browser, to show again (null if there is none). */
export function savedBackupCode() {
  const s = load().deviceSecret;
  return s ? backupCodeFor(fromB64url(s)) : null;
}

export async function restoreFromBackup(code, { remember = true } = {}) {
  const secret = decodeBackupCode(code);
  if (!remember) return deriveKeys(secret, 'public');
  save({ ...load(), method: 'device', deviceSecret: b64url(secret) }); // keep any known passkey
  return deriveKeys(secret, 'device');
}

export function forgetThisDevice() {
  try {
    localStorage.removeItem(STORE);
  } catch {
    /* ignore */
  }
}
