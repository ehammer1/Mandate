/**
 * app/src/community.js - which community this page is for.
 *
 * The same app serves many communities (a city, a school board, a union local), each with its own
 * contracts: ?org=<slug> in the address picks communities/<slug>.json instead of config.json, and
 * every link the app makes keeps ?org=, so shared links open the right community.
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

/** This page's settings (bypassing caches, so a change shows at once). */
export async function loadConfig() {
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
