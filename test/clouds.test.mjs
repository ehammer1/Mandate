// Your own Dropbox, OneDrive or Google Drive: each person signs in with their own account; files
// go to a Promissa folder and are shared by link; the record holds the fingerprint and link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const store = new Map();
const sess = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.sessionStorage = { getItem: (k) => sess.get(k) ?? null, setItem: (k, v) => sess.set(k, String(v)), removeItem: (k) => sess.delete(k) };
globalThis.location = { origin: 'https://ehammer1.github.io', pathname: '/Mandate/', search: '?org=demo', hash: '', href: '' };
globalThis.history = { replaceState: (_s, _t, url) => (globalThis.location.search = url.includes('?') ? url.slice(url.indexOf('?')) : '') };
const { availableClouds, connectCloud, finishCloud, putCloud } = await import('../app/src/clouds.js');

const cfg = { dropboxAppKey: 'dbx-app', microsoftClientId: 'ms-app', googleClientId: 'g-app' };
const bytes = new TextEncoder().encode('%PDF-1.7 a poster');
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const ok = (body, headers = {}) => ({ ok: true, status: 200, json: async () => body, headers: { get: (h) => headers[h.toLowerCase()] ?? null } });

test('offered only where the community registered Promissa; sign-in uses PKCE and comes back with a code', async () => {
  assert.deepEqual(availableClouds({ dropboxAppKey: 'x' }).map(([k]) => k), ['dropbox']);
  await connectCloud('dropbox', cfg);
  const u = new URL(location.href);
  assert.equal(u.origin + u.pathname, 'https://www.dropbox.com/oauth2/authorize');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://ehammer1.github.io/Mandate/');
  // Back from Dropbox with a code: exchanged for this person's own tokens (no app secret involved).
  location.search = `?code=abc&state=${u.searchParams.get('state')}`;
  let body;
  const label = await finishCloud(cfg, async (url, init) => ((body = Object.fromEntries(new URLSearchParams(init.body))), ok({ access_token: 'A', refresh_token: 'R', expires_in: 14400 })));
  assert.equal(label, 'Dropbox');
  assert.equal(body.client_id, 'dbx-app');
  assert.ok(body.code_verifier && !body.client_secret);
  assert.equal(location.search, '?org=demo'); // the code is removed from the address bar
});

test('Dropbox: uploaded into the app folder and shared; the record links the file itself', async () => {
  const calls = [];
  const out = await putCloud(bytes, 'poster.pdf', 'application/pdf', cfg, async (url, init) => {
    calls.push(url);
    if (url.endsWith('/files/upload')) {
      assert.equal(JSON.parse(init.headers['Dropbox-API-Arg']).path, `/${sha}.pdf`);
      return ok({});
    }
    return ok({ url: 'https://www.dropbox.com/scl/fi/xyz/file.pdf?rlkey=k&dl=0' });
  });
  assert.equal(out.sha256, sha);
  assert.equal(out.locations[0].kind, 'dropbox');
  assert.match(out.locations[0].url, /rlkey=k&raw=1$/);
});

test('OneDrive: large files in pieces, then an anyone-with-the-link share', async () => {
  store.set('mandate.ownStorage', JSON.stringify({ kind: 'onedrive', access: 'A', refresh: 'R', expires: Date.now() + 3_600_000 }));
  const big = new Uint8Array(5 * 1024 * 1024 + 7);
  const ranges = [];
  const out = await putCloud(big, 'ad.mp3', 'audio/mpeg', cfg, async (url, init) => {
    if (url.endsWith(':/createUploadSession')) return ok({ uploadUrl: 'https://upload.example/s' });
    if (url === 'https://upload.example/s') {
      ranges.push(init.headers['Content-Range']);
      return ok({ id: 'ITEM1' });
    }
    if (url.endsWith('/createLink')) return ok({ link: { webUrl: 'https://1drv.ms/u/s!abc' } });
    throw new Error(url);
  });
  assert.equal(ranges.length, 2);
  assert.match(ranges.at(-1), new RegExp(`/${big.length}$`));
  assert.match(out.locations[0].url, /^https:\/\/api\.onedrive\.com\/v1\.0\/shares\/u!.+\/root\/content$/);
});

test('Google Drive: only files Promissa creates; shared by link; an expired sign-in asks to connect again', async () => {
  store.set('mandate.ownStorage', JSON.stringify({ kind: 'gdrive', access: 'G', expires: Date.now() + 3_600_000 }));
  const out = await putCloud(bytes, 'poster.pdf', 'application/pdf', cfg, async (url, init) => {
    if (url.includes('uploadType=resumable')) return ok({}, { location: 'https://upload.example/g' });
    if (url === 'https://upload.example/g') return ok({ id: 'FILE1' });
    if (url.endsWith('/permissions')) {
      assert.deepEqual(JSON.parse(init.body), { role: 'reader', type: 'anyone' });
      return ok({});
    }
    throw new Error(url);
  });
  assert.deepEqual(out.locations[0], { kind: 'gdrive', id: 'FILE1', url: 'https://drive.google.com/uc?export=download&id=FILE1', page: 'https://drive.google.com/file/d/FILE1/view' });
  store.set('mandate.ownStorage', JSON.stringify({ kind: 'gdrive', access: 'G', expires: Date.now() - 1 }));
  await assert.rejects(putCloud(bytes, 'p.pdf', 'application/pdf', cfg, async () => ok({})), /connect it again/);
});
