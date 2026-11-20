/**
 * app/src/from-testimonia.js - evidence handed over from Testimonia.
 *
 * Testimonia's "Send to Promissa" uploads a sealed photo or video and its record to IPFS,
 * untouched (re-saving would break the seal), and opens Promissa with
 *
 *   #evidence=<base64url of the evidence text, with its ```testimonia block>
 *
 * The text is held (in this browser, for a day) until the person opens the mandate it's for,
 * where it fills the empty evidence box; they read it, add to it, and submit as usual. The
 * verifier nodes then check the media (broker/media-evidence.js). Nothing is submitted by
 * the link alone.
 */

const KEY = 'promissa.fromTestimonia';
const DAY = 24 * 3600_000;

const fromB64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)));

/** Take evidence from a link, if it has some. Returns true when it did (the address is cleared). */
export function takeEvidenceLink(hash) {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, '')).get('evidence');
  if (!p) return false;
  history.replaceState(null, '', location.pathname + location.search);
  let text;
  try {
    text = fromB64url(p);
  } catch {
    return false;
  }
  if (!/```testimonia\s*\n[\s\S]*?```/.test(text) || text.length > 20_000) return false;
  try {
    localStorage.setItem(KEY, JSON.stringify({ text, at: Date.now() }));
  } catch {
    return false;
  }
  return true;
}

/** Evidence waiting to be used, or null. */
export function pendingEvidence() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!v || Date.now() - v.at > DAY) return null;
    return v.text;
  } catch {
    return null;
  }
}
export function clearPendingEvidence() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Fill empty evidence boxes under `root` with the waiting evidence, and say where it came from. */
export function fillEvidence(root) {
  const text = pendingEvidence();
  if (!text) return;
  for (const box of root.querySelectorAll('textarea[id^="evidence-"]')) {
    if (box.value.trim()) continue;
    box.value = text;
    if (!box.nextElementSibling?.classList?.contains('from-testimonia')) {
      const note = document.createElement('p');
      note.className = 'note from-testimonia';
      note.textContent = 'Filled in from Testimonia: a sealed photo or video, checked by the verifier nodes when you submit. Add what was done, above the block.';
      box.after(note);
    }
  }
}

// ------------------------------------------------------------------ sealed files, handed over
//
// Testimonia's "Send to Promissa" can also hand the sealed files themselves to this tab
// (window.postMessage, browser to browser: no server in between). Promissa then uploads them
// unchanged through its own upload service, as the person's anonymous proof allows, and writes
// the evidence block (attach.js, "Sealed by Testimonia"). Only Testimonia's own sites may hand
// files over, only photos, videos and Testimonia records, and nothing is uploaded until the
// person adds them to a mandate's evidence.
export const TESTIMONIA_ORIGINS = ['https://ehammer1.github.io'];
const OK_TYPES = ['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime', 'application/json'];
let handed = null; // { files: File[] } while this tab is open

/** Files Testimonia handed over and not yet added: File[]. */
export const handedFiles = () => handed?.files || [];
export const clearHandedFiles = () => (handed = null);

/** Accept a hand-off message; returns the number of files taken, or 0. */
export function acceptHandOff(event, origins = TESTIMONIA_ORIGINS) {
  const d = event?.data;
  if (!origins.includes(event?.origin) || d?.type !== 'testimonia-evidence/1' || !Array.isArray(d.files)) return 0;
  const files = d.files
    .filter((f) => f && typeof f.name === 'string' && OK_TYPES.includes(f.type) && f.bytes instanceof ArrayBuffer && f.bytes.byteLength <= 100 * 1024 * 1024)
    .slice(0, 12)
    .map((f) => new File([f.bytes], f.name.replace(/[^\w.\- ]+/g, '_').slice(0, 80), { type: f.type }));
  if (!files.length) return 0;
  handed = { files };
  return files.length;
}

/** When opened by Testimonia for a hand-off: say we're ready, then take what it sends. */
export function listenForHandOff(onFiles, origins = TESTIMONIA_ORIGINS) {
  if (!/(^|[#&])from=testimonia(&|$)/.test(location.hash) || !window.opener) return false;
  history.replaceState(null, '', location.pathname + location.search);
  window.addEventListener('message', (e) => {
    const n = acceptHandOff(e, origins);
    if (n) onFiles(n);
  });
  for (const o of origins) window.opener.postMessage({ type: 'promissa-ready/1' }, o);
  return true;
}
