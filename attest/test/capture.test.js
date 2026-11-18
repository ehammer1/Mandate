// Capture format: reference session and verifier, on a real fragmented MP4.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const c = require('../src/capture');

const V = path.join(__dirname, '..', 'capture', 'vectors');
const vectors = JSON.parse(fs.readFileSync(path.join(V, 'vectors.json'), 'utf8'));
const sample = fs.readFileSync(path.join(V, 'sample.mp4'));
const sealed = fs.readFileSync(path.join(V, 'sealed.mp4'));
const testKey = crypto.createPrivateKey({
  key: Buffer.from(fs.readFileSync(path.join(V, 'test-key.pk8.b64'), 'utf8').trim(), 'base64'),
  format: 'der',
  type: 'pkcs8',
});

/** Byte offset of the first byte inside fragment i of a file. */
function fragmentOffset(buf, i) {
  const { init, fragments } = c.splitFile(buf);
  return init.length + fragments.slice(0, i).reduce((a, f) => a + f.length, 0);
}

test('matches the shared test vectors', () => {
  const { init, fragments, body } = c.splitFile(sample);
  assert.equal(init.length, vectors.initLength);
  assert.deepEqual(fragments.map((f) => f.length), vectors.fragmentLengths);
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  assert.equal(sha(init), vectors.initHash);
  assert.deepEqual(fragments.map(sha), vectors.fragmentHashes);
  assert.equal(sha(body), vectors.bodyHash);

  const signer = c.softwareSigner(testKey);
  assert.equal(c.keyIdOf(signer.publicKeyDer), vectors.keyId);
  assert.equal(signer.publicKeyDer.toString('base64'), vectors.publicKey);
  assert.equal(sha(Buffer.from(vectors.canonicalMeta, 'utf8')), vectors.metaHash);
  assert.ok(c.verifySig(signer.publicKeyDer, vectors.sealMessage, vectors.sealSignature));

  let head = c.chainStart(Buffer.from(vectors.initHash, 'hex'));
  assert.equal(head.toString('hex'), vectors.heads[0]);
  vectors.fragmentHashes.forEach((h, i) => {
    head = c.chainNext(head, Buffer.from(h, 'hex'), null);
    assert.equal(head.toString('hex'), vectors.heads[i + 1]);
  });
});

test('a sealed recording verifies, and still plays as ordinary MP4 layout', () => {
  const r = c.verifyCapture(sealed);
  assert.equal(r.status, 'sealed');
  assert.equal(r.fragments, 13);
  assert.equal(r.verifiedFragments, 13);
  // Everything before the manifest box is the untouched original.
  assert.ok(sealed.subarray(0, sample.length).equals(sample));
});

test('changing one byte inside a fragment is caught at that fragment', () => {
  const bad = Buffer.from(sealed);
  bad[fragmentOffset(bad, 7) + 200] ^= 0xff;
  const r = c.verifyCapture(bad);
  assert.equal(r.status, 'altered');
  assert.equal(r.alteredAt, 7);
  // The seal signs the whole fragment list, so fragments 0-6 are still proven original.
  assert.equal(r.verifiedFragments, 7);
});

test('removing, duplicating or reordering fragments is caught', () => {
  const { init, fragments, body } = c.splitFile(sealed);
  const trailer = body.subarray(init.length + fragments.reduce((a, f) => a + f.length, 0));
  const manifestBox = sealed.subarray(body.length);
  const rebuild = (frags) => Buffer.concat([init, ...frags, trailer, manifestBox]);

  const removed = c.verifyCapture(rebuild([...fragments.slice(0, 4), ...fragments.slice(5)]));
  assert.deepEqual([removed.status, removed.alteredAt, removed.verifiedFragments], ['altered', 4, 4]);

  const dup = c.verifyCapture(rebuild([...fragments.slice(0, 3), fragments[2], ...fragments.slice(3)]));
  assert.deepEqual([dup.status, dup.alteredAt], ['altered', 3]);

  const swapped = [...fragments];
  [swapped[5], swapped[6]] = [swapped[6], swapped[5]];
  const sw = c.verifyCapture(rebuild(swapped));
  assert.deepEqual([sw.status, sw.alteredAt], ['altered', 5]);

  const cut = c.verifyCapture(rebuild(fragments.slice(0, 10)));
  assert.deepEqual([cut.status, cut.alteredAt], ['altered', 10]);
});

test('changing the header or the index outside the fragments is caught', () => {
  const header = Buffer.from(sealed);
  header[40] ^= 0x01; // inside moov
  assert.deepEqual([c.verifyCapture(header).status, c.verifyCapture(header).alteredAt], ['altered', 'init']);

  const { body } = c.splitFile(sealed);
  const idx = Buffer.from(sealed);
  idx[body.length - 20] ^= 0x01; // inside mfra
  const r = c.verifyCapture(idx);
  assert.deepEqual([r.status, r.alteredAt], ['altered', 'outside-fragments']);
});

test('a forged or edited manifest is rejected', () => {
  const { body, manifestJSON } = c.splitFile(sealed);
  const m = JSON.parse(manifestJSON);

  // Edit the device name: the seal signature covers the metadata.
  const edited = { ...m, meta: { ...m.meta, device: 'someone else' } };
  assert.equal(c.verifyCapture(Buffer.concat([body, c.manifestBox(edited)])).status, 'invalid');

  // Re-seal an edited video with a different key, but claim the original key.
  const tampered = Buffer.from(sample);
  tampered[fragmentOffset(tampered, 2) + 100] ^= 0xff;
  const { manifest: forged } = c.simulateCapture(tampered, { startMs: m.startMs });
  forged.meta = { ...forged.meta, keyId: m.meta.keyId, publicKey: m.meta.publicKey };
  assert.equal(c.verifyCapture(Buffer.concat([tampered, c.manifestBox(forged)])).status, 'invalid');

  // A different key re-sealing an edited video is valid, but signed by a different key.
  const resealed = c.simulateCapture(tampered).manifest;
  assert.notEqual(resealed.meta.keyId, m.meta.keyId);
});

test('the manifest can travel separately as .manifest.json', () => {
  const { body, manifestJSON } = c.splitFile(sealed);
  assert.equal(c.verifyCapture(body).status, 'invalid');
  assert.equal(c.verifyCapture(body, { manifest: JSON.parse(manifestJSON) }).status, 'sealed');
});

test('a recording cut short by a crash is provable up to its last checkpoint', () => {
  const { init, fragments } = c.splitFile(sample);
  const s = new c.CaptureSession({ signer: c.softwareSigner(), startMs: 1 });
  s.init(init);
  fragments.slice(0, 12).forEach((f, i) => {
    s.addFragment(f);
    if (i === 9) s.checkpoint(11);
  });
  // Phone dies here: 12 fragments on disk, checkpoint covers 10, no seal.
  const onDisk = Buffer.concat([init, ...fragments.slice(0, 12)]);
  const r = c.verifyCapture(Buffer.concat([onDisk, c.manifestBox(s.unsealed())]));
  assert.equal(r.status, 'partial');
  assert.equal(r.verifiedFragments, 10);

  const bad = Buffer.from(onDisk);
  bad[fragmentOffset(bad, 3) + 50] ^= 0xff;
  const r2 = c.verifyCapture(Buffer.concat([bad, c.manifestBox(s.unsealed())]));
  assert.deepEqual([r2.status, r2.alteredAt, r2.verifiedFragments], ['altered', 3, 3]);
});

test('sensor records are bound into the chain', () => {
  const { init, fragments } = c.splitFile(sample);
  const s = new c.CaptureSession({ signer: c.softwareSigner(), startMs: 1 });
  s.init(init);
  fragments.forEach((f, i) => s.addFragment(f, Buffer.from(`gyro ${i}`)));
  const file = Buffer.concat([sample, c.manifestBox(s.seal({ endMs: 2, trailer: c.splitFile(sample).body.subarray(init.length + fragments.reduce((a, f) => a + f.length, 0)) }))]);
  assert.equal(c.verifyCapture(file).status, 'sealed');

  const m = JSON.parse(c.splitFile(file).manifestJSON);
  m.fragments[4].sensorHash = crypto.createHash('sha256').update('forged gyro').digest('hex');
  assert.equal(c.verifyCapture(c.splitFile(file).body, { manifest: m }).status, 'altered');
});

test('malformed files are rejected, not crashed on', () => {
  assert.equal(c.verifyCapture(Buffer.from('not a video')).status, 'invalid');
  assert.equal(c.verifyCapture(sealed.subarray(0, sealed.length - 7)).status, 'invalid');
  assert.equal(c.verifyCapture(Buffer.alloc(0)).status, 'invalid');
  const extra = Buffer.concat([sample, Buffer.from('\x00\x00\x00\x0cjunkjunk', 'latin1')]);
  assert.match(c.verifyCapture(extra).problems[0], /unexpected junk box/);
});
