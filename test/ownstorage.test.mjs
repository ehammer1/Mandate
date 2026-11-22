// Bring your own storage: the browser signs S3 requests exactly as the server does, files go
// to the person's own account, and Promissa records only the fingerprint and locations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { s3Request, putOwn, PRESETS } from '../app/src/ownstorage.js';

const require = createRequire(import.meta.url);
const { s3 } = require('../services/identity/storage.js');
const crypto = require('node:crypto');

test('the browser signs requests exactly like the server (same SigV4 signature)', async () => {
  const o = { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'promissa', region: 'auto', accessKeyId: 'AKID', secretAccessKey: 'secret', publicUrl: 'https://files.example.org' };
  const now = new Date('2026-11-22T12:00:00Z');
  const bytes = Buffer.from('%PDF-1.7 poster');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  let server;
  await s3({ ...o, now: () => now, fetch: async (url, init) => ((server = { url, init }), { ok: true, status: 200 }) }).put(bytes, 'p.pdf', 'application/pdf');
  const browser = await s3Request(o, 'PUT', sha, new Uint8Array(bytes), 'application/pdf', now);
  assert.equal(browser.url, server.url);
  assert.equal(browser.init.headers.Authorization, server.init.headers.Authorization);
});

test('own storage: Pinata or Filebase; the record holds the fingerprint and where the file is', async () => {
  const bytes = new TextEncoder().encode('ID3 a campaign ad');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const pin = await putOwn(bytes, 'ad.mp3', 'audio/mpeg', { kind: 'pinata', jwt: 'j' }, async (url, init) => {
    assert.equal(url, 'https://api.pinata.cloud/pinning/pinFileToIPFS');
    assert.equal(init.headers.Authorization, 'Bearer j');
    return { ok: true, json: async () => ({ IpfsHash: 'bafy' + 'b'.repeat(50) }) };
  });
  assert.deepEqual(pin, { sha256: sha, locations: [{ kind: 'ipfs', cid: 'bafy' + 'b'.repeat(50) }] });
  const fb = await putOwn(bytes, 'ad.mp3', 'audio/mpeg', { kind: 's3', provider: 'filebase', bucket: 'mine', accessKeyId: 'k', secretAccessKey: 's' }, async (url) => {
    assert.ok(url.startsWith(`${PRESETS.filebase.endpoint}/mine/${sha}`));
    return { ok: true, headers: { get: (h) => (h === 'x-amz-meta-cid' ? 'bafy' + 'c'.repeat(50) : null) } };
  });
  assert.deepEqual(fb.locations, [{ kind: 'ipfs', cid: 'bafy' + 'c'.repeat(50) }]);
  await assert.rejects(putOwn(bytes, 'x', 'audio/mpeg', { kind: 's3', provider: 'r2', endpoint: 'https://e', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }, async () => ({ ok: false, status: 403 })), /refused the file \(403\)/);
});
