/**
 * app/src/copy.js - one-tap copying of addresses, codes and links, and a small "jump to"
 * helper that scrolls to an item and highlights it.
 */
import { appBase } from './community.js';
import { onBaseButton } from './onbase.js';

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
export function itemTools({ title, anchor, idText, ref, explorer, address }) {
  const url = `${appBase()}#${anchor}`;
  return `<p class="row item-tools">${title ? `${shareMenu(title, url)} ` : ''}${copyBtn(url, '🔗 Copy link')} ${copyBtn(idText, 'Copy ID')}${ref ? ` ${copyBtn(ref, 'Copy text reference')} ${onBaseButton(ref)}` : ''}${explorer && address ? ` <a href="${escAttr(`${explorer.replace(/\/+$/, '')}/address/${address}`)}" target="_blank" rel="noopener">View on the blockchain</a>` : ''}</p>`;
}

/**
 * "📣 Share": the phone's own share sheet, or a post ready to send on each platform from the
 * person's own account (no Promissa account or API key involved; nothing is posted for them).
 */
export function shareText(title) {
  return `${title}: have your say on Promissa (secret ballot, open source, anyone can check the count)`;
}
export function shareLinks(title, url) {
  const t = encodeURIComponent(shareText(title));
  const u = encodeURIComponent(url);
  const tu = encodeURIComponent(`${shareText(title)} ${url}`);
  return [
    ['X', `https://twitter.com/intent/tweet?text=${t}&url=${u}`],
    ['Bluesky', `https://bsky.app/intent/compose?text=${tu}`],
    ['Threads', `https://www.threads.net/intent/post?text=${tu}`],
    ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${u}`],
    ['LinkedIn', `https://www.linkedin.com/sharing/share-offsite/?url=${u}`],
    ['Reddit', `https://www.reddit.com/submit?url=${u}&title=${encodeURIComponent(title)}`],
    ['WhatsApp', `https://wa.me/?text=${tu}`],
    ['Telegram', `https://t.me/share/url?url=${u}&text=${t}`],
    ['Email', `mailto:?subject=${encodeURIComponent(title)}&body=${tu}`],
  ];
}
function shareMenu(title, url) {
  return `<details class="share"><summary>📣 Share</summary><div class="row" style="flex-wrap:wrap">
    <button type="button" data-share-native data-title="${escAttr(title)}" data-url="${escAttr(url)}" hidden>Share…</button>
    ${shareLinks(title, url).map(([n, href]) => `<a href="${escAttr(href)}" target="_blank" rel="noopener">${n}</a>`).join(' ')}
    <button type="button" data-share-mastodon data-title="${escAttr(title)}" data-url="${escAttr(url)}">Mastodon</button>
  </div><div class="row" data-direct hidden><button type="button" data-post-direct="bluesky" data-title="${escAttr(title)}" data-url="${escAttr(url)}" hidden>Post to Bluesky now</button> <button type="button" data-post-direct="mastodon" data-title="${escAttr(title)}" data-url="${escAttr(url)}" hidden>Post to Mastodon now</button></div><p class="status" role="status" data-direct-status></p></details>`;
}

/** The phone's share sheet where there is one; Mastodon asks for your server once. */
export function wireShare(root = document) {
  root.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.classList?.contains('share') && d.open) for (const b of d.querySelectorAll('[data-share-native]')) b.hidden = !navigator.share;
  }, true);
  root.addEventListener('click', async (e) => {
    const n = e.target.closest('[data-share-native]');
    if (n) {
      e.preventDefault();
      navigator.share?.({ title: n.dataset.title, text: shareText(n.dataset.title), url: n.dataset.url }).catch(() => {});
      return;
    }
    const m = e.target.closest('[data-share-mastodon]');
    if (!m) return;
    e.preventDefault();
    let server = '';
    try {
      server = localStorage.getItem('mandate.mastodon') || '';
    } catch {
      /* ignore */
    }
    server = (window.prompt('Your Mastodon server (for example mastodon.social)', server) || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(server)) return;
    try {
      localStorage.setItem('mandate.mastodon', server);
    } catch {
      /* ignore */
    }
    window.open(`https://${server}/share?text=${encodeURIComponent(`${shareText(m.dataset.title)} ${m.dataset.url}`)}`, '_blank', 'noopener');
  });
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
