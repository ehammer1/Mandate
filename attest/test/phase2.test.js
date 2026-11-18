// Phase 2: phones registered to people, seals anchored in batches, recordings checked on-chain.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const capture = require('../src/capture');
const anchor = require('../src/anchor');
const { deploySystem } = require('../src/deploy');

const art = (n) => require(`../build/${n}.json`);
const ERRORS = new ethers.Interface(
  ['PrincipalRegistry', 'DeviceRegistry', 'AnchorRegistry'].flatMap((n) => art(n).abi.filter((x) => x.type === 'error')),
);
const sample = fs.readFileSync(path.join(__dirname, '..', 'capture', 'vectors', 'sample.mp4'));

let provider, admin, addrs, idIssuer, devIssuer, relayer, alice, bob, mallory;
const devices = (who) => new ethers.Contract(addrs.devices, art('DeviceRegistry').abi, who);
const anchors = (who) => new ethers.Contract(addrs.anchors, art('AnchorRegistry').abi, who);
const wait = (p) => p.then((tx) => tx.wait());

before(async () => {
  const g = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 1, defaultBalance: 1_000_000 }, chain: { hardfork: 'shanghai' } });
  provider = new ethers.BrowserProvider(g, undefined, { cacheTimeout: -1 });
  admin = await provider.getSigner(0);
  [idIssuer, devIssuer, relayer, alice, bob, mallory] = await Promise.all(
    Array.from({ length: 6 }, async () => {
      const w = ethers.Wallet.createRandom().connect(provider);
      await wait(admin.sendTransaction({ to: w.address, value: ethers.parseEther('10') }));
      return w;
    }),
  );
  addrs = await deploySystem(admin);
  const principals = new ethers.Contract(addrs.principals, art('PrincipalRegistry').abi, admin);
  await wait(principals.setIssuer(idIssuer.address, 2, true, 'Test ID verifier'));
  await wait(principals.connect(idIssuer).enrollHuman(alice.address, 2, ethers.id('alice-passport')));
  await wait(principals.connect(idIssuer).enrollHuman(bob.address, 1, ethers.ZeroHash));
  await wait(devices(admin).setDeviceIssuer(devIssuer.address, true, 'Test device checker'));
});

async function revertName(fn) {
  try {
    await fn();
  } catch (e) {
    if (e.revert?.name) return e.revert.name;
    let data = e.data;
    if (!data && e.transaction) {
      try { await provider.call(e.transaction); } catch (e2) { data = e2.data; }
    }
    return data ? ERRORS.parseError(data)?.name : undefined;
  }
  return 'did not revert';
}

async function deadline() {
  return BigInt((await provider.getBlock('latest')).timestamp + 600);
}

/** A phone: a P-256 key (software here; the security chip on a real phone). */
function newPhone() {
  const signer = capture.softwareSigner();
  return { signer, spki: signer.publicKeyDer, keyId: '0x' + capture.keyIdOf(signer.publicKeyDer) };
}

async function register(phone, owner, platform = 'android') {
  const dl = await deadline();
  const ownerSig = await anchor.signDeviceConsent(owner, { addresses: addrs, keyId: phone.keyId, deadline: dl });
  return anchor.registerDevice(devIssuer, { addresses: addrs, spki: phone.spki, platform, evidence: '0x1234', owner: owner.address, deadline: dl, ownerSig });
}

async function record(phone, platform = 'android') {
  const now = (await provider.getBlock('latest')).timestamp * 1000;
  return capture.simulateCapture(sample, { signer: phone.signer, meta: { platform, device: 'Test phone' }, startMs: now - 20_000 });
}

let alicePhone, bobPhone;

test('a phone is registered to its owner only with the owner’s signed consent', async () => {
  alicePhone = newPhone();
  assert.equal(await register(alicePhone, alice), alicePhone.keyId);
  const d = await devices(admin).device(alicePhone.keyId);
  assert.equal(d.owner, alice.address);
  assert.equal(d.ownerTier, 2n);
  assert.equal(d.platform, 2n);
  assert.equal(await devices(admin).issuerNames(d.issuer), 'Test device checker');

  bobPhone = newPhone();
  await register(bobPhone, bob, 'ios');
  assert.equal((await devices(admin).device(bobPhone.keyId)).ownerTier, 1n); // basic account

  // Someone else's consent, a key used twice, an unregistered owner, a non-issuer, a bad key.
  const p = newPhone();
  const dl = await deadline();
  const forged = await anchor.signDeviceConsent(mallory, { addresses: addrs, keyId: p.keyId, deadline: dl });
  assert.equal(await revertName(() => anchor.registerDevice(devIssuer, { addresses: addrs, spki: p.spki, platform: 'ios', owner: alice.address, deadline: dl, ownerSig: forged })), 'BadConsent');
  assert.equal(await revertName(() => register(alicePhone, alice)), 'KeyAlreadyRegistered');
  assert.equal(await revertName(() => register(newPhone(), mallory)), 'OwnerNotInGoodStanding');
  const consent = await anchor.signDeviceConsent(alice, { addresses: addrs, keyId: p.keyId, deadline: dl });
  assert.equal(await revertName(() => anchor.registerDevice(mallory, { addresses: addrs, spki: p.spki, platform: 'ios', owner: alice.address, deadline: dl, ownerSig: consent })), 'AccessControlUnauthorizedAccount');
  assert.equal(await revertName(() => devices(devIssuer).register('0x1234', 1, ethers.ZeroHash, alice.address, dl, consent)), 'BadKey');
});

let aliceRec, bobRec, proofA;

test('the relayer anchors only genuine seals from registered phones, in one batch', async () => {
  const batcher = new anchor.AnchorBatcher({ addresses: addrs, signer: relayer });
  aliceRec = (await record(alicePhone)).manifest;
  bobRec = (await record(bobPhone, 'ios')).manifest;
  const dA = await batcher.add(aliceRec);
  await batcher.add(bobRec);

  const forged = structuredClone(aliceRec);
  forged.seal.fileHash = 'ff'.repeat(32);
  await assert.rejects(batcher.add(forged), /seal signature is not valid/);
  await assert.rejects(batcher.add((await record(newPhone())).manifest), /not registered/);

  const root = await batcher.flush();
  assert.ok(root);
  assert.equal((await anchors(admin).anchorOf(root)).count, 2n);
  assert.equal(await batcher.flush(), null);
  proofA = batcher.proofFor(dA);
  assert.equal(proofA.root, root);
});

test('a recording checks out on-chain: whose phone, verified or basic, and when anchored', async () => {
  const r = await anchor.checkOnchain({ manifest: aliceRec, proof: proofA, provider, addresses: addrs });
  assert.deepEqual(r.problems, []);
  assert.equal(r.device.owner, alice.address);
  assert.equal(r.device.tierWhenRegistered, 'verified');
  assert.equal(r.device.platform, 'android');
  assert.equal(r.device.issuer.name, 'Test device checker');
  assert.equal(r.anchor.deviceRegisteredThen, true);
  assert.ok(r.anchor.minutesAfterRecording >= 0 && r.anchor.minutesAfterRecording < 5);

  // The proof can travel inside the manifest too.
  const r2 = await anchor.checkOnchain({ manifest: { ...aliceRec, anchor: proofA }, provider, addresses: addrs });
  assert.equal(r2.ok, true);

  // A proof for a different recording, or a made-up root, is caught.
  const wrong = await anchor.checkOnchain({ manifest: bobRec, proof: proofA, provider, addresses: addrs });
  assert.match(wrong.problems.join(), /different recording/);
  const fake = await anchor.checkOnchain({ manifest: aliceRec, proof: { ...proofA, root: ethers.id('nope') }, provider, addresses: addrs });
  assert.match(fake.problems.join(), /does not match a posted root/);
  const none = await anchor.checkOnchain({ manifest: aliceRec, provider, addresses: addrs });
  assert.match(none.problems.join(), /no anchor proof/);
});

test('revoking a phone stops new anchors but keeps earlier recordings valid', async () => {
  assert.equal(await revertName(() => devices(mallory).revoke(alicePhone.keyId)), 'NotAuthorized');
  await wait(devices(alice).revoke(alicePhone.keyId));
  assert.equal(await revertName(() => devices(alice).revoke(alicePhone.keyId)), 'AlreadyRevoked');

  const before = await anchor.checkOnchain({ manifest: aliceRec, proof: proofA, provider, addresses: addrs });
  assert.deepEqual(before.problems, []); // anchored while the phone was still registered

  const batcher = new anchor.AnchorBatcher({ addresses: addrs, signer: relayer });
  await assert.rejects(batcher.add((await record(alicePhone)).manifest), /revoked/);
});

test('large batches: every proof verifies on-chain', async () => {
  const leaves = Array.from({ length: 37 }, (_, i) => anchor.leaf(ethers.id(`k${i}`), ethers.id(`s${i}`)));
  const tree = anchor.merkle(leaves);
  await wait(anchors(relayer).anchor(tree.root, leaves.length));
  for (const i of [0, 1, 17, 36]) {
    const [t] = await anchors(admin).anchoredAt(ethers.id(`k${i}`), ethers.id(`s${i}`), tree.root, tree.proof(leaves[i]));
    assert.ok(t > 0n, `leaf ${i}`);
  }
  assert.equal((await anchors(admin).anchoredAt(ethers.id('k1'), ethers.id('s2'), tree.root, tree.proof(leaves[1])))[0], 0n);
  assert.equal(await revertName(() => anchors(relayer).anchor(tree.root, 1)), 'AlreadyAnchored');
  assert.equal(await revertName(() => anchors(relayer).anchor(ethers.ZeroHash, 1)), 'EmptyRoot');
});

test('the relayer service: phones post seals, then fetch their proofs', async () => {
  const { createServer } = require('../services/anchor-relayer');
  const phone = newPhone();
  await register(phone, bob, 'ios');
  const batcher = new anchor.AnchorBatcher({ addresses: addrs, signer: relayer });
  const { server, flush } = createServer({ batcher, intervalMs: 0 });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const rec = (await record(phone, 'ios')).manifest;
    const post = await fetch(`${base}/seals`, { method: 'POST', body: JSON.stringify(rec) });
    assert.equal(post.status, 202);
    const { sealDigest } = await post.json();
    assert.equal((await fetch(`${base}/proofs/${sealDigest}`)).status, 404); // not anchored yet

    const bad = await fetch(`${base}/seals`, { method: 'POST', body: JSON.stringify({ ...rec, seal: { ...rec.seal, n: 1 } }) });
    assert.equal(bad.status, 422);
    assert.equal((await fetch(`${base}/seals`, { method: 'POST', body: 'nope' })).status, 400);

    await flush();
    const proof = await (await fetch(`${base}/proofs/${sealDigest}`)).json();
    const r = await anchor.checkOnchain({ manifest: rec, proof, provider, addresses: addrs });
    assert.deepEqual(r.problems, []);
    assert.equal(r.device.tierWhenRegistered, 'basic');
  } finally {
    server.close();
  }
});
