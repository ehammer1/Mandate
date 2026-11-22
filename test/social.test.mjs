// Posting to one's own Bluesky account: app passwords only, a clickable link card, expired
// sessions renewed; tokens kept in the browser and sent only to Bluesky. Stand-in network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const calls = [];
let expired = false;
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url, init });
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  if (url.endsWith('createSession')) return ok({ handle: 'eric.bsky.social', did: 'did:plc:abc', accessJwt: 'A1', refreshJwt: 'R1' });
  if (url.endsWith('refreshSession')) return ok({ accessJwt: 'A2', refreshJwt: 'R2' });
  if (url.endsWith('createRecord')) {
    if (expired && init.headers.Authorization === 'Bearer A1') return { ok: false, status: 400, json: async () => ({ error: 'ExpiredToken' }) };
    return ok({ uri: 'at://did:plc:abc/app.bsky.feed.post/3kxyz' });
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
const social = await import('../app/src/social.js');

test('Bluesky: only an app password; posts carry a clickable link and a link card', async () => {
  await assert.rejects(social.connectBluesky('eric.bsky.social', 'my-real-password'), /app password/);
  await social.connectBluesky('@eric.bsky.social', 'abcd-efgh-ijkl-mnop');
  assert.equal(social.connections().bluesky.handle, 'eric.bsky.social');
  assert.ok(!JSON.stringify(social.connections()).includes('abcd-efgh'), 'the app password itself is never kept');
  const url = 'https://ehammer1.github.io/Mandate/?org=demo#poll-1';
  const text = `Café hours vote: have your say ${url}`;
  const link = await social.postBluesky({ text, url, title: 'Café hours', description: 'Have your say' });
  assert.equal(link, 'https://bsky.app/profile/eric.bsky.social/post/3kxyz');
  const rec = JSON.parse(calls.at(-1).init.body).record;
  const { byteStart, byteEnd } = rec.facets[0].index;
  assert.equal(new TextDecoder().decode(new TextEncoder().encode(text).slice(byteStart, byteEnd)), url); // byte offsets, even after "é"
  assert.equal(rec.embed.external.uri, url);
  assert.ok(calls.every((c) => c.url.startsWith('https://bsky.social/')), 'only Bluesky is contacted');
  await assert.rejects(social.postBluesky({ text: 'x'.repeat(301), url }), /300 characters/);
});

test('an expired Bluesky session is renewed once, then the post goes through', async () => {
  expired = true;
  const link = await social.postBluesky({ text: 'Renewed', url: '' });
  assert.match(link, /3kxyz$/);
  assert.equal(social.connections().bluesky.access, 'A2');
  social.disconnect('bluesky');
  assert.equal(social.connections().bluesky, undefined);
  await assert.rejects(social.postMastodon({ text: 'hi' }), /Connect your Mastodon account/);
});
