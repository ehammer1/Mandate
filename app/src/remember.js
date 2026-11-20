/**
 * app/src/remember.js - "Keep me signed in on this device for 30 days".
 *
 * Opt-in, for a person's own phone or computer. The unlocked keys are kept in this browser,
 * encrypted with a key the browser itself cannot export (WebCrypto, held in IndexedDB): the
 * stored copy is useless if copied elsewhere. It does not protect against someone using this
 * browser while it is unlocked, which is why it is opt-in, never offered on shared computers,
 * expires after 30 days and ends at "Sign out".
 */

const DB = 'promissa-remember';
const STORE = 'kept';
export const KEEP_DAYS = 30;

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const slot = (scope) => `keys:${scope || 'main'}`;

/** Keep these unlocked keys on this device for KEEP_DAYS days. */
export async function keep(keys, scope) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify({ v: [...keys.votingKey], a: keys.accountKeyHex, m: keys.method }));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const until = Date.now() + KEEP_DAYS * 86_400_000;
  await run('readwrite', (s) => s.put({ key, iv, ct, until }, slot(scope)));
  return until;
}

/** The kept keys, if any and not expired (else null). */
export async function recall(scope) {
  try {
    const r = await run('readonly', (s) => s.get(slot(scope)));
    if (!r) return null;
    if (Date.now() > r.until) {
      await forget(scope);
      return null;
    }
    const o = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: r.iv }, r.key, r.ct)));
    return { votingKey: new Uint8Array(o.v), accountKeyHex: o.a, method: o.m, kept: true, until: r.until };
  } catch {
    return null; // private mode, storage cleared, or not supported: just sign in as usual
  }
}

/** Stop keeping this person signed in here. */
export async function forget(scope) {
  try {
    await run('readwrite', (s) => s.delete(slot(scope)));
  } catch {
    /* nothing kept */
  }
}
