/**
 * services/lib/communities.js - one running service, many communities.
 *
 * Every community (a city, a school board, a union local) has its own contracts and its own
 * config file next to the app: communities/<slug>.json, listed in communities/index.json. A
 * shared service (vote relay, sign-up) serves each one under its own path, /c/<slug>/..., with a
 * handler built from that community's config, so their data never mixes. Requests without a
 * /c/<slug> prefix go to the original (default) community.
 */
'use strict';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Where the community list lives, next to the app's config.json. */
function indexUrlFrom(configUrl, explicit) {
  if (explicit) return explicit;
  if (!configUrl) return '';
  const u = new URL(configUrl);
  u.pathname = u.pathname.replace(/[^/]*$/, 'communities/index.json');
  u.search = '';
  return u.toString();
}

/** Fetch the list and each community's config: [{ slug, name, config }]. Bad entries are skipped. */
async function loadCommunities(indexUrl, fetchJson = defaultFetchJson) {
  if (!indexUrl) return [];
  const index = await fetchJson(indexUrl);
  const out = [];
  for (const c of Array.isArray(index?.communities) ? index.communities : []) {
    if (!SLUG.test(String(c.slug || ''))) continue;
    try {
      const config = await fetchJson(new URL(`${c.slug}.json`, indexUrl).toString());
      if (config && config.voteAddress && config.identityAddress) out.push({ slug: c.slug, name: c.name || c.slug, config });
    } catch {
      /* one broken community must not take the others down */
    }
  }
  return out;
}

async function defaultFetchJson(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

/**
 * A request listener that sends /c/<slug>/... to that community's handler (with the prefix
 * removed) and everything else to the default handler. `set(slug, handler)` adds or replaces one.
 */
function createRouter(defaultHandler) {
  const handlers = new Map();
  let fallback = defaultHandler;
  const listener = (req, res) => {
    const m = /^\/c\/([^/?#]+)(.*)$/.exec(req.url || '');
    if (!m) return fallback(req, res);
    const handler = SLUG.test(m[1]) ? handlers.get(m[1]) : null;
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: 'UnknownCommunity', message: 'No community with that name is served here.' }));
    }
    req.url = m[2] && m[2].startsWith('/') ? m[2] : `/${m[2] || ''}`.replace(/^\/\?/, '/?');
    return handler(req, res);
  };
  listener.set = (slug, handler) => handlers.set(slug, handler);
  listener.remove = (slug) => handlers.delete(slug);
  listener.slugs = () => [...handlers.keys()];
  listener.setDefault = (h) => (fallback = h);
  return listener;
}

/** Keep the router in step with the published list: build handlers for new or changed communities. */
async function syncCommunities(router, indexUrl, build, { fetchJson, log = () => {} } = {}) {
  const list = await loadCommunities(indexUrl, fetchJson);
  const seen = new Set();
  for (const c of list) {
    seen.add(c.slug);
    const sig = JSON.stringify(c.config);
    if (router._sigs?.get(c.slug) === sig) continue;
    try {
      router.set(c.slug, await build(c.config, c.slug));
      (router._sigs ||= new Map()).set(c.slug, sig);
      log(`serving community "${c.name}" at /c/${c.slug}`);
    } catch (e) {
      log(`could not start community ${c.slug}: ${e.message}`);
    }
  }
  for (const s of router.slugs()) if (!seen.has(s)) (router.remove(s), router._sigs?.delete(s), log(`stopped serving /c/${s}`));
  return list;
}

module.exports = { SLUG, indexUrlFrom, loadCommunities, createRouter, syncCommunities };
