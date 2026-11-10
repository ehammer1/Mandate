/**
 * app/src/explain.js - "Explained in plain language": the AI summary the watchdog
 * published for a poll or mandate (the same one for everyone), and answers to residents'
 * questions from the identity service. Always labelled, always next to the full text.
 */

const files = new Map();

/**
 * @param {object} ctx { state, esc, status }
 * @param {HTMLElement} box
 * @param {'poll'|'mandate'} kind
 * @param {number} id
 */
export async function renderExplainer(ctx, box, kind, id) {
  const { state, esc, status } = ctx;
  const base = state.config.explanationsUrl;
  if (!box || !base) return;
  const contract = (kind === 'poll' ? state.config.voteAddress : state.config.registryAddress).toLowerCase();
  const url = `${base.replace(/\/?$/, '/')}${kind}-${contract}-${id}.json`;
  let e = files.get(url);
  if (e === undefined) {
    try {
      const res = await fetch(`${url}?t=${Math.floor(Date.now() / 300_000)}`);
      e = res.ok ? await res.json() : null;
    } catch {
      e = null;
    }
    files.set(url, e);
  }
  const li = (xs) => (xs || []).map((x) => `<li>${esc(x)}</li>`).join('');
  const body = e
    ? `<p>${esc(e.summary)}</p>
      ${e.changes?.length ? `<p><strong>What changes</strong></p><ul>${e.changes.map((c) => `<li><span class="muted">Now:</span> ${esc(c.before)}<br><span class="muted">After:</span> ${esc(c.after)}</li>`).join('')}</ul>` : ''}
      ${e.affected?.length ? `<p><strong>Who is affected:</strong> ${esc(e.affected.join(', '))}</p>` : ''}
      <p><strong>Cost:</strong> ${esc(e.cost)}<br><strong>When:</strong> ${esc(e.timeline)}</p>
      <div class="row" style="align-items:flex-start"><div style="flex:1;min-width:140px"><p><strong>For</strong></p><ul>${li(e.arguments_for)}</ul></div><div style="flex:1;min-width:140px"><p><strong>Against</strong></p><ul>${li(e.arguments_against)}</ul></div></div>
      ${e.quotes?.length ? `<p><strong>From the text</strong> <span class="muted">(✓ checked word for word)</span></p><ul>${e.quotes.map((q) => `<li>“${esc(q)}”</li>`).join('')}</ul>` : ''}
      ${e.unanswered?.length ? `<p><strong>Not answered by the text</strong></p><ul>${li(e.unanswered)}</ul>` : ''}
      <p class="note">${esc(e.label || 'AI summary')}. Written by ${esc(e.model || 'an AI model')} from the published text only${e.check?.quotesRemoved ? `; ${e.check.quotesRemoved} quote(s) that didn't match the text were removed` : ''}. If something is wrong, say so in the comments.</p>`
    : '<p class="muted">A plain-language explanation appears here shortly after something is published.</p>';
  box.innerHTML = `<details class="explainer"><summary>Explained in plain language (AI)</summary><div class="stack">${body}
      ${state.config.identityService ? `<label for="ask-${kind}-${id}">Ask a question about this</label>
      <div class="row"><input type="text" id="ask-${kind}-${id}" maxlength="500" placeholder="e.g. Who pays for it?" style="flex:1" /><button data-ask>Ask</button></div>
      <div class="answer"></div><p class="status" role="status"></p>` : ''}</div></details>`;
  const btn = box.querySelector('[data-ask]');
  if (!btn) return;
  btn.onclick = async () => {
    const q = box.querySelector('input').value.trim();
    const el = box.querySelector('.status');
    if (q.length < 3) return;
    btn.disabled = true;
    status(el, 'Reading the text…');
    try {
      const res = await fetch(`${state.config.identityService.replace(/\/+$/, '')}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, id, question: q }) });
      const a = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(a.error || `The service answered ${res.status}.`);
      status(el, '');
      box.querySelector('.answer').innerHTML = `<p>${esc(a.answer)}</p>${a.answered_by_text ? '' : '<p class="warn">The text doesn\'t answer this. Ask in the comments, or ask whoever proposed it.</p>'}${a.quotes?.length ? `<ul>${a.quotes.map((x) => `<li>“${esc(x)}” <span class="muted">✓</span></li>`).join('')}</ul>` : ''}<p class="note">AI answer from the published text only.</p>`;
    } catch (err) {
      status(el, err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  };
}
