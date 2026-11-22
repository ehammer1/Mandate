/**
 * app/src/clouds.js - store your files in your own Dropbox, OneDrive or Google Drive.
 *
 * Each person signs in with their own account; files go to a Promissa folder in it (Dropbox:
 * an app folder; OneDrive: the app folder; Google Drive: only files Promissa created, nothing
 * else in the Drive) and are shared by link so others can open them. Promissa records each
 * file's SHA-256 fingerprint and its link. Tokens stay in this browser and go only to that
 * company. The app IDs in the community's config identify Promissa to each company; they are
 * public and give no access to anyone's files.
 *
 * Google Drive blocks other websites from downloading files directly, so "Check it is
 * unchanged" may not be able to check Drive copies; the app says so.
 */

const KEY = 'mandate.ownStorage';
const here = () => `${location.origin}${location.pathname}`;
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const challengeOf = async (v) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const ext = (name, type) => (String(name).match(/\.[a-z0-9]{1,5}$/i)?.[0] || { 'image/jpeg': '.jpg', 'application/pdf': '.pdf', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/webm': '.webm' }[type] || '').toLowerCase();

const save = (v) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* private mode */
  }
};
const load = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || null;
  } catch {
    return null;
  }
};

export const CLOUDS = {
  dropbox: { label: 'Dropbox', configKey: 'dropboxAppKey' },
  onedrive: { label: 'OneDrive', configKey: 'microsoftClientId' },
  gdrive: { label: 'Google Drive', configKey: 'googleClientId' },
};
/** Which of them this community has set up (app IDs in its config). */
export const availableClouds = (cfg) => Object.entries(CLOUDS).filter(([, c]) => cfg?.[c.configKey]).map(([k, c]) => [k, c.label]);

// ------------------------------------------------------------------- sign in

/** Go to the company's sign-in page; it comes back here with a code (or a token for Google). */
export async function connectCloud(kind, cfg) {
  const id = cfg[CLOUDS[kind].configKey];
  if (!id) throw new Error(`${CLOUDS[kind].label} is not set up for this community yet.`);
  const state = randomString();
  const verifier = randomString();
  sessionStorage.setItem('mandate.cloudPending', JSON.stringify({ kind, state, verifier, back: location.search }));
  const q = (o) => new URLSearchParams(o).toString();
  if (kind === 'dropbox') {
    location.href = `https://www.dropbox.com/oauth2/authorize?${q({ client_id: id, response_type: 'code', redirect_uri: here(), state, code_challenge: await challengeOf(verifier), code_challenge_method: 'S256', token_access_type: 'offline' })}`;
  } else if (kind === 'onedrive') {
    location.href = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${q({ client_id: id, response_type: 'code', redirect_uri: here(), state, scope: 'Files.ReadWrite.AppFolder offline_access', code_challenge: await challengeOf(verifier), code_challenge_method: 'S256' })}`;
  } else {
    // Google: a short-lived token, only for files Promissa creates (drive.file).
    location.href = `https://accounts.google.com/o/oauth2/v2/auth?${q({ client_id: id, response_type: 'token', redirect_uri: here(), state, scope: 'https://www.googleapis.com/auth/drive.file', include_granted_scopes: 'true' })}`;
  }
}

/** On page load: finish a sign-in that came back here. Returns the provider's label, or null. */
export async function finishCloud(cfg, doFetch = fetch) {
  let pending;
  try {
    pending = JSON.parse(sessionStorage.getItem('mandate.cloudPending'));
  } catch {
    pending = null;
  }
  if (!pending) return null;
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.slice(1));
  const state = q.get('state') || h.get('state');
  if (state !== pending.state) return null;
  sessionStorage.removeItem('mandate.cloudPending');
  const id = cfg[CLOUDS[pending.kind].configKey];
  const now = Date.now();
  try {
    if (pending.kind === 'gdrive') {
      if (h.get('access_token')) save({ kind: 'gdrive', access: h.get('access_token'), expires: now + Number(h.get('expires_in') || 3600) * 1000 });
    } else if (q.get('code')) {
      const url = pending.kind === 'dropbox' ? 'https://api.dropboxapi.com/oauth2/token' : 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
      const body = new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code'), client_id: id, redirect_uri: here(), code_verifier: pending.verifier, ...(pending.kind === 'onedrive' ? { scope: 'Files.ReadWrite.AppFolder offline_access' } : {}) });
      const res = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const t = await res.json().catch(() => ({}));
      if (res.ok && t.access_token) save({ kind: pending.kind, access: t.access_token, refresh: t.refresh_token, expires: now + Number(t.expires_in || 3600) * 1000 });
    }
  } finally {
    history.replaceState(null, '', `${location.pathname}${pending.back || ''}`); // remove the code from the address bar
  }
  return load()?.kind === pending.kind ? CLOUDS[pending.kind].label : null;
}

/** A current access token: refreshed for Dropbox and OneDrive; Google asks to sign in again after an hour. */
async function token(cfg, doFetch) {
  const s = load();
  if (!s || !CLOUDS[s.kind]) throw new Error('Your storage account is not connected.');
  if (Date.now() < s.expires - 60_000) return s;
  if (s.kind === 'gdrive' || !s.refresh) throw Object.assign(new Error(`Your ${CLOUDS[s.kind].label} sign-in has expired: connect it again (Account screen).`), { reconnect: true });
  const url = s.kind === 'dropbox' ? 'https://api.dropboxapi.com/oauth2/token' : 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
  const res = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refresh, client_id: cfg[CLOUDS[s.kind].configKey], ...(s.kind === 'onedrive' ? { scope: 'Files.ReadWrite.AppFolder offline_access' } : {}) }) });
  const t = await res.json().catch(() => ({}));
  if (!res.ok || !t.access_token) throw Object.assign(new Error(`Your ${CLOUDS[s.kind].label} sign-in has expired: connect it again (Account screen).`), { reconnect: true });
  Object.assign(s, { access: t.access_token, refresh: t.refresh_token || s.refresh, expires: Date.now() + Number(t.expires_in || 3600) * 1000 });
  save(s);
  return s;
}

// --------------------------------------------------------------------- upload

/** Store a file in the connected cloud; returns { sha256, locations } like any other storage. */
export async function putCloud(bytes, name, type, cfg, doFetch = fetch) {
  const s = await token(cfg, doFetch);
  const sha = hex(await crypto.subtle.digest('SHA-256', bytes));
  const file = `${sha}${ext(name, type)}`;
  const auth = { Authorization: `Bearer ${s.access}` };
  const ok = async (res, what) => {
    if (!res.ok) throw new Error(`${CLOUDS[s.kind].label} refused ${what} (${res.status}).`);
    return res.json().catch(() => ({}));
  };
  if (s.kind === 'dropbox') {
    await ok(await doFetch('https://content.dropboxapi.com/2/files/upload', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path: `/${file}`, mode: 'overwrite', mute: true }) }, body: bytes }), 'the file');
    let res = await doFetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: `/${file}`, settings: { requested_visibility: 'public' } }) });
    let link = (await res.json().catch(() => ({}))).url;
    if (!link) {
      res = await doFetch('https://api.dropboxapi.com/2/sharing/list_shared_links', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: `/${file}`, direct_only: true }) });
      link = (await ok(res, 'sharing the file')).links?.[0]?.url;
    }
    if (!link) throw new Error('Dropbox did not share the file.');
    const raw = new URL(link);
    raw.searchParams.delete('dl');
    raw.searchParams.set('raw', '1'); // the file itself, not Dropbox's page
    return { sha256: sha, locations: [{ kind: 'dropbox', url: raw.toString(), page: link }] };
  }
  if (s.kind === 'onedrive') {
    const base = 'https://graph.microsoft.com/v1.0/me/drive/special/approot';
    let item;
    if (bytes.length <= 4 * 1024 * 1024) {
      item = await ok(await doFetch(`${base}:/${file}:/content`, { method: 'PUT', headers: { ...auth, 'Content-Type': type }, body: bytes }), 'the file');
    } else {
      // Larger files: an upload session, in pieces of 10 x 320 KiB.
      const sess = await ok(await doFetch(`${base}:/${file}:/createUploadSession`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }) }), 'the upload');
      const piece = 10 * 320 * 1024;
      for (let at = 0; at < bytes.length; at += piece) {
        const end = Math.min(at + piece, bytes.length);
        const res = await doFetch(sess.uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes ${at}-${end - 1}/${bytes.length}` }, body: bytes.slice(at, end) });
        if (!res.ok) throw new Error(`OneDrive refused part of the file (${res.status}).`);
        if (end === bytes.length) item = await res.json().catch(() => ({}));
      }
    }
    const share = await ok(await doFetch(`https://graph.microsoft.com/v1.0/me/drive/items/${item.id}/createLink`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'view', scope: 'anonymous' }) }), 'sharing the file');
    const web = share.link?.webUrl;
    if (!web) throw new Error('OneDrive did not share the file.');
    const encoded = `u!${btoa(web).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
    return { sha256: sha, locations: [{ kind: 'onedrive', url: `https://api.onedrive.com/v1.0/shares/${encoded}/root/content`, page: web }] };
  }
  // Google Drive: a resumable upload, then "anyone with the link can view".
  const start = await doFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type }, body: JSON.stringify({ name: file, mimeType: type }) });
  if (!start.ok) throw new Error(`Google Drive refused the upload (${start.status}).`);
  const session = start.headers.get('location');
  const created = await ok(await doFetch(session, { method: 'PUT', headers: { 'Content-Type': type }, body: bytes }), 'the file');
  await ok(await doFetch(`https://www.googleapis.com/drive/v3/files/${created.id}/permissions`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'reader', type: 'anyone' }) }), 'sharing the file');
  return { sha256: sha, locations: [{ kind: 'gdrive', id: created.id, url: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(created.id)}`, page: `https://drive.google.com/file/d/${encodeURIComponent(created.id)}/view` }] };
}
