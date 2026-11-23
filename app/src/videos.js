/**
 * app/src/videos.js - campaign and proposal videos: links to videos people post wherever they
 * like (YouTube, TikTok, Instagram, X, Facebook, Vimeo…), attached to a candidate statement,
 * petition, agenda issue, poll or promise. The document holding the links is published from
 * the poster's own account or anonymously like the item itself, so the record shows who
 * attached what.
 *
 * Authenticity: a video may carry a seal from Testimonia (a fingerprint of the original file,
 * when and how it was recorded). Until Testimonia launches the seal is shown as "pending
 * verification". It will prove the recording is real and unedited, not that what it says is
 * true. Platforms re-compress uploads, so the seal is checked against the original file.
 *
 * Privacy: nothing from a video platform loads until the person taps Play (YouTube plays from
 * its no-cookie domain); other platforms open in a new tab.
 */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MAX = 3;
const HOSTS = [
  [/(^|\.)youtube\.com$|^youtu\.be$/, 'YouTube'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)(x|twitter)\.com$/, 'X'],
  [/(^|\.)facebook\.com$|^fb\.watch$/, 'Facebook'],
  [/(^|\.)vimeo\.com$/, 'Vimeo'],
  [/(^|\.)rumble\.com$/, 'Rumble'],
  [/(^|\.)bsky\.app$/, 'Bluesky'],
];

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\.|^m\./, '');
  } catch {
    return '';
  }
};
export const platformOf = (url) => HOSTS.find(([re]) => re.test(hostOf(url)))?.[1] || hostOf(url) || 'link';

/** The YouTube video id of a link, or null. */
export function youtubeId(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\.|^m\./, '');
    let id = null;
    if (h === 'youtu.be') id = u.pathname.slice(1);
    else if (h === 'youtube.com') id = u.searchParams.get('v') || (u.pathname.match(/^\/(shorts|embed|live)\/([^/]+)/) || [])[2];
    return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Form fields for up to three videos; `p` prefixes the data attributes. */
export function videoFields(p) {
  return `<details><summary>🎬 Add videos (optional)</summary><div class="stack">
    <p class="note">Post your video wherever you like (YouTube, TikTok, Instagram…) and paste the link here. Recorded with Testimonia? Add its seal and the original file, so people can check it is real and unedited.</p>
    ${[0, 1, 2].map((i) => `<div class="stack"${i ? ' data-more hidden' : ''}><label>Video link (https://…) <input type="url" data-${p}-vid-url="${i}" /></label>
      <label>Title <input type="text" data-${p}-vid-title="${i}" maxlength="120" /></label>
      <details><summary>Testimonia seal (optional)</summary><label>Seal code <input type="text" data-${p}-vid-seal="${i}" spellcheck="false" /></label><label>Original file link <input type="url" data-${p}-vid-orig="${i}" /></label></details></div>`).join('')}
    <button type="button" data-${p}-vid-more>Add another video</button>
  </div></details>`;
}

/** Show the next video slot when asked. */
export function wireVideoFields(root, p) {
  root.querySelector(`[data-${p}-vid-more]`)?.addEventListener('click', (e) => {
    const box = e.target.closest('details');
    const next = box.querySelector('[data-more][hidden]');
    if (next) next.hidden = false;
    if (!box.querySelector('[data-more][hidden]')) e.target.hidden = true;
  });
}

/** The videos part of a published document, or undefined; throws a plain message if invalid. */
export function readVideos(root, p) {
  const out = [];
  for (let i = 0; i < MAX; i++) {
    const v = (k) => root.querySelector(`[data-${p}-vid-${k}="${i}"]`)?.value.trim() || '';
    const url = v('url');
    if (!url) continue;
    if (!/^https:\/\/[^\s]+$/.test(url)) throw new Error('Video links must start with https://');
    const orig = v('orig');
    if (orig && !/^(https:\/\/|ipfs:\/\/)[^\s]+$/.test(orig)) throw new Error('The original file link must start with https:// or ipfs://');
    const seal = v('seal');
    out.push({ url, title: v('title').slice(0, 120), ...(seal ? { seal: { by: 'testimonia', code: seal.slice(0, 4000), ...(orig ? { original: orig } : {}) } } : {}) });
  }
  return out.length ? out : undefined;
}

/** Video cards for a document's videos. */
export function videosHtml(videos) {
  const list = (Array.isArray(videos) ? videos : []).filter((v) => v && /^https:\/\/[^\s]+$/.test(v.url)).slice(0, MAX);
  if (!list.length) return '';
  return `<div class="stack videos">${list
    .map((v) => {
      const yt = youtubeId(v.url);
      const badge = v.seal ? '<span class="chip">Testimonia seal: verification opens when Testimonia launches</span>' : '<span class="chip muted">Not sealed: authenticity not checked</span>';
      return `<div class="card stack video"><p><strong>🎬 ${esc(v.title || 'Video')}</strong> · ${esc(platformOf(v.url))}</p>
        ${yt ? `<div data-yt="${esc(yt)}"><button type="button" data-play>▶ Play here</button></div>` : ''}
        <p><a href="${esc(v.url)}" target="_blank" rel="noopener">Watch on ${esc(platformOf(v.url))}</a>${v.seal?.original && /^(https|ipfs):\/\//.test(v.seal.original) ? ` · <a href="${esc(v.seal.original.replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/'))}" target="_blank" rel="noopener">The sealed original</a>` : ''}</p>
        <p>${badge}</p></div>`;
    })
    .join('')}<p class="note">Each video's link and seal are recorded on Base with this item (📜 On Base). A seal shows a recording is real and unedited, not that what it says is true.</p></div>`;
}

/** Tap to play: YouTube loads only now, from its no-cookie domain. */
export function wireVideos(root = document) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-play]');
    if (!b) return;
    const box = b.closest('[data-yt]');
    const id = box?.dataset.yt;
    if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return;
    box.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1" title="Video" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen style="width:100%;aspect-ratio:16/9;border:0"></iframe>`;
  });
}
