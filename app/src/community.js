/**
 * app/src/community.js - which community this page is for.
 *
 * The same app serves many communities (a city, a school board, a union local), each with its own
 * contracts: ?org=<slug> in the address picks communities/<slug>.json instead of config.json, and
 * every link the app makes keeps ?org=, so shared links open the right community. A community
 * can also have its own web address (vote.lincolnhigh.org): communities/index.json lists each
 * community's `domain`, and a visit on that address opens that community with no ?org= at all.
 */
export const ORG = (() => {
  try {
    const v = new URLSearchParams(location.search).get('org') || '';
    return /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(v) ? v : '';
  } catch {
    return '';
  }
})();

export const configPath = () => (ORG ? `communities/${ORG}.json` : 'config.json');

// The shared addresses (and local testing), where a community is picked only by ?org=.
const SHARED_HOST = /(^|\.)github\.io$|^localhost$|^127\.0\.0\.1$|^\[::1\]$/;
const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');

/** On a community's own web address: which community it is (or '' if none matches). */
async function communityForDomain(host) {
  if (SHARED_HOST.test(host)) return '';
  try {
    const res = await fetch(`communities/index.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return '';
    const hit = ((await res.json()).communities || []).find((c) => c.domain && bare(c.domain) === bare(host));
    return hit && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(hit.slug) ? hit.slug : '';
  } catch {
    return '';
  }
}

/** This page's settings (bypassing caches, so a change shows at once). */
export async function loadConfig() {
  const own = ORG ? '' : await communityForDomain(location.hostname);
  if (own) {
    const r = await fetch(`communities/${own}.json?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) return r.json();
  }
  const res = await fetch(`${configPath()}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(ORG ? `No community called "${ORG}" here. Check the link.` : 'This app is not configured yet (config.json missing).');
  return res.json();
}

/** A same-site link with this community kept on it (absolute). */
export function withOrg(href) {
  const u = new URL(href, location.href);
  if (ORG && u.origin === location.origin && !u.searchParams.has('org')) u.searchParams.set('org', ORG);
  return u.href;
}

/** The app's address for this community, to put #item anchors after. */
export const appBase = () => withOrg(new URL('./', location.href).href);

/** Links in the page (footer, menus, help) keep ?org= when tapped. */
export function keepOrgInLinks(root = document) {
  if (!ORG) return;
  root.addEventListener(
    'click',
    (e) => {
      const a = e.target.closest?.('a[href]');
      if (!a) return;
      const raw = a.getAttribute('href');
      if (!raw || raw.startsWith('#') || /^(mailto|tel|javascript):/i.test(raw)) return;
      const u = new URL(raw, location.href);
      if (u.origin === location.origin && !u.searchParams.has('org')) a.href = withOrg(raw);
    },
    true,
  );
}

/** Per-community storage key, so two communities on one device don't mix their notes. */
export const orgKey = (k) => (ORG ? `${k}@${ORG}` : k);
