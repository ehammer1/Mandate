/**
 * app/src/reminders.js - countdown alerts: "closes in 1 day", "8 hours", "1 hour"...
 *
 *   in the app       while the app is open (or installed on the home screen), a
 *                    notification or an on-screen alert at each chosen time before a
 *                    deadline, for items you follow or everything urgent
 *   on your calendar "Add to calendar" puts one item on your phone's calendar with the
 *                    same alerts, so they arrive even when the app is closed
 *
 * Settings stay on this device only.
 */

const KEY = 'mandate.reminders';
export const OFFSETS = [
  [7 * 86_400, '1 week'],
  [86_400, '1 day'],
  [8 * 3600, '8 hours'],
  [3600, '1 hour'],
  [15 * 60, '15 minutes'],
];
const WORD = Object.fromEntries(OFFSETS);

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { offsets: Array.isArray(s.offsets) ? s.offsets : [86_400, 8 * 3600, 3600], scope: s.scope || 'urgent', followed: s.followed || {}, fired: s.fired || {} };
  } catch {
    return { offsets: [86_400, 8 * 3600, 3600], scope: 'urgent', followed: {}, fired: {} };
  }
}
let settings = load();
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode: works for this visit only */
  }
}
export const reminderSettings = () => settings;
export const keyOf = (item) => `${item.kind}:${item.id}`;
export const isFollowed = (item) => !!settings.followed[keyOf(item)];
export function toggleFollow(item) {
  const k = keyOf(item);
  if (settings.followed[k]) delete settings.followed[k];
  else settings.followed[k] = { at: item.at, title: item.title, href: item.href || '' };
  save();
  return !!settings.followed[k];
}

/** "1 day", "8 hours" and "1 hour" before; written for a person. */
export const offsetsText = (list = settings.offsets) => (list.length ? [...list].sort((a, b) => b - a).map((o) => WORD[o] || `${Math.round(o / 60)} minutes`).join(', ') : 'no alerts');

// ------------------------------------------------------------- calendar

const ics = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (secs) => new Date(Number(secs) * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const trigger = (secs) => (secs % 86_400 === 0 ? `-P${secs / 86_400}D` : secs % 3600 === 0 ? `-PT${secs / 3600}H` : `-PT${Math.round(secs / 60)}M`);

/** One deadline as an .ics file with an alert at each chosen time before it. */
export function icsFor(item, offsets = settings.offsets, url = location.href.split('#')[0]) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Promissa//Reminder//EN', 'BEGIN:VEVENT', `UID:${ics(keyOf(item))}-${item.at}@mandate`, `DTSTAMP:${stamp(Date.now() / 1000)}`, `DTSTART:${stamp(item.at - 900)}`, `DTEND:${stamp(item.at)}`, `SUMMARY:${ics(item.calendarTitle || item.title)}`, `DESCRIPTION:${ics(`${item.plain || ''} ${url}`.trim())}`, `URL:${ics(url)}`];
  for (const o of offsets) lines.push('BEGIN:VALARM', `TRIGGER;RELATED=END:${trigger(o)}`, 'ACTION:DISPLAY', `DESCRIPTION:${ics(`${WORD[o] || ''} left: ${item.title}`)}`, 'END:VALARM');
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
export const icsHref = (item) => `data:text/calendar;charset=utf-8,${encodeURIComponent(icsFor(item))}`;

// --------------------------------------------------------------- alerts

let latest = [];
let chainOffset = 0;
/** Give the reminders the current list (from Needs attention) and the chain clock offset. */
export function trackItems(items, offset = 0) {
  latest = items;
  chainOffset = offset;
  check();
}

function due(now) {
  const out = [];
  const pool = new Map();
  for (const i of latest) if (settings.scope === 'all' || (settings.scope === 'urgent' && i.level !== 'upcoming') || isFollowed(i)) pool.set(keyOf(i), i);
  for (const [k, f] of Object.entries(settings.followed)) if (!pool.has(k)) pool.set(k, { ...f, kind: k.split(':')[0], id: k.split(':')[1] });
  for (const [k, i] of pool) {
    const left = Number(i.at) - now;
    if (left <= 0) continue;
    // Every chosen time already reached; alert once, for the nearest one.
    const reached = settings.offsets.filter((o) => left <= o && !settings.fired[`${k}@${i.at}:${o}`]);
    if (!reached.length) continue;
    for (const o of reached) settings.fired[`${k}@${i.at}:${o}`] = 1;
    out.push({ item: i, offset: Math.min(...reached), left });
  }
  return out;
}

function show({ item, left }) {
  const h = left >= 86_400 ? `${Math.round(left / 86_400)} day${Math.round(left / 86_400) === 1 ? '' : 's'}` : left >= 3600 ? `${Math.round(left / 3600)} hour${Math.round(left / 3600) === 1 ? '' : 's'}` : `${Math.max(1, Math.round(left / 60))} minutes`;
  const text = `${h} left: ${item.title}`;
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const n = new Notification('Promissa', { body: text, tag: keyOf(item) });
      n.onclick = () => window.focus();
    }
  } catch {
    /* some browsers only allow notifications from an installed app */
  }
  const box = document.getElementById('toasts');
  if (box) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'alert');
    t.textContent = `⏰ ${text}`;
    const close = document.createElement('button');
    close.textContent = 'OK';
    close.onclick = () => t.remove();
    t.append(close);
    box.append(t);
    while (box.children.length > 3) box.firstElementChild.remove(); // only the latest few
    setTimeout(() => t.remove(), 20_000);
  }
}

export function check() {
  const now = Date.now() / 1000 + chainOffset;
  const list = due(now);
  if (list.length) save();
  for (const d of list) show(d);
  // Forget alerts for deadlines long past.
  for (const k of Object.keys(settings.followed)) if (Number(settings.followed[k].at) < now - 7 * 86_400) delete settings.followed[k];
}
setInterval(check, 30_000);

// ------------------------------------------------------------- settings

/** The reminder settings panel (Account screen and the Needs attention card). */
export function wireSettings(box) {
  if (!box) return;
  const draw = () => {
    const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    box.innerHTML = `<p class="note">Get an alert before deadlines close. Choose when:</p>
      <div class="filters" role="group" aria-label="Alert times">${OFFSETS.map(([o, w]) => `<button data-off="${o}" aria-pressed="${settings.offsets.includes(o)}">${w} before</button>`).join('')}</div>
      <label for="remind-scope">For</label>
      <select id="remind-scope"><option value="urgent"${settings.scope === 'urgent' ? ' selected' : ''}>Urgent and soon items, and anything I follow</option><option value="followed"${settings.scope === 'followed' ? ' selected' : ''}>Only items I follow (tap 🔔 on an item)</option><option value="all"${settings.scope === 'all' ? ' selected' : ''}>Everything with a deadline</option></select>
      ${perm === 'granted' ? '<p class="ok">Notifications are on for this device.</p>' : perm === 'denied' ? '<p class="note">Notifications are blocked for this site in your browser settings; alerts still show here while the app is open.</p>' : perm === 'unsupported' ? '<p class="note">This browser cannot show notifications. On iPhone: Share, then "Add to Home Screen", and open Promissa from there. Or use "Add to calendar" on any item, or the calendar feed below.</p>' : '<button id="btn-notify">Turn on notifications</button>'}
      <p class="note">Alerts arrive while Promissa is open or installed on your home screen. For alerts when it is closed, use "📅 Add to calendar" on an item, or subscribe to the calendar feed (on iPhone, turn off "Remove Alerts" for the subscription in Settings, Calendar, Accounts).</p>`;
    for (const b of box.querySelectorAll('[data-off]')) {
      b.onclick = () => {
        const o = Number(b.dataset.off);
        settings.offsets = settings.offsets.includes(o) ? settings.offsets.filter((x) => x !== o) : [...settings.offsets, o].sort((a, c) => c - a);
        save();
        draw();
      };
    }
    box.querySelector('#remind-scope').onchange = (e) => {
      settings.scope = e.target.value;
      save();
      check();
    };
    const n = box.querySelector('#btn-notify');
    if (n) n.onclick = async () => {
      try {
        await Notification.requestPermission();
      } catch {
        /* ignored */
      }
      draw();
    };
  };
  draw();
}
