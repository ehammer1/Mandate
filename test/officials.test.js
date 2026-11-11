// Officials in public, anonymous delegation to public delegates, and "ratify or it lapses"
// for emergency measures and emergency council changes (real proofs).
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
let provider, admin, alice, mayor, delegateAcct, quiet, verifierToBe, c;
const residents = Array.from({ length: 6 }, (_, i) => new Identity(`off-resident-${i}`));
const send = async (p) => (await p).wait();
const warp = async (s) => {
  await provider.send('evm_increaseTime', [s]);
  await provider.send('evm_mine', []);
};
const errName = async (p) => {
  try {
    await p;
  } catch (e) {
    for (const k of [c.vote, c.officials, c.council]) {
      try {
        const n = k.interface.parseError(e.data)?.name;
        if (n) return n;
      } catch {
        /* next */
      }
    }
    return e.revert?.name || e.shortMessage;
  }
  return 'no revert';
};
const ballot = (pollId, identity, option) => buildBallot({ provider, vote: c.vote, pollId, identity, option });

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 8, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, alice, mayor, delegateAcct, quiet, verifierToBe] = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => provider.getSigner(i)));
  ({ contracts: c } = await deployAll(admin, { rules: { MIN_POLL_MINUTES: 10, BINDING_QUORUM_PCT: 0 }, council: { members: [admin.address, alice.address], threshold: 2, delaySeconds: 3600, ratifyDays: 3 } }));
  // Founding setup through the council: a clerk enrolls residents.
  const id = (rc) => c.council.interface.parseLog(rc.logs.find((l) => l.topics[0] === c.council.interface.getEvent('Proposed').topicHash)).args.id;
  const p = id(await send(c.council.propose(await c.identity.getAddress(), 0, c.identity.interface.encodeFunctionData('setIssuer', [admin.address, 1, true, 'Clerk']), 'setup')));
  await send(c.council.connect(alice).approve(p));
  await warp(3601);
  await send(c.council.execute(p));
  const longAgo = (await provider.getBlock('latest')).timestamp - 3 * 365 * DAY;
  for (const [i, r] of residents.entries()) await send(c.identity.enroll(r.commitment, 1, ethers.id(`off-doc-${i}`), longAgo));
});

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('officials in public: registered with office and term, positions on the record', async () => {
  const term = (await provider.getBlock('latest')).timestamp + 365 * DAY;
  await send(c.officials.register(mayor.address, 'Jane Doe', 'Mayor', 'Example City', term));
  assert.equal(await errName(c.officials.connect(quiet).register.staticCall(quiet.address, 'Nobody', 'King', 'X', 0)), 'AccessControlUnauthorizedAccount');
  const mayorId = await c.officials.idOf(mayor.address);
  const o = await c.officials.getOfficial(mayorId);
  assert.deepEqual([o.name, o.office, o.official, o.active], ['Jane Doe', 'Mayor', true, true]);

  await send(c.vote.createPoll(await c.identity.groupId(2), DAY, 1, 2, 0, '0x', 'q', 0));
  const pollId = await c.vote.pollCount();
  await send(c.officials.connect(mayor).recordPosition(pollId, 0, 'nb:0x' + '1'.repeat(64)));
  assert.equal((await c.officials.getPosition(pollId, mayorId)).position, 0n);
  assert.equal(await errName(c.officials.connect(quiet).recordPosition.staticCall(pollId, 0, '')), 'NotRegistered');
});

test('anonymous delegation: delegated votes count the way the delegate publicly stated before the close', async () => {
  await send(c.officials.connect(delegateAcct).registerDelegate('Pat Delegate', 'nb:0x' + '2'.repeat(64)));
  await send(c.officials.connect(quiet).registerDelegate('Quiet Delegate', ''));
  const d = await c.officials.idOf(delegateAcct.address);
  const q = await c.officials.idOf(quiet.address);
  const BASE = await c.vote.DELEGATE_BASE();
  await send(c.vote.createPoll(await c.identity.groupId(2), DAY, 1, 2, 0, '0x', 'Build the bike lane?', 0));
  const pollId = await c.vote.pollCount();

  for (const r of residents.slice(0, 3)) await send(c.vote.castBallot(pollId, await ballot(pollId, r, BASE + d)));
  await send(c.vote.castBallot(pollId, await ballot(pollId, residents[3], BASE + q))); // a delegate who never says
  for (const r of residents.slice(4, 6)) await send(c.vote.castBallot(pollId, await ballot(pollId, r, 1)));
  // A delegator can't be counted twice: the same choice again is refused (a different one would replace it).
  assert.equal(await errName(c.vote.castBallot.staticCall(pollId, await ballot(pollId, residents[0], BASE + d))), 'NullifierUsed');
  assert.equal(await errName(c.vote.castBallot.staticCall(pollId, await ballot(pollId, residents[5], BASE + 999n))), 'NotADelegate');
  const [ids, counts] = await c.vote.delegatedVotes(pollId);
  assert.deepEqual([ids.map(Number), counts.map(Number)], [[Number(d), Number(q)], [3, 1]]);

  await send(c.officials.connect(delegateAcct).recordPosition(pollId, 0, 'nb:0x' + '3'.repeat(64))); // states Yes, publicly
  await warp(DAY + 1);
  await send(c.officials.connect(quiet).recordPosition(pollId, 0, '')); // too late: doesn't count
  await send(c.vote.finalize(pollId));
  assert.deepEqual((await c.vote.tally(pollId)).map(Number), [3, 2]); // 3 delegated Yes, 2 direct No; the quiet delegate's 1 is not counted
  assert.equal((await c.vote.getPoll(pollId)).passed, true);
});

test('ratify or it lapses: an emergency measure stands only if residents ratify it in time', async () => {
  const full = await c.identity.groupId(2);
  assert.equal(await errName(c.officials.connect(delegateAcct).declareEmergency.staticCall('nb:0x' + '4'.repeat(64), DAY)), 'NotAnOfficial');
  await send(c.officials.connect(mayor).declareEmergency('nb:0x' + '4'.repeat(64), DAY)); // e.g. a curfew
  await send(c.officials.connect(mayor).declareEmergency('nb:0x' + '5'.repeat(64), DAY)); // e.g. emergency repairs
  const [m1] = await c.officials.getMeasure(1);
  const [m2] = await c.officials.getMeasure(2);
  assert.equal((await c.officials.getMeasure(1))[1], 1n); // awaiting ratification
  for (const r of residents.slice(0, 3)) await send(c.vote.castBallot(m2.pollId, await ballot(m2.pollId, r, 0)));
  await warp(DAY + 1);
  await send(c.vote.finalize(m1.pollId));
  await send(c.vote.finalize(m2.pollId));
  assert.equal((await c.officials.getMeasure(1))[1], 4n); // Lapsed: nobody ratified it
  assert.equal((await c.officials.getMeasure(2))[1], 3n); // Ratified
  void full;
});

test('emergency council change: runs at once, opens a ratification vote, undone if not ratified', async () => {
  const VERIFIER = await c.registry.VERIFIER_ROLE();
  const reg = await c.registry.getAddress();
  const grant = c.registry.interface.encodeFunctionData('grantRole', [VERIFIER, verifierToBe.address]);
  const undo = c.registry.interface.encodeFunctionData('revokeRole', [VERIFIER, verifierToBe.address]);
  assert.equal(await errName(c.council.proposeEmergency.staticCall(await c.council.getAddress(), '0x', reg, undo, 'x')), 'BadMember'); // not on itself
  const rc = await send(c.council.proposeEmergency(reg, grant, reg, undo, 'nb:0x' + '6'.repeat(64)));
  const id = c.council.interface.parseLog(rc.logs.find((l) => l.topics[0] === c.council.interface.getEvent('Proposed').topicHash)).args.id;
  await send(c.council.connect(alice).approve(id));
  await send(c.council.execute(id)); // no public wait
  assert.equal(await c.registry.hasRole(VERIFIER, verifierToBe.address), true);
  const [p] = await c.council.proposal(id);
  assert.ok(p.ratifyPoll > 0n);
  assert.equal(await errName(c.council.lapse.staticCall(id)), 'RatificationPending');
  await warp(3 * DAY + 1);
  await send(c.council.lapse(id)); // anyone can undo it once the window passed unratified
  assert.equal(await c.registry.hasRole(VERIFIER, verifierToBe.address), false);
  assert.equal(await errName(c.council.lapse.staticCall(id)), 'NotEmergency'); // only once

  // Ratified: it stays.
  const rc2 = await send(c.council.proposeEmergency(reg, grant, reg, undo, 'nb:0x' + '7'.repeat(64)));
  const id2 = c.council.interface.parseLog(rc2.logs.find((l) => l.topics[0] === c.council.interface.getEvent('Proposed').topicHash)).args.id;
  await send(c.council.connect(alice).approve(id2));
  await send(c.council.execute(id2));
  const [p2] = await c.council.proposal(id2);
  for (const r of residents.slice(0, 3)) await send(c.vote.castBallot(p2.ratifyPoll, await ballot(p2.ratifyPoll, r, 0)));
  await warp(3 * DAY + 1);
  await send(c.vote.finalize(p2.ratifyPoll));
  assert.equal(await errName(c.council.lapse.staticCall(id2)), 'AlreadyRatified');
  assert.equal(await c.registry.hasRole(VERIFIER, verifierToBe.address), true);
});
