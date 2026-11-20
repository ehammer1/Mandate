// v6: the council can switch the ballot-proof checker (e.g. to a quantum-safe one later) for new
// polls and budget rounds, only to a checker that passes a real test proof and rejects a forged one.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Identity } = require('@semaphore-protocol/identity');
const { deployAll, deploy } = require('../scripts/deploy');
const { buildBallot } = require('../client/ballot');

process.env.SEMAPHORE_ARTIFACTS_DIR = path.dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json'));
const DAY = 86_400;
// A "checker" that says yes to everything: returns true for any call.
const ACCEPT_ALL = '0x600a600c600039600a6000f3' + '600160005260206000f3';
let provider, admin, clerk, c, testProof, nextVerifier;
const people = [0, 1].map((i) => new Identity(`verifier-switch-${i}`));
const send = async (p) => (await p).wait();
const revertName = async (k, p) => {
  try {
    await p;
  } catch (e) {
    try {
      return k.interface.parseError(e.data)?.name || e.revert?.name || e.shortMessage;
    } catch {
      return e.revert?.name || e.shortMessage;
    }
  }
  return 'no revert';
};
const openPoll = async (title) => {
  await send(c.vote.createPoll(await c.identity.groupId(1), 7 * DAY, 1, 2, 0, '0x', title, 0));
  return c.vote.pollCount();
};

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 4, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, clerk] = await Promise.all([0, 1].map((i) => provider.getSigner(i)));
  ({ contracts: c } = await deployAll(admin, {}));
  await send(c.identity.setIssuer(clerk.address, 1, true, 'Clerk'));
  for (const [i, p] of people.entries()) await send(c.identity.connect(clerk).enroll(p.commitment, 1, ethers.id(`doc-v${i}`), 0));
  // The published test proof: an ordinary ballot from any poll.
  const pollId = await openPoll('Test proof');
  testProof = await buildBallot({ provider, vote: c.vote, pollId, identity: people[0], option: 1 });
  nextVerifier = await deploy(admin, 'SemaphoreVerifier', {});
});

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('only a checker that accepts the test proof and rejects a forged one can be installed', async () => {
  const fake = await (await admin.sendTransaction({ data: ACCEPT_ALL })).wait();
  assert.equal(await revertName(c.vote, c.vote.setVerifier.staticCall(fake.contractAddress, testProof)), 'VerifierFailedTest');
  const forged = { ...testProof, points: [...testProof.points] };
  forged.points[0] = 1n;
  assert.equal(await revertName(c.vote, c.vote.setVerifier.staticCall(await nextVerifier.getAddress(), forged)), 'VerifierFailedTest');
  assert.equal(await revertName(c.vote, c.vote.setVerifier.staticCall(ethers.ZeroAddress, testProof)), 'ZeroAddress');
  // Only the council (the admin role) may switch it.
  assert.equal(await revertName(c.vote, c.vote.connect(clerk).setVerifier.staticCall(await nextVerifier.getAddress(), testProof)), 'AccessControlUnauthorizedAccount');
});

test('a switch applies to polls opened afterwards; open polls keep the checker they opened with', async () => {
  const oldVerifier = await c.vote.verifier();
  const before = await openPoll('Opened before the switch');
  const r = await send(c.vote.setVerifier(await nextVerifier.getAddress(), testProof));
  assert.ok(r.logs.some((l) => c.vote.interface.parseLog(l)?.name === 'VerifierSet'));
  assert.equal(await c.vote.verifier(), await nextVerifier.getAddress());
  const afterId = await openPoll('Opened after the switch');
  assert.equal(await c.vote.verifierOf(before), oldVerifier);
  assert.equal(await c.vote.verifierOf(afterId), await nextVerifier.getAddress());
  // Both polls still take real ballots and refuse forged ones.
  for (const id of [before, afterId]) {
    const b = await buildBallot({ provider, vote: c.vote, pollId: id, identity: people[1], option: 0 });
    const bad = { ...b, points: [...b.points] };
    bad.points[3] = 7n;
    assert.equal(await revertName(c.vote, c.vote.castBallot.staticCall(id, bad)), 'InvalidProof');
    await send(c.vote.castBallot(id, b));
  }
});

test('budget rounds switch the same way, with the same test proof', async () => {
  const fake = await (await admin.sendTransaction({ data: ACCEPT_ALL })).wait();
  assert.equal(await revertName(c.budget, c.budget.setVerifier.staticCall(fake.contractAddress, testProof)), 'VerifierFailedTest');
  await send(c.budget.setVerifier(await nextVerifier.getAddress(), testProof));
  assert.equal(await c.budget.verifier(), await nextVerifier.getAddress());
  await send(c.budget.createRound(await c.identity.groupId(1), 7 * DAY, 9, 1000, 'Round', ['A', 'B'], [500, 500]));
  assert.equal(await c.budget.verifierOf(await c.budget.roundCount()), await nextVerifier.getAddress());
});
