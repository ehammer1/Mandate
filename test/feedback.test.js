// Residents' voice between votes, and the public's power over officials (real proofs):
// comments, ratings, petitions that open their own polls, pausing and revising mandates,
// electing and recalling council members, removing power, and poll time limits.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Identity } = require('@semaphore-protocol/identity');
const { deployAll } = require('../scripts/deploy');
const { buildBallot } = require('../client/ballot');
const { commentProof, ratingProof, signatureProof, topicOf } = require('../client/feedback');

process.env.SEMAPHORE_ARTIFACTS_DIR = path.dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json'));
const DAY = 86_400;
const A = { PauseMandate: 5, ReviseMandate: 6, Elect: 7, Recall: 8, RemovePower: 9 };
let provider, admin, clerk, alice, bob, worker, newWorker, candidate, c;
const residents = Array.from({ length: 6 }, (_, i) => new Identity(`fb-resident-${i}`));
const outsider = new Identity('fb-outsider');
const coder = ethers.AbiCoder.defaultAbiCoder();
const send = async (p) => (await p).wait();
const warp = async (s) => {
  await provider.send('evm_increaseTime', [s]);
  await provider.send('evm_mine', []);
};
const errName = async (p) => {
  try {
    await p;
  } catch (e) {
    for (const k of [c.feedback, c.vote, c.council, c.registry]) {
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
/** Everyone in `yes` votes Yes, then the poll is closed; returns whether it passed. */
async function decide(pollId, yes, waitSeconds) {
  for (const r of yes) await send(c.vote.castBallot(pollId, await buildBallot({ provider, vote: c.vote, pollId, identity: r, option: 0 })));
  await warp(waitSeconds + 1);
  await send(c.vote.finalize(pollId));
  return (await c.vote.getPoll(pollId)).passed;
}

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 9, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, clerk, alice, bob, worker, newWorker, candidate] = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((i) => provider.getSigner(i)));
  ({ contracts: c } = await deployAll(admin, {
    rules: { MIN_POLL_MINUTES: 10, PETITION_POLL_MINUTES: 10, BINDING_QUORUM_PCT: 0 },
    council: { members: [admin.address, alice.address, bob.address], threshold: 2, delaySeconds: 3600, termDays: 365 },
  }));
  // Founding setup through the council: a clerk and a verifier.
  const propose = async (target, data) => {
    const rc = await send(c.council.propose(target, 0, data, 'setup'));
    const id = c.council.interface.parseLog(rc.logs.find((l) => l.topics[0] === c.council.interface.getEvent('Proposed').topicHash)).args.id;
    await send(c.council.connect(alice).approve(id));
    return id;
  };
  const a = await propose(await c.identity.getAddress(), c.identity.interface.encodeFunctionData('setIssuer', [clerk.address, 1, true, 'Clerk']));
  const b = await propose(await c.registry.getAddress(), c.registry.interface.encodeFunctionData('grantRole', [await c.registry.VERIFIER_ROLE(), clerk.address]));
  await warp(3601);
  await send(c.council.execute(a));
  await send(c.council.execute(b));
  const longAgo = (await provider.getBlock('latest')).timestamp - 3 * 365 * DAY;
  for (const [i, r] of residents.entries()) await send(c.identity.connect(clerk).enroll(r.commitment, 1, ethers.id(`fb-doc-${i}`), longAgo));
});

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('comments and ratings: anonymous but verified, ratings once per person', async () => {
  const topic = topicOf('mandate', 1);
  const ref = 'nb:0x' + 'a'.repeat(64);
  const proof = await commentProof({ provider, feedback: c.feedback, identity: residents[0], tier: 2, topic, ref });
  await send(c.feedback.comment(topic, 2, ref, proof));
  const [first] = await c.feedback.comments(topic, 0, 10);
  assert.deepEqual([first.ref, Number(first.tier), await c.feedback.commentCount(topic)], [ref, 2, 1n]);
  assert.equal(await errName(c.feedback.comment.staticCall(topic, 2, ref, proof)), 'NullifierUsed');
  assert.equal(await errName(c.feedback.comment.staticCall(topic, 2, 'nb:0x' + 'b'.repeat(64), proof)), 'WrongScope'); // can't reuse for other text
  await assert.rejects(commentProof({ provider, feedback: c.feedback, identity: outsider, tier: 0, topic, ref }), /not on this voter list/);

  for (const [i, score] of [[0, 4], [1, 2]]) await send(c.feedback.rate(topic, 2, score, await ratingProof({ provider, feedback: c.feedback, identity: residents[i], tier: 2, topic, score })));
  assert.equal(await errName(c.feedback.rate.staticCall(topic, 2, 5, await ratingProof({ provider, feedback: c.feedback, identity: residents[0], tier: 2, topic, score: 5 }))), 'NullifierUsed');
  assert.deepEqual([await c.feedback.ratingSum(topic), await c.feedback.ratingCount(topic)], [6n, 2n]);
});

test('a petition opens its own poll; the public pauses a mandate, then revises it with a new responsible party', async () => {
  const now = (await provider.getBlock('latest')).timestamp;
  const full = await c.identity.groupId(2);
  // A mandate created by a public vote.
  const create = coder.encode(['address', 'address', 'uint64', 'uint16', 'bytes32', 'string'], [await c.registry.getAddress(), worker.address, 30 * DAY, 1, ethers.id('streets'), 'nb:0x' + 'c'.repeat(64)]);
  await send(c.vote.createPoll(full, 10 * 60, 1, 2, 2, create, 'q', 0));
  assert.equal(await decide(await c.vote.pollCount(), residents.slice(0, 3), 10 * 60), true);
  assert.equal((await c.registry.getMandate(1)).status, 1n);

  // "This isn't working": a petition to pause it. 5% of 6 residents rounds up to 1 signature.
  const pause = coder.encode(['address', 'uint256', 'string'], [await c.registry.getAddress(), 1, 'nb:0x' + 'd'.repeat(64)]);
  assert.equal(await errName(c.feedback.createPetition.staticCall(0, A.PauseMandate, pause, 'nb:0x1')), 'BindingNeedsIdChecked');
  await send(c.feedback.connect(worker).createPetition(2, A.PauseMandate, pause, 'nb:0x' + 'd'.repeat(64)));
  const pid = await c.feedback.petitionCount();
  const before = await c.vote.pollCount();
  await send(c.feedback.sign(pid, await signatureProof({ provider, feedback: c.feedback, identity: residents[1], tier: 2, petitionId: pid })));
  const p = await c.feedback.getPetition(pid);
  assert.equal(p.pollId, before + 1n); // opened by itself, no official involved
  assert.equal(await decide(p.pollId, residents.slice(0, 4), 10 * 60), true);
  const paused = await c.registry.getMandate(1);
  assert.equal(paused.status, 5n); // Paused: the deadline clock stops
  assert.equal(await c.registry.isOverdue(1), false);

  // Revise: a new responsible party (a recall of the old one) and 15 more days.
  const revise = coder.encode(['address', 'uint256', 'address', 'uint64', 'uint16', 'string', 'string'], [await c.registry.getAddress(), 1, newWorker.address, 15 * DAY, 0, '', 'nb:0x' + 'e'.repeat(64)]);
  await send(c.vote.createPoll(full, 10 * 60, 1, 2, A.ReviseMandate, revise, 'q', 0));
  assert.equal(await decide(await c.vote.pollCount(), residents.slice(0, 3), 10 * 60), true);
  const m = await c.registry.getMandate(1);
  assert.equal(m.status, 1n);
  assert.equal(m.responsible, newWorker.address);
  assert.ok(Number(m.deadline) > now + 30 * DAY + 15 * DAY); // the paused time was given back too
});

test('the public elects and recalls council members, and removes power, without the council', async () => {
  const full = await c.identity.groupId(2);
  const council = await c.council.getAddress();
  const elect = coder.encode(['address', 'address', 'uint64'], [council, candidate.address, 365 * DAY]);
  await send(c.vote.createPoll(full, 10 * 60, 1, 2, A.Elect, elect, 'Elect the candidate for a year?', 0));
  assert.equal(await decide(await c.vote.pollCount(), residents.slice(0, 3), 10 * 60), true);
  assert.equal(await c.council.isMember(candidate.address), true);
  assert.ok((await c.council.termEnds(candidate.address)) > 0n);

  const recall = coder.encode(['address', 'address'], [council, bob.address]);
  await send(c.vote.createPoll(full, 10 * 60, 1, 2, A.Recall, recall, 'Recall Bob?', 0));
  assert.equal(await decide(await c.vote.pollCount(), residents.slice(0, 3), 10 * 60), true);
  assert.equal(await c.council.isMember(bob.address), false);

  // Remove a verifier's role by public vote (taking power away works; granting it would not).
  const revoke = c.registry.interface.encodeFunctionData('revokeRole', [await c.registry.VERIFIER_ROLE(), clerk.address]);
  await send(c.vote.createPoll(full, 10 * 60, 1, 2, A.RemovePower, coder.encode(['address', 'address', 'bytes'], [council, await c.registry.getAddress(), revoke]), 'Remove the verifier?', 0));
  assert.equal(await decide(await c.vote.pollCount(), residents.slice(0, 3), 10 * 60), true);
  assert.equal(await c.registry.hasRole(await c.registry.VERIFIER_ROLE(), clerk.address), false);
  const grant = c.registry.interface.encodeFunctionData('grantRole', [await c.registry.VERIFIER_ROLE(), worker.address]);
  assert.equal(await errName(c.council.connect(admin).removePowerByVote.staticCall(await c.registry.getAddress(), grant)), 'OnlyElectorate');
});

test('terms end on time, polls have a maximum length', async () => {
  assert.equal(await errName(c.vote.createPoll.staticCall(await c.identity.groupId(2), 31 * DAY, 1, 2, 0, '0x', 'q', 0)), 'PollTooLong');
  // After a year the founding terms end: their approvals stop counting; the elected member serves on.
  await warp(366 * DAY);
  assert.equal(await c.council.isMember(admin.address), false);
  assert.equal(await c.council.isMember(candidate.address), false); // elected for a year, too
  assert.equal(await c.council.activeMemberCount(), 0n);
  assert.equal(await errName(c.council.connect(alice).propose.staticCall(await c.council.getAddress(), 0, '0x', 'x')), 'NotMember');
});
