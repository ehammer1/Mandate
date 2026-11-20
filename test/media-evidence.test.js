// Testimonia media in mandate evidence: sealed photos and videos, redacted copies, and when
// they were captured, proven on Base. The chain is a stand-in: block hashes and anchors are
// served from tables, as a Base node would.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const capture = require('../vendor/testimonia/capture');
const register = require('../vendor/testimonia/register');
const derive = require('../vendor/testimonia/derive');
const { checkMedia, factsSection, parseMediaRefs } = require('../broker/media-evidence');

const phone = capture.softwareSigner();
const keyId = '0x' + capture.keyIdOf(phone.publicKeyDer);
const T0 = Date.UTC(2027, 4, 20, 9, 0); // 20 May 2027, 09:00 UTC

/** A stand-in Base: blocks every 2 s from T0, and the anchors that were posted. */
function fakeChain() {
  const blocks = new Map();
  const anchored = new Map();
  const block = (n) => {
    if (!blocks.has(n)) blocks.set(n, { number: n, hash: '0x' + crypto.createHash('sha256').update(`block ${n}`).digest('hex'), timestamp: Math.floor(T0 / 1000) + n * 2 });
    return blocks.get(n);
  };
  return {
    chain: {
      provider: { getBlock: async (n) => block(n) },
      anchoredAt: async (k, d, root) => anchored.get(`${k}|${d}|${root}`) || [0n, 0n],
    },
    notBefore: (n) => ({ chainId: 8453, blockNumber: n, blockHash: block(n).hash }),
    anchor: (digest, n) => {
      const root = '0x' + crypto.randomBytes(32).toString('hex');
      anchored.set(`${keyId}|${digest}|${root}`, [BigInt(block(n).timestamp), BigInt(n)]);
      return { format: 'attest-anchor/1', keyId, sealDigest: digest, root, proof: [], block: n };
    },
  };
}

/** IPFS, as a table of CID -> bytes. */
function ipfs() {
  const store = new Map();
  const put = (bytes) => {
    const cid = 'b' + crypto.createHash('sha256').update(bytes).digest('hex').replace(/[^a-z2-7]/g, 'a').slice(0, 58).padEnd(58, 'a');
    store.set(cid, Buffer.from(bytes));
    return cid;
  };
  const fetchBytes = async (cid) => {
    if (!store.has(cid)) throw new Error(`${cid}: IPFS HTTP 404`);
    return store.get(cid);
  };
  return { put, fetchBytes };
}

/** A sealed photo (taken at block n1, anchored at n2) and a blurred copy (made at n3, anchored at n4). */
function photoWithEdit(c, store, [n1, n2, n3, n4]) {
  const jpeg = crypto.randomBytes(800);
  const photo = register.signRegistration({ signer: phone, bytes: jpeg, name: 'bridge.jpg', mediaType: 'image/jpeg', kind: 'image', notBefore: c.notBefore(n1), capture: { app: 'testimonia', mode: 'photo', takenMs: T0 + n1 * 2000 } });
  photo.anchor = c.anchor(register.recordDigest(photo), n2);
  const copy = crypto.randomBytes(700);
  const edit = derive.signDerive({ signer: phone, original: '0x' + photo.file.sha256, output: copy, edits: [{ op: 'blur', reason: 'face', region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }], reviewedBy: 'the owner', notBefore: c.notBefore(n3) });
  edit.anchor = c.anchor(derive.recordDigest(edit), n4);
  const ref = { file: store.put(jpeg), record: store.put(JSON.stringify(photo)), edits: [{ file: store.put(copy), record: store.put(JSON.stringify(edit)) }] };
  return { ref, photo, edit, copy };
}

const evidence = (refs) => `The bridge on Main St was repaired; photo attached.\n\n\`\`\`testimonia\n${JSON.stringify(refs)}\n\`\`\`\n`;
const spec = (media) => ({ title: 'Repair the Main St bridge', criteria: [], checks: ['media'], media });

test('a sealed photo and its blurred copy, both proven on Base inside the mandate window', async () => {
  const c = fakeChain();
  const store = ipfs();
  const { ref } = photoWithEdit(c, store, [100, 130, 400, 430]);
  const r = await checkMedia(spec({ capturedAfter: '2027-05-20T09:00:00Z', capturedBefore: '2027-05-21T00:00:00Z' }), evidence([ref]), { fetchBytes: store.fetchBytes, chain: c.chain });
  assert.deepEqual(r.failures, []);
  assert.equal(r.items[0].ok, true, r.items[0].problems.join('; '));
  assert.match(r.facts[0], /^Media 1: sealed photo, unaltered\. Photo: made between 2027-05-20 09:03 UTC and 2027-05-20 09:04 UTC \(proven on Base\)\. Redacted copy \(1 face blurred · reviewed by the owner\): made between/);
  assert.match(factsSection(r.facts), /## Verified media facts \(checked by the verifier node, not claims\)/);
});

test('a photo from before the mandate, or not anchored, does not count', async () => {
  const c = fakeChain();
  const store = ipfs();
  const { ref } = photoWithEdit(c, store, [100, 130, 400, 430]);
  const early = await checkMedia(spec({ capturedAfter: '2027-05-20T10:00:00Z' }), evidence([ref]), { fetchBytes: store.fetchBytes, chain: c.chain });
  assert.match(early.failures[0], /0 of 1 Testimonia media items meet/);
  assert.match(early.facts[0], /may have been captured before 2027-05-20T10:00:00Z/);

  const jpeg = crypto.randomBytes(300);
  const unanchored = register.signRegistration({ signer: phone, bytes: jpeg, kind: 'image', notBefore: c.notBefore(200), capture: { app: 'testimonia', mode: 'photo', takenMs: T0 } });
  const r = await checkMedia(spec({}), evidence([{ file: store.put(jpeg), record: store.put(JSON.stringify(unanchored)) }]), { fetchBytes: store.fetchBytes, chain: c.chain });
  assert.match(r.facts[0], /not proven on Base/);
  assert.equal(r.failures.length, 1);
  // A pilot without anchoring can accept the phone's clock, and the facts say so.
  const clock = await checkMedia(spec({ proof: 'clock' }), evidence([{ file: store.put(jpeg), record: store.put(JSON.stringify(unanchored)) }]), { fetchBytes: store.fetchBytes, chain: c.chain });
  assert.deepEqual(clock.failures, []);
});

test('a swapped photo, a forged edit or a fake block hash is reported, and rejects the evidence', async () => {
  const c = fakeChain();
  const store = ipfs();
  const { ref, edit } = photoWithEdit(c, store, [100, 130, 400, 430]);
  const swapped = { ...ref, file: store.put(crypto.randomBytes(800)) };
  const a = await checkMedia(spec({}), evidence([swapped]), { fetchBytes: store.fetchBytes, chain: c.chain });
  assert.match(a.facts[0], /does NOT check out .*doesn't match its seal/);
  assert.match(a.failures[0], /0 of 1/);

  const forged = { ...edit, edits: [] };
  const b = await checkMedia(spec({}), evidence([{ ...ref, edits: [{ file: ref.edits[0].file, record: store.put(JSON.stringify(forged)) }] }]), { fetchBytes: store.fetchBytes, chain: c.chain });
  assert.match(b.facts[0], /edit 1: no edits listed|edit 1:/);

  const jpeg = crypto.randomBytes(300);
  const fake = register.signRegistration({ signer: phone, bytes: jpeg, kind: 'image', notBefore: { ...c.notBefore(50), blockHash: '0x' + '00'.repeat(32) } });
  const f = await checkMedia(spec({}), evidence([{ file: store.put(jpeg), record: store.put(JSON.stringify(fake)) }]), { fetchBytes: store.fetchBytes, chain: c.chain });
  assert.match(f.facts[0], /doesn't match Base block 50/);
});

test('a sealed video counts too (its seal is inside the file)', async () => {
  const c = fakeChain();
  const store = ipfs();
  const sample = fs.readFileSync(path.join(__dirname, '..', 'attest', 'capture', 'vectors', 'sample.mp4'));
  const { file, manifest } = capture.simulateCapture(sample, { signer: phone, startMs: T0, meta: { notBefore: c.notBefore(10) } });
  const { sealDigest } = require('../vendor/testimonia/anchor');
  const anchorRecord = { anchor: c.anchor(sealDigest(manifest), 40) };
  const ref = { file: store.put(file), record: store.put(JSON.stringify({ ...manifest, ...anchorRecord })) };
  const r = await checkMedia(spec({ capturedAfter: '2027-05-20T09:00:00Z' }), evidence([ref]), { fetchBytes: store.fetchBytes, chain: c.chain });
  assert.equal(r.items[0].ok, true, r.items[0].problems.join('; '));
  assert.deepEqual(r.failures, []);
  assert.match(r.facts[0], /sealed recording, unaltered\. Recording: made between/);
});

test('evidence without media, or with a broken block, is explained', async () => {
  const none = await checkMedia(spec({}), 'Just text.', { fetchBytes: async () => Buffer.alloc(0), chain: null });
  assert.match(none.failures[0], /includes no Testimonia media; 1 needed/);
  assert.throws(() => parseMediaRefs('```testimonia\n{not json\n```'), /not valid JSON/);
  assert.equal(parseMediaRefs('```testimonia\n{"file":"bafy"}\n```')[0].file, 'bafy');
});

/** What navigator.credentials.get() returns when the Testimonia web app signs a record with a passkey. */
function passkeySign(privateKey, message) {
  const challenge = crypto.createHash('sha256').update(message).digest('base64url');
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'https://ehammer1.github.io', crossOrigin: false }));
  const authenticatorData = Buffer.concat([crypto.createHash('sha256').update('ehammer1.github.io').digest(), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
  const signature = crypto.sign('sha256', Buffer.concat([authenticatorData, crypto.createHash('sha256').update(clientDataJSON).digest()]), privateKey);
  return { type: 'webauthn', authenticatorData: authenticatorData.toString('base64'), clientDataJSON: clientDataJSON.toString('base64'), signature: signature.toString('base64') };
}

test('a photo sealed with a passkey in the Testimonia web app (sent from it as evidence) checks, and a forged one doesn’t', async () => {
  const c = fakeChain();
  const store = ipfs();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const jpeg = crypto.randomBytes(600);
  const draft = {
    format: 'attest-file/1',
    file: { sha256: crypto.createHash('sha256').update(jpeg).digest('hex'), bytes: jpeg.length, name: 'Testimonia 2027-05-20.jpg', mediaType: 'image/jpeg' },
    kind: 'image', claim: null, notBefore: c.notBefore(150), timeMs: T0 + 301_000,
    capture: { app: 'testimonia-web', mode: 'web-photo', startedMs: T0 + 300_000, endedMs: T0 + 300_000 },
    signer: { keyId: capture.keyIdOf(spki), publicKey: spki.toString('base64') },
  };
  const message = `attest-file/1|${capture.canonicalJSON({ file: draft.file, kind: draft.kind, claim: draft.claim, notBefore: draft.notBefore, timeMs: draft.timeMs, keyId: draft.signer.keyId, capture: draft.capture })}`;
  const record = { ...draft, sig: passkeySign(privateKey, message) };
  assert.equal(register.verifyRegistration(record, { bytes: jpeg }).ok, true, 'Promissa’s copy of the checker reads passkey signatures');
  const ref = { file: store.put(jpeg), record: store.put(JSON.stringify(record)) };
  const r = await checkMedia(spec({ proof: 'clock' }), evidence([ref]), { fetchBytes: store.fetchBytes, chain: c.chain });
  assert.deepEqual(r.failures, []);
  assert.equal(r.items[0].ok, true, r.items[0].problems.join('; '));
  const forged = { ...record, capture: { ...record.capture, startedMs: T0 } };
  const bad = await checkMedia(spec({ proof: 'clock' }), evidence([{ file: ref.file, record: store.put(JSON.stringify(forged)) }]), { fetchBytes: store.fetchBytes, chain: c.chain });
  assert.equal(bad.failures.length, 1);
});
