/**
 * app/src/assistant.js - the Assistant screen: an AI guide to Promissa (services/assistant).
 *
 * Off until the person turns it on. Its tools run here, in the browser, and send only public
 * records (titles, texts, statuses) and app settings (voter key yes/no, roles, language,
 * rules); never the voter key, the backup code, or votes. It signs in with an "assistant
 * key" made for this alone (not the voter key), so using or paying for it can't be linked
 * to a vote. The conversation lives in this page only.
 */

import { listRecords } from './search.js';
import { loadRules } from './rules.js';
import { getLang } from './i18n.js';
import { copyBtn, wireCopy } from './copy.js';

const ON = 'mandate.assistant.on';
const SCREENS = { polls: 'nav-polls', petitions: 'nav-petitions', mandates: 'nav-mandates', budget: 'nav-budget', bodies: 'nav-bodies', rules: 'nav-rules', search: 'nav-search', help: 'nav-help', account: 'nav-account' };

// ---- the assistant key: ECDSA P-256, made in this browser, can't be copied out of it.
function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('mandate-assistant', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kv(op, key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', op === 'get' ? 'readonly' : 'readwrite');
    const r = op === 'get' ? tx.objectStore('kv').get(key) : tx.objectStore('kv').put(value, key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function assistantKey() {
  let k = await kv('get', 'key');
  if (!k) {
    k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    await kv('put', 'key', k);
  }
  return k;
}
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

export function wireAssistant({ state, $, esc, show, status, open }) {
  const base = () => (state.config?.assistantService || '').replace(/\/+$/, '');
  let token = sessionStorage.getItem('mandate.assistant.token') || '';
  let plan = null;
  let messages = [];
  let busy = false;

  const api = async (path, body, method = 'POST', again = true) => {
    const res = await fetch(`${base()}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401 && token && again) {
      // The 12-hour sign-in ran out: sign in again with the assistant key, once.
      token = '';
      sessionStorage.removeItem('mandate.assistant.token');
      await signIn();
      return api(path, body, method, false);
    }
    if (j.plan) plan = j.plan;
    if (!res.ok) throw Object.assign(new Error(j.error || `The assistant answered ${res.status}.`), { status: res.status });
    return j;
  };

  async function signIn() {
    const key = await assistantKey();
    const { challenge } = await api('/v1/challenge');
    const spki = await crypto.subtle.exportKey('spki', key.publicKey);
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(`promissa-assistant/1|${challenge}`));
    const out = await api('/v1/signin', { publicKey: b64(spki), challenge, signature: b64(sig) });
    token = out.token;
    sessionStorage.setItem('mandate.assistant.token', token);
    plan = out.plan;
  }
  const signedIn = async () => {
    if (!token) await signIn();
  };

  function renderPlan() {
    const p = plan;
    $('assistant-plan').innerHTML = !p
      ? ''
      : p.subscribed
        ? `<span>Subscribed${p.renews ? `, renews ${esc(new Date(p.renews).toLocaleDateString())}` : p.paidUntil ? ` until ${esc(new Date(p.paidUntil).toLocaleDateString())}` : ''}.</span>${p.manage ? ' <button class="link" data-plan="portal">Manage subscription</button>' : ''}`
        : `<span>${p.freeLeft} of ${p.freePerDay} free questions left today.</span> <button data-plan="checkout">Subscribe</button> <button class="link" data-plan="code">Have a code?</button>`;
    for (const b of $('assistant-plan').querySelectorAll('[data-plan]')) b.onclick = () => planAction(b.dataset.plan).catch((e) => status($('assistant-status'), e.message, 'error'));
  }
  async function planAction(what) {
    await signedIn();
    if (what === 'code') {
      $('assistant-code-row').hidden = false;
      return $('assistant-code').focus();
    }
    const { url } = await api(what === 'portal' ? '/v1/portal' : '/v1/checkout');
    location.href = url;
  }
  $('assistant-redeem').onclick = async () => {
    try {
      await signedIn();
      plan = await api('/v1/redeem', { code: $('assistant-code').value.trim() });
      $('assistant-code-row').hidden = true;
      status($('assistant-status'), 'Code added.', 'ok');
      renderPlan();
    } catch (e) {
      status($('assistant-status'), e.message, 'error');
    }
  };

  // ---- the conversation
  const log = () => $('assistant-log');
  function addBubble(who, html) {
    const d = document.createElement('div');
    d.className = `assistant-msg ${who}`;
    d.innerHTML = html;
    log().append(d);
    d.scrollIntoView({ block: 'end' });
    return d;
  }
  const textHtml = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

  function actionButton({ action, target, label, text }) {
    if (action === 'draft') {
      const d = addBubble('draft', `<p><strong>${esc(label || 'Draft')}</strong></p><pre class="draft">${esc(text)}</pre>${copyBtn(text, 'Copy')}`);
      wireCopy(d);
      return 'Shown as a draft with a copy button.';
    }
    const d = addBubble('action', `<button>${esc(label || 'Open')}</button>`);
    d.querySelector('button').onclick = () => {
      if (action === 'screen') {
        if (target === 'code') return show('screen-code');
        return $(SCREENS[target] || 'nav-help')?.click();
      }
      const hash = action === 'help' ? `#help-${target}` : `#${target.replace(/^#/, '')}`;
      if (location.hash === hash) open(hash);
      else location.hash = hash;
    };
    return 'Shown as a button; nothing happens until the person taps it.';
  }

  async function runTool(b) {
    const i = b.input || {};
    if (b.name === 'list_items') {
      const all = await listRecords(state);
      const words = String(i.words || '').toLowerCase().split(/\s+/).filter(Boolean);
      const rows = all.filter((x) => (i.kind === 'all' ? !/^(help|official|body|council-members|prevcouncil-members)$/.test(x.kind) : x.kind === i.kind) && words.every((w) => x.hay.includes(w)));
      return JSON.stringify(rows.slice(0, 40).map((x) => ({ kind: x.kind, id: x.id, title: x.title, status: x.status, open: x.hash.slice(1) })));
    }
    if (b.name === 'read_item') {
      const x = (await listRecords(state)).find((r) => r.kind === i.kind && Number(r.id) === Number(i.id));
      if (!x) return `No ${i.kind} ${i.id} in this community's recent records.`;
      return JSON.stringify({ kind: x.kind, id: x.id, title: x.title, status: x.status, text: String(x.extra || '').slice(0, 12_000), open: x.hash.slice(1) });
    }
    if (b.name === 'app_status') {
      const rules = state.rules?.length ? state.rules : await loadRules(state.config, state.provider).catch(() => []);
      const r = state.roles || {};
      return JSON.stringify({
        community: document.getElementById('community-name')?.textContent || state.config?.name || 'Promissa',
        hasVoterKey: !!state.identity,
        roles: Object.keys(r).filter((k) => r[k] === true),
        language: getLang(),
        rules: rules.map((x) => ({ rule: x.label, value: x.shown })),
      });
    }
    if (b.name === 'propose_action') return actionButton(i);
    return 'Unknown tool.';
  }

  async function send(text) {
    if (busy || !text.trim()) return;
    busy = true;
    $('assistant-send').disabled = true;
    status($('assistant-status'), 'Thinking…');
    addBubble('me', textHtml(text));
    const before = messages.length;
    messages.push({ role: 'user', content: [{ type: 'text', text }] });
    try {
      await signedIn();
      for (let round = 0; round < 8; round++) {
        const out = await api('/v1/turn', { messages });
        renderPlan();
        messages.push({ role: 'assistant', content: out.content });
        for (const b of out.content) if (b.type === 'text' && b.text.trim()) addBubble('ai', textHtml(b.text));
        const calls = out.content.filter((b) => b.type === 'tool_use');
        if (out.stop_reason !== 'tool_use' || !calls.length) break;
        const results = [];
        for (const c of calls) {
          let content;
          let isError = false;
          try {
            content = await runTool(c);
          } catch (e) {
            content = `That didn't work: ${e.message}`;
            isError = true;
          }
          results.push({ type: 'tool_result', tool_use_id: c.id, content, ...(isError ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
      }
      status($('assistant-status'), '');
    } catch (e) {
      messages.length = before; // the question can be asked again
      status($('assistant-status'), e.message, 'error');
      renderPlan();
    } finally {
      busy = false;
      $('assistant-send').disabled = false;
    }
  }

  $('assistant-form').onsubmit = (e) => {
    e.preventDefault();
    const q = $('assistant-input').value;
    $('assistant-input').value = '';
    send(q);
  };
  $('assistant-new').onclick = () => {
    messages = [];
    log().innerHTML = '';
    status($('assistant-status'), '');
  };
  $('assistant-turn-on').onclick = () => {
    localStorage.setItem(ON, '1');
    render();
  };
  $('assistant-turn-off').onclick = () => {
    localStorage.removeItem(ON);
    messages = [];
    log().innerHTML = '';
    render();
  };

  async function render() {
    const on = localStorage.getItem(ON) === '1';
    $('assistant-intro').hidden = on;
    $('assistant-chat').hidden = !on;
    if (on && !plan) {
      try {
        await signedIn();
        if (!plan) plan = await api('/v1/plan', null, 'GET');
      } catch (e) {
        status($('assistant-status'), e.message, 'error');
      }
    }
    renderPlan();
  }

  const nav = $('nav-assistant');
  return {
    /** Show the nav button when this community has an assistant service. */
    refresh() {
      nav.hidden = !base();
    },
    async open() {
      show('screen-assistant');
      await render();
      if (/^#assistant-subscribed/.test(location.hash)) status($('assistant-status'), 'Thanks: you’re subscribed. It can take a moment to show.', 'ok');
    },
  };
}
