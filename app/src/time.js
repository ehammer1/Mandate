/**
 * app/src/time.js - live countdowns and "time ago": <span data-countdown="unix seconds">,
 * updated every second while the page is open.
 */

function span(secs) {
  const d = Math.abs(secs);
  const days = Math.floor(d / 86_400);
  const h = Math.floor((d % 86_400) / 3600);
  const m = Math.floor((d % 3600) / 60);
  const s = Math.floor(d % 60);
  if (days) return `${days}d ${h}h ${String(m).padStart(2, '0')}m`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// Seconds the blockchain's clock is ahead of this device's (block times are what the contracts use).
let offset = 0;
const nowSecs = () => Date.now() / 1000 + offset;
/** Seconds the chain's clock is ahead of this device. */
export const clockOffset = () => offset;
/** Colour a countdown by how close it is: under a day "soon", under an hour "urgent". */
function mark(el, at, now) {
  const left = Number(at) - now;
  el.classList.toggle('urgent', left > 0 && left < 3600);
  el.classList.toggle('soon', left >= 3600 && left < 86_400);
}

/** "in 2d 3h 05m" before the moment, "4m 10s ago" after it. */
export function relative(at, now = nowSecs()) {
  const diff = Number(at) - now;
  if (Math.abs(diff) < 5) return 'just now';
  return diff >= 0 ? `in ${span(diff)}` : `${span(diff)} ago`;
}

/** A live countdown element. `label` wraps it, e.g. countdown(t) or countdown(t, 'closes ') */
export function countdown(at, prefix = '') {
  return `<span class="countdown" data-countdown="${Number(at)}" data-prefix="${prefix}">${prefix}${relative(at)}</span>`;
}

let timer;
let source;
const sync = () => source?.getBlock('latest').then((b) => { if (b) offset = Number(b.timestamp) - Date.now() / 1000; }).catch(() => {});
/** Start updating every countdown each second; with a provider, follow the chain's clock. */
export function startTicker(provider) {
  if (provider) {
    const first = !source;
    source = provider;
    sync();
    if (first) setInterval(sync, 30_000);
  }
  if (timer) return;
  timer = setInterval(() => {
    const now = nowSecs();
    for (const el of document.querySelectorAll('[data-countdown]')) {
      el.textContent = `${el.dataset.prefix || ''}${relative(el.dataset.countdown, now)}`;
      mark(el, el.dataset.countdown, now);
    }
  }, 1000);
}
