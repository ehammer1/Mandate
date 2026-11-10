// Charter: the community's voting rules, enforced by the voting contract and changed only by vote.
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
const DAY = 86_400;
const MIN = 60;
let provider, admin, clerk, online, c;
const residents = Array.from({ length: 7 }, (_, i) => new Identity(`charter-resident-${i}`));
const signups = Array.from({ length: 3 }, (_, i) => new Identity(`charter-online-${i}`));
const send = async (p) => (await p).wait();
const rule = (name) => c.charter.rule(ethers.id(name));
const coder = ethers.AbiCoder.defaultAbiCoder();
const revertName = async (p) => {
  try {
    await p;
  } catch (e) {
    for (const k of [c.vote, c.charter]) {
      try {
        const name = k.interface.parseError(e.data)?.name;
        if (name) return name;
      } catch {
        /* next */
      }
    }
    return e.revert?.name || e.shortMessage;
  }
  return 'no revert';
};
const vote = async (pollId, voters, option) => {
  for (const v of voters) await send(c.vote.castBallot(pollId, await buildBallot({ provider, vote: c.vote, pollId, identity: v, option })));
};
const warp = async (s) => {
  await provider.send('evm_increaseTime', [s]);
  await provider.send('evm_mine', []);
};

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 4, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, clerk, online] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  ({ contracts: c } = await deployAll(admin, {})); // the default rules
  await send(c.identity.setIssuer(clerk.address, 1, true, 'Clerk'));
  await send(c.identity.setIssuer(online.address, 0, true, 'Online sign-up'));
  const longAgo = (await provider.getBlock('latest')).timestamp - 3 * 365 * DAY;
  for (const [i, r] of residents.entries()) await send(c.identity.connect(clerk).enroll(r.commitment, 1, ethers.id(`doc-${i}`), longAgo));
  for (const [i, s] of signups.entries()) await send(c.identity.connect(online).enroll(s.commitment, 0, ethers.id(`acct-${i}`), 0));
});

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('rules are enforced when a poll opens', async () => {
  const [all, , full] = await Promise.all([0, 1, 2].map((t) => c.identity.groupId(t)));
  const mandate = coder.encode(['address', 'address', 'uint64', 'uint16', 'bytes32', 'string'], [await c.registry.getAddress(), admin.address, 30 * DAY, 1, ethers.id('x'), 'spec']);
  assert.equal(await rule('MIN_POLL_MINUTES'), 3n * 24n * 60n);
  // Voting time.
  assert.equal(await revertName(c.vote.createPoll.staticCall(full, 2 * DAY, 1, 2, 0, '0x', 'q', 0)), 'PollTooShort');
  // Binding polls: at least 10% turnout of the 10 eligible = 1 ... and the wider list must be cross-checked.
  assert.equal(await revertName(c.vote.createPoll.staticCall(all, 3 * DAY, 1, 2, 2, mandate, 'q', 0)), 'CrossCheckRequired');
  assert.equal(await revertName(c.vote.createCheckedPoll.staticCall(all, full, 2, 3 * DAY, 1, 2, mandate, 'q', 0)), 'CheckTooSmall');
  assert.equal(await revertName(c.vote.createCheckedPoll.staticCall(all, full, 3, 3 * DAY, 0 + 1, 2, mandate, 'q', 0)), 'no revert');
  // Rule changes: long enough, full-rights voters only, and within the rule's limits.
  const toWeight = (v) => coder.encode(['bytes32', 'uint256'], [ethers.id('VERIFIED_WEIGHT_PCT'), v]);
  assert.equal(await revertName(c.vote.createPoll.staticCall(full, 3 * DAY, 1, 2, 4, toWeight(200), 'q', 0)), 'PollTooShort');
  assert.equal(await revertName(c.vote.createPoll.staticCall(await c.identity.groupId(1), 14 * DAY, 1, 2, 4, toWeight(200), 'q', 0)), 'RuleVotersNotEligible');
  assert.equal(await revertName(c.vote.createPoll.staticCall(full, 14 * DAY, 1, 2, 4, toWeight(5000), 'q', 0)), 'OutOfBounds'); // max 3x
  assert.equal(await revertName(c.vote.createPoll.staticCall(full, 14 * DAY, 1, 2, 4, coder.encode(['bytes32', 'uint256'], [ethers.id('NOPE'), 1]), 'q', 0)), 'UnknownRule');
  // Nobody sets a rule directly: not the deployer, not an admin.
  assert.equal(await revertName(c.charter.setRule.staticCall(ethers.id('MIN_POLL_MINUTES'), 10)), 'AccessControlUnauthorizedAccount');
});

test('changing a rule needs a public vote with a supermajority', async () => {
  const full = await c.identity.groupId(2);
  const data = coder.encode(['bytes32', 'uint256'], [ethers.id('VERIFIED_WEIGHT_PCT'), 200]);
  // 4 Yes, 3 No = 57%: more Yes than No, but short of the 60% supermajority.
  await send(c.vote.createPoll(full, 14 * DAY, 1, 2, 4, data, 'Make ID-checked votes count double?', 0));
  const first = await c.vote.pollCount();
  assert.equal(await c.vote.supermajorityPct(first), 60n);
  await vote(first, residents.slice(0, 4), 0);
  await vote(first, residents.slice(4, 7), 1);
  await warp(14 * DAY + 1);
  await send(c.vote.finalize(first));
  assert.equal((await c.vote.getPoll(first)).passed, false);
  assert.equal(await rule('VERIFIED_WEIGHT_PCT'), 100n);

  // 3 Yes, 2 No = 60%: passes, and the rule changes.
  await send(c.vote.createPoll(full, 14 * DAY, 1, 2, 4, data, 'Make ID-checked votes count double?', 0));
  const second = await c.vote.pollCount();
  await vote(second, residents.slice(0, 3), 0);
  await vote(second, residents.slice(3, 5), 1);
  await warp(14 * DAY + 1);
  await send(c.vote.finalize(second));
  assert.equal((await c.vote.getPoll(second)).passed, true);
  assert.equal(await rule('VERIFIED_WEIGHT_PCT'), 200n);
});

test('weighted cross-check: ID-checked votes count double, which can decide a close poll', async () => {
  const [all, , full] = await Promise.all([0, 1, 2].map((t) => c.identity.groupId(t)));
  const mandate = coder.encode(['address', 'address', 'uint64', 'uint16', 'bytes32', 'string'], [await c.registry.getAddress(), admin.address, 30 * DAY, 1, ethers.id('x'), 'spec']);
  await send(c.registry.grantRole(await c.registry.VERIFIER_ROLE(), admin.address));
  await send(c.vote.createCheckedPoll(all, full, 3, 3 * DAY + MIN, 2, 2, mandate, 'Close poll', 0));
  const id = await c.vote.pollCount();
  assert.equal((await c.vote.getCheck(id))[0].weightPct, 200n);
  await vote(id, signups, 0); // 3 online-only Yes
  await vote(id, residents.slice(0, 2), 1); // 2 ID-checked No, counting double
  assert.deepEqual((await c.vote.tally(id)).map(Number), [3, 2]); // a plain count would pass it
  await warp(3 * DAY + 2 * MIN);
  await send(c.vote.finalize(id));
  assert.equal((await c.vote.getPoll(id)).passed, false); // weighted: Yes 300 vs No 400
  assert.equal(await c.registry.mandateCount(), 0n);
});
