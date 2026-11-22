/**
 * app/src/social.js - post to your own Bluesky or Mastodon account from inside Promissa.
 *
 *  - Bluesky: your handle and an app password (Bluesky Settings → App passwords; revocable,
 *    never your real password). Promissa signs in to Bluesky from this browser and keeps only
 *    the session Bluesky returns.
 *  - Mastodon: the usual sign-in on your own server (OAuth), asking only to post.
 *
 * Tokens stay in this browser and go only to Bluesky or your Mastodon server; Promissa's
 * servers never see them. Nothing is posted without you pressing Post. Off on shared
 * computers. Other platforms use the share links (no account connection needed).
 */

const KEY = 'mandate.social';
const load = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
};
const save = (v) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* private mode: connected for this visit only */
  }
};
export const connections = () => load();

// --------------------------------------------------------------------- Bluesky

const BSKY = 'https://bsky.social/xrpc';

export async function connectBluesky(handle, appPassword) {
  const id = String(handle || '').trim().replace(/^@/, '');
  if (!id || !appPassword) throw new Error('Enter your Bluesky handle and an app password.');
  if (!/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i.test(appPassword.trim())) throw new Error('Use an app password (Bluesky Settings → Privacy and security → App passwords), not your account password. It looks like abcd-efgh-ijkl-mnop.');
  const res = await fetch(`${BSKY}/com.atproto.server.createSession`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: id, password: appPassword.trim() }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.message || 'Bluesky did not accept that handle and app password.');
  const all = load();
  all.bluesky = { handle: out.handle, did: out.did, access: out.accessJwt, refresh: out.refreshJwt };
  save(all);
  return all.bluesky;
}

async function bskyFetch(path, body) {
  const all = load();
  const b = all.bluesky;
  if (!b) throw new Error('Connect your Bluesky account first (Account screen).');
  const call = (token) => fetch(`${BSKY}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  let res = await call(b.access);
  if (res.status === 400 || res.status === 401) {
    // The short-lived session ended: renew it with the refresh token.
    const r = await fetch(`${BSKY}/com.atproto.server.refreshSession`, { method: 'POST', headers: { Authorization: `Bearer ${b.refresh}` } });
    const s = await r.json().catch(() => ({}));
    if (!r.ok) {
      delete all.bluesky;
      save(all);
      throw new Error('Your Bluesky connection expired. Connect it again (Account screen).');
    }
    Object.assign(b, { access: s.accessJwt, refresh: s.refreshJwt });
    save(all);
    res = await call(b.access);
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.message || `Bluesky answered ${res.status}.`);
  return out;
}

/** Byte offsets of the link in the text, as Bluesky needs for a clickable link. */
function linkFacet(text, url) {
  const enc = new TextEncoder();
  const at = text.indexOf(url);
  if (at < 0) return [];
  const start = enc.encode(text.slice(0, at)).length;
  return [{ index: { byteStart: start, byteEnd: start + enc.encode(url).length }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }] }];
}

/** Post to Bluesky (300 characters at most), with a link card. Returns the post's web address. */
export async function postBluesky({ text, url, title, description }) {
  const b = load().bluesky;
  if ([...text].length > 300) throw new Error('Bluesky posts can be up to 300 characters.');
  const record = {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: new Date().toISOString(),
    facets: linkFacet(text, url),
    ...(url ? { embed: { $type: 'app.bsky.embed.external', external: { uri: url, title: String(title || '').slice(0, 300), description: String(description || '').slice(0, 1000) } } } : {}),
  };
  const out = await bskyFetch('com.atproto.repo.createRecord', { repo: b.did, collection: 'app.bsky.feed.post', record });
  return `https://bsky.app/profile/${b.handle}/post/${String(out.uri).split('/').pop()}`;
}

// -------------------------------------------------------------------- Mastodon

const here = () => `${location.origin}${location.pathname}`;

/** Start the sign-in on your Mastodon server; comes back to this page with a code. */
export async function connectMastodon(server) {
  const host = String(server || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new Error('Enter your Mastodon server, for example mastodon.social');
  const all = load();
  all.apps ||= {};
  if (!all.apps[host] || all.apps[host].redirect !== here()) {
    const res = await fetch(`https://${host}/api/v1/apps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Promissa', redirect_uris: here(), scopes: 'write:statuses', website: here() }) });
    const app = await res.json().catch(() => ({}));
    if (!res.ok || !app.client_id) throw new Error(`Could not reach ${host}. Check the server name.`);
    all.apps[host] = { id: app.client_id, secret: app.client_secret, redirect: here() };
  }
  const state = crypto.getRandomValues(new Uint32Array(4)).join('-');
  all.pending = { host, state, back: location.search };
  save(all);
  location.href = `https://${host}/oauth/authorize?${new URLSearchParams({ client_id: all.apps[host].id, redirect_uri: here(), response_type: 'code', scope: 'write:statuses', state })}`;
}

/** On page load: finish a Mastodon sign-in if we came back from one. Returns true if handled. */
export async function finishMastodon() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  const all = load();
  if (!code || !all.pending || q.get('state') !== all.pending.state) return false;
  const { host, back } = all.pending;
  delete all.pending;
  const app = all.apps?.[host];
  try {
    const res = await fetch(`https://${host}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: app.id, client_secret: app.secret, redirect_uri: app.redirect, scope: 'write:statuses' }) });
    const t = await res.json().catch(() => ({}));
    if (res.ok && t.access_token) all.mastodon = { host, token: t.access_token };
  } finally {
    save(all);
    history.replaceState(null, '', `${location.pathname}${back || ''}`); // remove the code from the address bar
  }
  return true;
}

/** Post to Mastodon (500 characters on most servers). Returns the post's web address. */
export async function postMastodon({ text }) {
  const m = load().mastodon;
  if (!m) throw new Error('Connect your Mastodon account first (Account screen).');
  const res = await fetch(`https://${m.host}/api/v1/statuses`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${m.token}` }, body: JSON.stringify({ status: text, visibility: 'public' }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Mastodon answered ${res.status}.`);
  return out.url;
}

export function disconnect(which) {
  const all = load();
  delete all[which];
  save(all);
}
