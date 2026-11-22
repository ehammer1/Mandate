/**
 * app/src/aihelp.js - AI that helps people take part, without deciding anything for them:
 *  - "✨ Help me write this": turns rough notes into a clear proposal or candidate statement,
 *    with a feasibility checklist (who is responsible, by when, the cost, how to tell it's
 *    done). The person edits it; nothing is published until they press the usual button.
 *  - "🌐 Translate": a machine translation of a public text, labelled, the original kept.
 *  - "🔊 Read aloud": the device's own voice (no AI, nothing sent anywhere).
 */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const LANGUAGES = [
  ['es', 'Español'], ['zh', '中文'], ['vi', 'Tiếng Việt'], ['tl', 'Tagalog'], ['ko', '한국어'], ['ar', 'العربية'], ['ru', 'Русский'],
  ['ht', 'Kreyòl ayisyen'], ['pt', 'Português'], ['fr', 'Français'], ['hi', 'हिन्दी'], ['so', 'Soomaali'], ['en', 'English'],
];

/** The Promissa Plus token, when this person has signed in to the assistant (its own key, never the voter key). */
export function planToken() {
  try {
    return sessionStorage.getItem('mandate.assistant.token') || '';
  } catch {
    return '';
  }
}

async function call(cfg, path, body) {
  if (!cfg.identityService) throw new Error('AI help is not available here.');
  const res = await fetch(`${cfg.identityService.replace(/\/+$/, '')}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, plan: planToken() }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.error || `AI help answered ${res.status}.`), { plus: !!out.plus });
  return out;
}

/** A free limit was reached: offer Promissa Plus (the assistant plan) without pushing it. */
const plusHtml = () => ' <button type="button" class="link" data-get-plus>Get Promissa Plus</button>';
document.addEventListener?.('click', (e) => {
  if (e.target.closest?.('[data-get-plus]')) document.getElementById('nav-assistant')?.click();
});

export const helpButtonHtml = () => '<button type="button" data-ai-help>✨ Help me write this</button><div data-ai-out class="stack"></div>';

/**
 * Wire "Help me write this" under `root`.
 * @param {{ cfg, kind: 'issue'|'petition'|'poll'|'candidate', lang?: string, read: () => string, apply: ({ title, body }) => void }} o
 */
export function wireHelp(root, o) {
  const b = root.querySelector('[data-ai-help]');
  if (!b) return;
  b.hidden = !o.cfg.identityService;
  b.onclick = async () => {
    const out = root.querySelector('[data-ai-out]');
    const text = o.read().trim();
    if (text.length < 3) return void (out.innerHTML = '<p class="warn">Write your idea in a few words first, in any order.</p>');
    b.disabled = true;
    out.innerHTML = '<p class="muted">Thinking…</p>';
    try {
      const d = await call(o.cfg, '/ai/draft', { kind: o.kind, text, lang: o.lang });
      out.innerHTML = `<div class="card stack"><p class="note">${esc(d.label || 'Suggested by AI')}</p>
        <p><strong>${esc(d.title)}</strong></p><p>${esc(d.body)}</p>${d.goal ? `<p><strong>Done when:</strong> ${esc(d.goal)}</p>` : ''}
        ${d.checklist?.length ? `<ul class="list">${d.checklist.map((c) => `<li>${c.ok ? '✓' : '▲'} ${esc(c.check)}${c.note ? `: ${esc(c.note)}` : ''}</li>`).join('')}</ul>` : ''}
        ${d.questions?.length ? `<p><strong>You may want to add:</strong></p><ul>${d.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
        <div class="row"><button type="button" class="primary" data-ai-use>Use this (then edit)</button> <button type="button" data-ai-keep>Keep mine</button></div></div>`;
      out.querySelector('[data-ai-use]').onclick = () => {
        o.apply({ title: d.title, body: d.goal ? `${d.body}\n\nDone when: ${d.goal}` : d.body });
        out.innerHTML = '<p class="ok">Filled in: read it over and change anything before you publish.</p>';
      };
      out.querySelector('[data-ai-keep]').onclick = () => (out.innerHTML = '');
    } catch (e) {
      out.innerHTML = `<p class="error">${esc(e.message)}${e.plus ? plusHtml() : ''}</p>`;
    } finally {
      b.disabled = false;
    }
  };
}

/** "🌐 Translate" and "🔊 Read aloud" for a public text. */
export function listenTranslateHtml(text) {
  return `<p class="row item-aids" data-aid-text="${esc(String(text).slice(0, 6000))}">
    <button type="button" class="link" data-read-aloud>🔊 Read aloud</button>
    <select data-translate aria-label="Translate"><option value="">🌐 Translate…</option>${LANGUAGES.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></p><div data-translation></div>`;
}

/** Wire every read-aloud and translate control on the page, now and later. */
export function wireAids(cfg) {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-read-aloud]');
    if (!b) return;
    const synth = globalThis.speechSynthesis;
    if (!synth) return void (b.textContent = 'Read aloud is not available on this device');
    if (synth.speaking) return void (synth.cancel(), (b.textContent = '🔊 Read aloud'));
    const u = new SpeechSynthesisUtterance(b.closest('[data-aid-text]').dataset.aidText);
    u.lang = document.documentElement.lang || 'en';
    u.onend = () => (b.textContent = '🔊 Read aloud');
    b.textContent = '⏹ Stop reading';
    synth.speak(u);
  });
  document.addEventListener('change', async (e) => {
    const s = e.target.closest('[data-translate]');
    if (!s || !s.value) return;
    const box = s.closest('[data-aid-text]').nextElementSibling;
    box.innerHTML = '<p class="muted">Translating…</p>';
    try {
      const t = await call(cfg(), '/ai/translate', { text: s.closest('[data-aid-text]').dataset.aidText, lang: s.value });
      box.innerHTML = `<div class="card"><p lang="${esc(s.value)}">${esc(t.text)}</p><p class="note">${esc(t.label || 'Machine translation by AI')}</p></div>`;
    } catch (err) {
      box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  });
}
