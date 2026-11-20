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
