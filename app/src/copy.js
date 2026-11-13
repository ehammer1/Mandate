/**
 * app/src/copy.js - one-tap copying of addresses, codes and links, and a small "jump to"
 * helper that scrolls to an item and highlights it.
 */
import { appBase } from './community.js';

const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A small Copy button for `text`. */
export const copyBtn = (text, label = 'Copy') => `<button type="button" class="copy" data-copy="${escAttr(text)}" aria-label="${escAttr(`${label}: ${text}`)}">${escAttr(label)}</button>`;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers: select and copy from a hidden field.
    const t = document.createElement('textarea');
    t.value = text;
    t.setAttribute('readonly', '');
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.append(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
}

/** Every [data-copy] button on the page, now and later. */
export function wireCopy(root = document) {
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    e.preventDefault();
    const label = b.textContent;
    b.textContent = (await copyText(b.dataset.copy)) ? 'Copied ✓' : 'Copy failed';
    b.classList.add('copied');
    setTimeout(() => {
      b.textContent = label;
      b.classList.remove('copied');
    }, 1600);
  });
}

/**
 * Link, ID and public record for one item (a poll, petition, mandate, council change or
 * agenda item): "🔗 Copy link" opens the app at that item.
 */
export function itemTools({ anchor, idText, ref, explorer, address }) {
  const url = `${appBase()}#${anchor}`;
  return `<p class="row item-tools">${copyBtn(url, '🔗 Copy link')} ${copyBtn(idText, 'Copy ID')}${ref ? ` ${copyBtn(ref, 'Copy text reference')}` : ''}${explorer && address ? ` <a href="${escAttr(`${explorer.replace(/\/+$/, '')}/address/${address}`)}" target="_blank" rel="noopener">View on the blockchain</a>` : ''}</p>`;
}

/** Scroll to an element and flash it so it is easy to spot. */
export function jumpTo(el) {
  if (!el) return false;
  for (let d = el.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  return true;
}
