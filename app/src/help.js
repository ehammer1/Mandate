/**
 * app/src/help.js - the Help screen (searchable how-tos and a glossary) and "What's this?"
 * links: any element with data-help="<section id>" opens that section.
 */

import { HELP, fillRules } from './help-content.js';
import { collectHtml, translateHtml, t } from './i18n.js';

collectHtml(HELP.map((s) => `<p>${s.title}</p>${s.html}`).join(''));
import { loadRules } from './rules.js';
import { jumpTo } from './copy.js';

export function wireHelp({ state, $, show }) {
  let rules = null;

  async function render(open) {
    if (!rules) rules = await loadRules(state.config, state.provider).catch(() => []);
    const box = $('help-list');
    box.innerHTML = HELP.map((s) => `<details class="card help-section" id="help-${s.id}"${s.id === open ? ' open' : ''}><summary><strong>${t(s.title)}</strong></summary><div class="stack">${fillRules(translateHtml(s.html), rules)}</div></details>`).join('');
    filter($('help-search').value);
  }

  function filter(q) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const d of $('help-list').querySelectorAll('.help-section')) {
      const hit = words.every((w) => d.textContent.toLowerCase().includes(w));
      d.hidden = !hit;
      if (hit) shown++;
      if (words.length && hit) d.open = true;
    }
    $('help-empty').hidden = shown > 0;
  }

  async function open(id) {
    show('screen-help');
    $('help-search').value = '';
    await render(id);
    if (id) jumpTo($(`help-${id}`));
  }

  $('nav-help').onclick = () => open('');
  $('help-search').oninput = () => filter($('help-search').value);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-help]');
    if (!a) return;
    e.preventDefault();
    open(a.dataset.help);
  });
  return { open };
}
