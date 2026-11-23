/**
 * app/src/i18n.js - the app in the reader's language.
 *
 * The app is written in English; in another language, every piece of text the app itself shows
 * (screens, buttons, messages, help, dialogs) is swapped for its translation as it appears on the
 * page. Text people write themselves (poll questions, petitions, comments, names) is never in the
 * dictionary, so it stays exactly as written: the original is the official record.
 *
 * A dictionary key is the English text with numbers, dates and addresses replaced by {0}, {1}...
 * ("Poll {0} · closes"), so one entry covers every poll. A value may also be a set of plural
 * forms ({ one, few, many, other }) chosen by the first number. Dates and numbers are shown in the
 * language's own formats; Arabic, Persian, Urdu and Hebrew read right to left. Elements marked
 * translate="no" (codes, addresses) are left alone.
 *
 * Spanish is built in. Other languages are files in app/i18n/<code>.json, loaded only when chosen;
 * app/i18n/index.json lists them, with "draft" for machine translations not yet reviewed. Each
 * community lists the languages its government uses (config "languages"); see docs/languages.md.
 */

import ES from './i18n-es.js';
import INDEX from '../i18n/index.json';
import { LANG_NAMES, closestLang } from './i18n-names.js';

export { LANG_NAMES };

const RTL = new Set(['ar', 'fa', 'ur', 'he']);
const KEY = 'mandate.lang';
const hasDom = typeof document !== 'undefined';
const store = () => {
  try {
    return hasDom ? window.localStorage : null;
  } catch {
    return null;
  }
};

const DICTS = { es: ES };
const META = { es: { status: 'reviewed' } };
/** Languages with a dictionary: English, Spanish, and those in app/i18n/index.json. */
export const AVAILABLE = ['en', ...(Object.keys(ES).length ? ['es'] : []), ...Object.keys(INDEX || {}).filter((k) => k !== 'en' && k !== 'es')];
let community = null; // this community's languages (config "languages"), once known

/** The closest available language for a browser language tag (zh-TW → zh-Hant, es-MX → es). */
export const matchLang = (tag, available = AVAILABLE) => closestLang(tag, available);

/** The reader's choice, else the phone's language, else English. */
export function getLang() {
  const saved = store()?.getItem(KEY);
  if (saved && AVAILABLE.includes(saved)) return saved;
  const langs = hasDom ? navigator.languages || [navigator.language] : [];
  for (const l of langs) {
    const m = matchLang(l);
    if (m) return m;
  }
  return 'en';
}
export let LANG = getLang();
const collecting = hasDom && store()?.getItem('mandate.i18n-collect') === '1';
const dict = () => DICTS[LANG];

/** Load a language's dictionary (Spanish is built in). Resolves false if it can't be loaded. */
export async function loadDict(l) {
  if (l === 'en' || DICTS[l]) return true;
  try {
    const res = await fetch(new URL(`i18n/${encodeURIComponent(l)}.json`, location.href));
    if (!res.ok) return false;
    const d = await res.json();
    DICTS[l] = d.entries || {};
    META[l] = d.meta || {};
    return true;
  } catch {
    return false;
  }
}

function setDocLang(l) {
  document.documentElement.lang = l;
  document.documentElement.dir = RTL.has(l) ? 'rtl' : 'ltr';
}

/** Put the page back in English (before showing it in another language). */
function restoreEnglish() {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === 3) {
      if (orig.has(n) && done.get(n) === n.data) n.data = orig.get(n);
      done.set(n, n.data);
    } else if (n.dataset) {
      for (const a of ATTRS) {
        const k = a.replace('-', '');
        if (n.dataset[`orig${k}`] !== undefined && n.getAttribute(a) === n.dataset[`tr${k}`]) n.setAttribute(a, n.dataset[`orig${k}`]);
        delete n.dataset[`tr${k}`]; // so the next language translates it again
      }
    }
  }
}

/** Show the whole page (again) in the current language. */
function showInLang() {
  if (LANG !== 'en') {
    done = new WeakMap();
    walk(document.body);
  }
  document.title = t(originalTitle);
  for (const el of document.querySelectorAll('#lang-switch')) el.innerHTML = langSwitchHtml();
}

/** Switch language: in place (keeps the voter's key unlocked) or by reloading the page. */
export async function setLang(l, { live = false } = {}) {
  if (!AVAILABLE.includes(l)) return;
  store()?.setItem(KEY, l);
  if (!live) return location.reload();
  if (!(await loadDict(l))) return;
  restoreEnglish();
  LANG = l;
  setDocLang(l);
  showInLang();
  document.dispatchEvent(new CustomEvent('langchange', { detail: l }));
}

/** This community's languages, from its config: the switch offers these (and the one in use). */
export function setLanguages(list) {
  if (!Array.isArray(list) || !list.length) return;
  community = list.map((x) => matchLang(x, Object.keys(LANG_NAMES)) || String(x)).filter((x, i, a) => a.indexOf(x) === i);
  if (hasDom) for (const el of document.querySelectorAll('#lang-switch')) el.innerHTML = langSwitchHtml();
}

// ---------------------------------------------------------------- keys

const dates = new Set(); // every date/time string the app formatted, to treat as a value
const TOKEN = /nb:0x[0-9a-fA-F]+|0x[0-9a-fA-F]{3,}(?:…[0-9a-fA-F]{2,})?|\d+(?:[.,:]\d+)*/g;

// A value's place in the text, as characters no number pattern can match.
const mark = (i) => `\uE000${String.fromCharCode(0xe100 + i)}`;

/** English text → { key, vals } (null if it has no words to translate). */
function keyOf(text) {
  let core = text.replace(/\s+/g, ' ').trim();
  if (!/[A-Za-z]{2}/.test(core)) return null;
  const vals = [];
  if (dates.size) {
    for (const d of [...dates].sort((a, b) => b.length - a.length)) {
      if (!core.includes(d)) continue;
      core = core.split(d).join(mark(vals.length));
      vals.push(d);
    }
  }
  core = core.replace(TOKEN, (m) => mark(vals.push(m) - 1));
  // Renumber in reading order, so the key doesn't depend on which values were dates.
  const order = [];
  const key = core.replace(/\uE000([\uE100-\uEFFF])/g, (_, c) => `{${order.push(vals[c.charCodeAt(0) - 0xe100]) - 1}}`);
  return { key, vals: order };
}

/** Translate one piece of app text (keeps surrounding spaces); unknown text comes back as is. */
export function t(text) {
  if (LANG === 'en' || !text || !dict()) return text;
  const k = keyOf(String(text));
  if (!k) return text;
  let tr = dict()[k.key];
  if (tr && typeof tr === 'object') {
    // Plural forms, chosen by the first number in the text.
    const n = Number(String(k.vals[0] ?? '').replace(/,/g, ''));
    tr = tr[new Intl.PluralRules(LANG).select(Number.isFinite(n) ? n : 0)] ?? tr.other;
  }
  if (tr === undefined) {
    // Status lines are built from pieces ("Closed · passed · Members"): translate piece by piece.
    const parts = String(text).split(' · ');
    return parts.length > 1 ? parts.map((x) => t(x)).join(' · ') : text;
  }
  const out = tr.replace(/\{(\d+)\}/g, (_, i) => k.vals[Number(i)] ?? '');
  return String(text).match(/^\s*/)[0] + out + String(text).match(/\s*$/)[0];
}

// ---------------------------------------------------------------- the page

const seen = new Set();
let done = new WeakMap(); // node -> the text we last put there
const orig = new WeakMap(); // node -> its English text
let originalTitle = '';
const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);

function skipped(el) {
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    if (SKIP.has(e.tagName) || e.getAttribute('translate') === 'no' || e.isContentEditable || e.classList.contains('code') || e.classList.contains('addr')) return true;
  }
  return false;
}

function note(text) {
  const k = collecting && LANG === 'en' && keyOf(text); // only English text makes a key
  if (k) seen.add(k.key);
}

function doText(node) {
  if (done.get(node) === node.data || !node.parentElement || skipped(node.parentElement)) return;
  orig.set(node, node.data); // new English text from the app
  note(node.data);
  const out = t(node.data);
  if (out !== node.data) node.data = out;
  done.set(node, node.data);
}

function doAttrs(el) {
  if (skipped(el)) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v || el.dataset[`tr${a.replace('-', '')}`] === v) continue;
    el.dataset[`orig${a.replace('-', '')}`] = v;
    note(v);
    const out = t(v);
    if (out !== v) el.setAttribute(a, out);
    el.dataset[`tr${a.replace('-', '')}`] = out;
  }
}

function walk(root) {
  if (root.nodeType === 3) return doText(root);
  if (root.nodeType !== 1) return;
  doAttrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === 3) doText(n);
    else doAttrs(n);
  }
}

/** Show the page in the reader's language: call once at start, before anything renders. */
export function startI18n() {
  if (!hasDom) return;
  setDocLang(LANG);
  // Pop-up questions and messages too (confirm, alert, prompt).
  for (const fn of ['confirm', 'alert', 'prompt']) {
    const orig = window[fn]?.bind(window);
    if (orig) window[fn] = (m, ...rest) => orig(typeof m === 'string' ? t(m) : m, ...rest);
  }
  // Dates and numbers in the language's formats; each date shown is remembered as a value.
  const loc = () => (LANG === 'en' ? undefined : LANG);
  for (const f of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
    const orig = Date.prototype[f];
    Date.prototype[f] = function (l, o) {
      const s = orig.call(this, l ?? loc(), o);
      dates.add(s);
      return s;
    };
  }
  const num = Number.prototype.toLocaleString;
  Number.prototype.toLocaleString = function (l, o) {
    return num.call(this, l ?? loc(), o);
  };
  for (const f of ['confirm', 'alert', 'prompt']) {
    const orig = window[f].bind(window);
    window[f] = (msg, ...rest) => {
      note(String(msg ?? ''));
      return orig(t(String(msg ?? '')), ...rest);
    };
  }
  const go = () => {
    originalTitle = document.title;
    note(document.title);
    document.title = t(document.title);
    walk(document.body);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') doText(m.target);
        else if (m.type === 'attributes') doAttrs(m.target);
        else for (const n of m.addedNodes) walk(n);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  };
  // A language whose dictionary is a separate file: show the page in it once it has loaded.
  const ready = () => (DICTS[LANG] || LANG === 'en' ? Promise.resolve() : loadDict(LANG).then((ok) => ok && document.body && showInLang()));
  if (document.body) go();
  else document.addEventListener('DOMContentLoaded', go, { once: true });
  ready();
  if (collecting) window.__i18nSeen = seen;
}

/** Collect mode: also note text that is only shown on demand (help pages). */
export function collectHtml(html) {
  if (!collecting) return;
  const div = document.createElement('div');
  div.innerHTML = html;
  const w = document.createTreeWalker(div, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === 3) note(n.data);
    else for (const a of ATTRS) if (n.getAttribute(a)) note(n.getAttribute(a));
  }
}

/** Translate an HTML snippet's text before it is shown (help pages, whose rule values are filled in after). */
export function translateHtml(html) {
  if (LANG === 'en' || !hasDom) return html;
  const div = document.createElement('div');
  div.innerHTML = html;
  const w = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) n.data = t(n.data);
  return div.innerHTML;
}

/** The language switch: a button for two languages, a list for more. */
export function langSwitchHtml() {
  const offered = (community || AVAILABLE).filter((l) => AVAILABLE.includes(l));
  if (!offered.includes(LANG)) offered.push(LANG);
  if (offered.length < 2) return '';
  const draft = META[LANG]?.status === 'draft' ? ' <span class="note">Machine translation, under review</span>' : '';
  if (offered.length === 2) {
    const other = offered.find((l) => l !== LANG);
    return `<button type="button" class="lang-switch" data-lang="${other}" translate="no" lang="${other}">${LANG_NAMES[other] || other}</button>${draft}`;
  }
  return `<select class="lang-switch" data-lang-select aria-label="Language" translate="no">${offered.map((l) => `<option value="${l}" lang="${l}"${l === LANG ? ' selected' : ''}>${LANG_NAMES[l] || l}</option>`).join('')}</select>${draft}`;
}
export function wireLangSwitch(root = document, opts = {}) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (b) setLang(b.dataset.lang, opts);
  });
  root.addEventListener('change', (e) => {
    const s = e.target.closest('[data-lang-select]');
    if (s) setLang(s.value, opts);
  });
}

/** Countdown words ("in", "ago", "just now") and their labels. */
export const rel = {
  now: () => (LANG === 'es' ? 'ahora mismo' : LANG !== 'en' && dict()?.__now ? dict().__now : 'just now'),
  future: (x) => (LANG === 'es' ? `en ${x}` : LANG !== 'en' && dict()?.__future ? dict().__future.replace('{s}', x) : `in ${x}`),
  past: (x) => (LANG === 'es' ? `hace ${x}` : LANG !== 'en' && dict()?.__past ? dict().__past.replace('{s}', x) : `${x} ago`),
  prefix: (p) => {
    if (!p) return p;
    note(p);
    return t(p);
  },
};
