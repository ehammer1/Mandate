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

async function deriveKeys(rootSecret, method) {
  const [voting, account] = await Promise.all([hkdf(rootSecret, 'mandate/voting/v1'), hkdf(rootSecret, 'mandate/account/v1')]);
  return { votingKey: voting, accountKeyHex: '0x' + toHex(account), method };
}

export function passkeysAvailable() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
}

/** Remembered method ('passkey' | 'device') and credential id, if any. */
export function savedMethod() {
  return load().method || null;
}

/** True if this browser remembers a Mandate passkey (even if a browser-saved key is in use now). */
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
export async function createPasskey(displayName) {
  const known = load().credentialId;
  if (known) return unlockWithPasskey();
  const label = displayName || `Mandate voter · ${new Date().toISOString().slice(0, 10)}`;
  let cred;
  try {
    cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Mandate' },
      user: { id: random(16), name: label, displayName: label },
      challenge: random(32),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: {} },
    },
  });
  } catch (e) {
    // InvalidStateError: this authenticator already holds a credential we excluded.
    if (e?.name === 'InvalidStateError') return unlockWithPasskey();
    throw e;
  }
  const ext = cred.getClientExtensionResults?.() || {};
  if (!ext.prf?.enabled) {
    throw Object.assign(new Error('This passkey cannot derive keys (no PRF support). Use a device key instead.'), { code: 'NO_PRF' });
  }
  save({ method: 'passkey', credentialId: b64url(cred.rawId) });
  return unlockWithPasskey();
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
export async function createDeviceKey() {
  const secret = random(32);
  save({ ...load(), method: 'device', deviceSecret: b64url(secret) }); // keep any known passkey
  return { ...(await deriveKeys(secret, 'device')), backupCode: backupCodeFor(secret) };
}

export async function unlockDeviceKey() {
  const s = load().deviceSecret;
  if (!s) throw new Error('No device key in this browser. Restore one with a backup code.');
  return deriveKeys(fromB64url(s), 'device');
}

/** Backup codes: "MV1-" + base64url secret, grouped for reading aloud or writing down. */
export function backupCodeFor(secret) {
  return 'MV1-' + b64url(secret).match(/.{1,6}/g).join('-');
}

export async function restoreFromBackup(code) {
  const raw = String(code).trim().replace(/^MV1-/i, '').replace(/[-\s]/g, '');
  let secret;
  try {
    secret = fromB64url(raw);
  } catch {
    throw new Error('That backup code is not valid.');
  }
  if (secret.length !== 32) throw new Error('That backup code is not valid.');
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
