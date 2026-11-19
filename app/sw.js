/**
 * app/sw.js - lets Promissa open with no signal.
 *
 * Every page and file of this site is fetched fresh when there is a connection (so updates show
 * at once) and a copy is kept; with no connection the kept copy is used. The proving files that
 * seal a ballot are large and never change, so once kept they are used straight away.
 * Nothing private is kept here: only the site's own public files.
 */
const CACHE = 'promissa-1';
const PROVING = /^https:\/\/snark-artifacts\.pse\.dev\//;
const SHELL = ['./', './index.html', './style.css', './manifest.webmanifest', './icons/icon-192.png', './icons/lockup.svg', './icons/favicon.svg'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The site is static: the same file whatever its ?org= or ?v=, so keep one copy per file.
const keyFor = (url) => {
  const u = new URL(url);
  return u.origin === self.location.origin ? `${u.origin}${u.pathname}` : url;
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const own = url.origin === self.location.origin;
  const proving = PROVING.test(req.url) || (own && url.pathname.includes('/artifacts/'));
  if (!own && !proving) return; // the blockchain, sign-in and other services always go to the network

  if (proving) {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const kept = await c.match(keyFor(req.url));
        if (kept) return kept;
        const res = await fetch(req);
        if (res.ok) await c.put(keyFor(req.url), res.clone());
        return res;
      }),
    );
    return;
  }

  e.respondWith(
    fetch(req)
      .then(async (res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(keyFor(req.url), copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const kept = await caches.match(keyFor(req.url));
        if (kept) return kept;
        if (req.mode === 'navigate') return (await caches.match(keyFor(new URL('./index.html', self.location).href))) || Response.error();
        return Response.error();
      }),
  );
});
