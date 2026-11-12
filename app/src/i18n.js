/**
 * app/src/i18n.js - English / Español.
 *
 * The app is written in English; in Spanish, every piece of text the app itself shows (screens,
 * buttons, messages, help, dialogs) is swapped for its translation as it appears on the page.
 * Text people write themselves (poll questions, petitions, comments, names) is never in the
 * dictionary, so it stays exactly as written: the original is the official record.
 *
 * A dictionary key is the English text with numbers, dates and addresses replaced by {0}, {1}...
 * ("Poll {0} · closes"), so one entry covers every poll. Dates and numbers are shown in Spanish
 * formats. Elements marked translate="no" (codes, addresses) are left alone.
 */

import ES from './i18n-es.js';

const KEY = 'mandate.lang';
const hasDom = typeof document !== 'undefined';
const store = () => {
  try {
    return hasDom ? window.localStorage : null;
  } catch {
    return null;
  }
};

/** 'es' or 'en': the reader's choice, else the phone's language. */
export function getLang() {
  const saved = store()?.getItem(KEY);
  if (saved === 'es' || saved === 'en') return saved;
  const langs = hasDom ? navigator.languages || [navigator.language] : [];
  return langs.some((l) => /^es\b/i.test(l || '')) ? 'es' : 'en';
}
export let LANG = getLang();
const collecting = hasDom && store()?.getItem('mandate.i18n-collect') === '1';

/** Switch language: in place (keeps the voter's key unlocked) or by reloading the page. */
export function setLang(l, { live = false } = {}) {
  store()?.setItem(KEY, l);
  if (!live) return location.reload();
  LANG = l;
  document.documentElement.lang = l;
  if (l === 'es') {
    done = new WeakMap();
    walk(document.body);
  } else {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 3) {
        if (orig.has(n) && done.get(n) === n.data) n.data = orig.get(n);
        done.set(n, n.data);
      } else {
        for (const a of ATTRS) {
          const k = `orig${a.replace('-', '')}`;
          if (n.dataset?.[k] !== undefined && n.getAttribute(a) === n.dataset[`tr${a.replace('-', '')}`]) n.setAttribute(a, n.dataset[k]);
          if (n.dataset) n.dataset[`tr${a.replace('-', '')}`] = n.getAttribute(a) || '';
        }
      }
    }
  }
  document.title = t(originalTitle);
  for (const el of document.querySelectorAll('#lang-switch')) el.innerHTML = langSwitchHtml();
  document.dispatchEvent(new CustomEvent('langchange', { detail: l }));
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
  if (LANG !== 'es' || !text) return text;
  const k = keyOf(String(text));
  if (!k) return text;
  const tr = ES[k.key];
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
  const k = collecting && keyOf(text);
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
  document.documentElement.lang = LANG;
  // Dates and numbers in Spanish formats; each date shown is remembered as a value.
  const loc = () => (LANG === 'es' ? 'es' : undefined);
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
  if (document.body) go();
  else document.addEventListener('DOMContentLoaded', go, { once: true });
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
  if (LANG !== 'es' || !hasDom) return html;
  const div = document.createElement('div');
  div.innerHTML = html;
  const w = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) n.data = t(n.data);
  return div.innerHTML;
}

/** The English / Español switch. */
export function langSwitchHtml() {
  if (!Object.keys(ES).length) return ''; // no translation yet
  return `<button type="button" class="lang-switch" data-lang="${LANG === 'es' ? 'en' : 'es'}" translate="no" lang="${LANG === 'es' ? 'en' : 'es'}">${LANG === 'es' ? 'English' : 'Español'}</button>`;
}
export function wireLangSwitch(root = document, opts = {}) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (b) setLang(b.dataset.lang, opts);
  });
}

/** Countdown words ("in", "ago", "just now") and their labels. */
export const rel = {
  now: () => (LANG === 'es' ? 'ahora mismo' : 'just now'),
  future: (s) => (LANG === 'es' ? `en ${s}` : `in ${s}`),
  past: (s) => (LANG === 'es' ? `hace ${s}` : `${s} ago`),
  prefix: (p) => {
    if (!p) return p;
    note(p);
    return t(p);
  },
};
