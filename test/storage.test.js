// Where files go: S3-compatible storage (signed requests), IPFS, or both; any copy is the file
// if its SHA-256 matches; takedowns remove every copy. Stand-in services, no network.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { s3, mirror, fromEnv } = require('../services/identity/storage');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('S3-compatible storage: stored under its fingerprint, signed (SigV4), deleted on takedown', async () => {
  const calls = [];
  const store = s3({
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    bucket: 'promissa',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
    publicUrl: 'https://files.example.org/',
    now: () => new Date('2026-11-22T12:00:00Z'),
    fetch: async (url, init) => (calls.push({ url, init }), { ok: true, status: 200 }),
  });
  const bytes = Buffer.from('%PDF-1.7 a poster');
  const [loc] = await store.put(bytes, 'poster.pdf', 'application/pdf');
  assert.deepEqual(loc, { kind: 's3', url: `https://files.example.org/${sha(bytes)}` });
  const { url, init } = calls[0];
  assert.equal(url, `https://acct.r2.cloudflarestorage.com/promissa/${sha(bytes)}`);
  assert.equal(init.method, 'PUT');
  assert.equal(init.headers['x-amz-content-sha256'], sha(bytes));
  assert.equal(init.headers['x-amz-date'], '20261122T120000Z');
  assert.match(init.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261122\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  await store.remove(loc);
  assert.equal(calls[1].init.method, 'DELETE');
  await store.remove({ kind: 's3', url: 'https://elsewhere.example/abc' }); // never deletes outside its own bucket
  assert.equal(calls.length, 2);
});

test('both at once: a file stored if at least one copy works; every copy listed and removed', async () => {
  const log = [];
  const ipfs = { kind: 'ipfs', put: async () => ({ kind: 'ipfs', cid: 'bafy' + 'a'.repeat(40) }), remove: async (l) => log.push(['ipfs', l.kind]) };
  const bucket = { kind: 's3', put: async () => ({ kind: 's3', url: 'https://files.example.org/x' }), remove: async (l) => log.push(['s3', l.kind]) };
  const down = { kind: 's3', put: async () => { throw new Error('offline'); }, remove: async () => {} };
  assert.deepEqual((await mirror([ipfs, bucket]).put(Buffer.from('x'))).map((l) => l.kind), ['ipfs', 's3']);
  const msgs = [];
  assert.deepEqual((await mirror([ipfs, down], (m) => msgs.push(m)).put(Buffer.from('x'))).map((l) => l.kind), ['ipfs']);
  assert.match(msgs[0], /copy to s3 failed: offline/);
  await assert.rejects(mirror([down]).put(Buffer.from('x')), /could not be stored anywhere/);
  await mirror([ipfs, bucket]).remove({ kind: 's3', url: 'https://files.example.org/x' });
  assert.equal(log.length, 2);
});

test('chosen by settings: IPFS, S3 or both; nothing configured means uploads are off', () => {
  const s3env = { S3_ENDPOINT: 'https://e', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_PUBLIC_URL: 'https://p' };
  assert.equal(fromEnv({}), null);
  assert.equal(fromEnv({ PINATA_JWT: 'j' }).kind, 'ipfs');
  assert.equal(fromEnv(s3env).kind, 's3');
  assert.equal(fromEnv({ ...s3env, PINATA_JWT: 'j', STORAGE: 'both' }).kind, 'ipfs+s3');
  assert.equal(fromEnv({ PINATA_JWT: 'j', STORAGE: 'both' }).kind, 'ipfs'); // only one configured: that one
});

test('Promissa Plus: checked with the assistant service, cached; anything unclear counts as free', async () => {
  const { createPlanCheck } = require('../services/identity/plan');
  let calls = 0;
  const check = createPlanCheck({ url: 'https://assistant.example', fetch: async (u, init) => (calls++, { ok: true, json: async () => ({ subscribed: init.headers.Authorization === 'Bearer paid' }) }) });
  assert.equal(await check('paid'), true);
  assert.equal(await check('paid'), true);
  assert.equal(calls, 1); // cached
  assert.equal(await check('free'), false);
  assert.equal(await check(''), false);
  assert.equal(await createPlanCheck({ url: 'https://x', fetch: async () => { throw new Error('down'); } })('paid'), false);
});

test('decentralized S3-compatible storage: Filebase also gives the IPFS address; Storj and others by preset', async () => {
  const { PRESETS } = require('../services/identity/storage');
  const calls = [];
  const cid = 'bafybeig' + 'a'.repeat(50);
  const store = s3({ ...PRESETS.filebase, bucket: 'promissa', accessKeyId: 'k', secretAccessKey: 's', fetch: async (url, init) => (calls.push({ url, init }), { ok: true, status: 200, headers: { get: (h) => (h === 'x-amz-meta-cid' ? cid : null) } }) });
  const bytes = Buffer.from('ID3 a radio ad');
  const locs = await store.put(bytes, 'ad.mp3', 'audio/mpeg');
  assert.deepEqual(locs, [{ kind: 'ipfs', cid, key: sha(bytes) }]); // no public bucket address needed: fetched through IPFS
  assert.match(calls[0].url, /^https:\/\/s3\.filebase\.com\/promissa\//);
  await store.remove(locs[0]); // deleting the object also unpins it on Filebase
  assert.equal(calls[1].init.method, 'DELETE');
  assert.equal(fromEnv({ STORAGE: 's3', STORAGE_PROVIDER: 'filebase', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }).kind, 's3+ipfs');
  assert.equal(fromEnv({ STORAGE: 's3', STORAGE_PROVIDER: 'storj', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }), null); // Storj needs its public share address
  assert.equal(fromEnv({ STORAGE: 's3', STORAGE_PROVIDER: 'storj', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_PUBLIC_URL: 'https://link.storjshare.io/raw/x/b' }).kind, 's3');
});
