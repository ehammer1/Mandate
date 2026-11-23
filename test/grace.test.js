// v6: a poll may give ballots sealed offline a delivery window after the close, for approved
// carriers only (clerk tablets, polling-place boxes); the result waits for the window to end.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Identity } = require('@semaphore-protocol/identity');
const { deployAll } = require('../scripts/deploy');
const { buildBallot } = require('../client/ballot');

process.env.SEMAPHORE_ARTIFACTS_DIR = path.dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json'));
const HOUR = 3600;
let c, provider, admin, carrier, stranger;
const people = Array.from({ length: 4 }, (_, i) => new Identity(`grace-voter-${i}`));
const send = async (p) => (await p).wait();
const errName = async (p) => {
  try {
    await p;
  } catch (e) {
    try {
      return c.vote.interface.parseError(e.data)?.name || e.revert?.name || e.shortMessage;
    } catch {
      return e.revert?.name || e.shortMessage;
    }
  }
  return 'no revert';
};
const ballot = (pollId, who, option) => buildBallot({ provider, vote: c.vote, pollId, identity: who, option });
const open = async (grace, changeCutoff = 0) => {
  await send(c.vote.createPollWith({ groupId: await c.identity.groupId(2), duration: 24 * HOUR, quorum: 1, options: 2, action: 0, actionData: '0x', questionCID: 'Q', bond: 0, settings: { changeCutoff, channels: 0, ranked: false, grace } }));
  return c.vote.pollCount();
};
const later = async (secs) => {
  await provider.send('evm_increaseTime', [secs]);
  await provider.send('evm_mine', []);
};

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 4, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, , stranger] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  // A carrier signs its fingerprints with its own key, as in the app.
  carrier = ethers.Wallet.createRandom().connect(provider);
  await send(admin.sendTransaction({ to: carrier.address, value: ethers.parseEther('5') }));
  ({ contracts: c } = await deployAll(admin, { rules: { MIN_POLL_MINUTES: 10 } }));
  await send(c.identity.setIssuer(admin.address, 1, true, 'Clerk'));
  const longAgo = (await provider.getBlock('latest')).timestamp - 3 * 365 * 86_400;
  for (const [i, p] of people.entries()) await send(c.identity.enroll(p.commitment, 1, ethers.id(`grace-doc-${i}`), longAgo));
  await send(c.vote.grantRole(await c.vote.CARRIER_ROLE(), carrier.address));
});
after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('the delivery window is at most 24 hours', async () => {
  assert.equal(Number(await c.vote.MAX_GRACE()), 24 * HOUR);
  assert.equal(await errName(c.vote.createPollWith.staticCall({ groupId: await c.identity.groupId(2), duration: 24 * HOUR, quorum: 1, options: 2, action: 0, actionData: '0x', questionCID: 'Q', bond: 0, settings: { changeCutoff: 0, channels: 0, ranked: false, grace: 24 * HOUR + 1 } })), 'InvalidParams');
});

test('after the close, only ballots a carrier fingerprinted before it count, within the window', async () => {
  const { heldTree, signHeld, heldCode, readHeldCode, sigParts } = require('../client/held');
  const id = await open(6 * HOUR);
  assert.equal(Number((await c.vote.settingsOf(id)).grace), 6 * HOUR);
  await send(c.vote.castBallot(id, await ballot(id, people[0], 0)));
  // Sealed offline before the close, handed to the carrier.
  const carried = await ballot(id, people[1], 1);
  const lateChange = await ballot(id, people[0], 1);
  const another = await ballot(id, people[2], 1);
  const notHeld = await ballot(id, people[3], 0);
  const { root, paths } = heldTree([carried, lateChange, another]);
  const where = { chainId: (await provider.getNetwork()).chainId, voteAddress: await c.vote.getAddress(), pollId: id, root };

  // Only a carrier's signature counts; anyone may post it (the relay, a text-message gateway).
  assert.equal(await errName(c.vote.connect(stranger).commitHeld.staticCall(id, root, ...sigParts(await signHeld(ethers.Wallet.createRandom(), where)))), 'AccessControlUnauthorizedAccount');
  const code = heldCode(where, await signHeld(carrier, where));
  const h = readHeldCode(code);
  const rc = await send(c.vote.connect(stranger).commitHeld(id, h.root, ...sigParts(h.sig)));
  assert.ok(rc.logs.some((l) => c.vote.interface.parseLog(l)?.name === 'HeldCommitted'));
  assert.equal(await c.vote.heldBy(id, root), carrier.address);

  await later(24 * HOUR + 60); // closed
  assert.equal(await errName(c.vote.connect(carrier).commitHeld.staticCall(id, ethers.id('more'), 0, ethers.ZeroHash, ethers.ZeroHash)), 'NotOpen'); // too late to fingerprint more
  assert.equal(await errName(c.vote.connect(stranger).castBallot.staticCall(id, notHeld)), 'NotOpen'); // nobody else without a fingerprint
  assert.equal(await errName(c.vote.deliverHeld.staticCall(id, notHeld, root, paths[0])), 'NotHeld'); // not in the fingerprint
  assert.equal(await errName(c.vote.deliverHeld.staticCall(id, carried, ethers.id('other'), paths[0])), 'NotHeld'); // no such fingerprint
  assert.equal(await errName(c.vote.finalize.staticCall(id)), 'StillOpen'); // the window is still open
  await send(c.vote.connect(stranger).deliverHeld(id, carried, root, paths[0])); // anyone may deliver it
  assert.equal(Number(await c.vote.unprovenLate(id)), 0);
  // A carrier that had no signal at all before the close: still counted, but publicly as unproven.
  const rc2 = await send(c.vote.connect(carrier).castBallot(id, notHeld));
  assert.ok(rc2.logs.some((l) => c.vote.interface.parseLog(l)?.name === 'DeliveredUnproven'));
  assert.equal(Number(await c.vote.unprovenLate(id)), 1);
  assert.equal(await errName(c.vote.deliverHeld.staticCall(id, lateChange, root, paths[1])), 'ChangesClosed'); // no changing votes after the close

  await later(6 * HOUR);
  assert.equal(await errName(c.vote.deliverHeld.staticCall(id, another, root, paths[2])), 'NotOpen'); // too late even with a fingerprint
  await send(c.vote.finalize(id));
  const t = await c.vote.tally(id);
  assert.deepEqual(t.slice(0, 2).map(Number), [2, 1]);
});

test('through the relay: a texted fingerprint code is published, then held ballots delivered after the close', async () => {
  const { createRelayer } = require('../broker/relayer');
  const { heldTree, signHeld, heldCode } = require('../client/held');
  const relay = createRelayer({ provider, signer: stranger, voteAddress: await c.vote.getAddress(), log: () => {} });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${relay.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const id = await open(6 * HOUR);
    const b = await ballot(id, people[3], 1);
    const { root, paths } = heldTree([b]);
    const where = { chainId: (await provider.getNetwork()).chainId, voteAddress: await c.vote.getAddress(), pollId: id, root };
    assert.equal((await post('/held', { code: heldCode(where, await signHeld(ethers.Wallet.createRandom(), where)) })).body.error, 'AccessControlUnauthorizedAccount'); // not a carrier
    assert.equal((await post('/held', { code: 'PH1:nonsense' })).status, 400);
    assert.equal((await post('/held', { code: heldCode(where, await signHeld(carrier, where)) })).status, 200);
    await later(24 * HOUR + 60);
    assert.equal((await post('/ballot', { pollId: id, ballot: b })).body.error, 'NotOpen'); // closed without the proof of time
    assert.equal((await post('/ballot', { pollId: id, ballot: b, held: { root, path: paths[0] } })).status, 200);
  } finally {
    relay.close();
  }
});

test('fingerprint paths match for any number of ballots', async () => {
  const { heldTree, leafOf } = require('../client/held');
  const { ethers: e } = require('ethers');
  const pair = (a, b) => e.keccak256(e.concat(BigInt(a) < BigInt(b) ? [a, b] : [b, a]));
  for (const n of [1, 2, 3, 5, 8, 13]) {
    const bs = Array.from({ length: n }, (_, i) => ({ nullifier: 1000n + BigInt(i), message: BigInt(i % 2) }));
    const { root, paths } = heldTree(bs);
    bs.forEach((b, i) => assert.equal(paths[i].reduce(pair, leafOf(b)), root, `n=${n} i=${i}`));
  }
});

test('a poll without a delivery window closes for carriers too', async () => {
  const id = await open(0);
  const b = await ballot(id, people[3], 0);
  await later(24 * HOUR + 60);
  assert.equal(await errName(c.vote.connect(carrier).castBallot.staticCall(id, b)), 'NotOpen');
  await send(c.vote.finalize(id));
});
