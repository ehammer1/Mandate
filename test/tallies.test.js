// Paper ballots, in-person votes and official election results: two clerks, corrections that
// keep their history, totals of confirmed counts only, and anonymous check-ins that make the
// paper register match the voter list (one person, one vote, online or on paper).
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Identity } = require('@semaphore-protocol/identity');
const { deployAll } = require('../scripts/deploy');
const { buildBallot } = require('../client/ballot');
const { checkInProof } = require('../client/checkin');

process.env.SEMAPHORE_ARTIFACTS_DIR = path.dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json'));
let c, provider, admin, clerk2, outsider;
const voters = Array.from({ length: 3 }, (_, i) => new Identity(`paper-voter-${i}`));
const send = async (p) => (await p).wait();
const errName = async (p) => {
  try {
    await p;
  } catch (e) {
    for (const k of [c.tallies, c.vote]) {
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
const entry = (place, counts, ballots, o = {}) => ({ place, counts, ballots, ref: o.ref || '', replaces: o.replaces || 0, reason: o.reason || '' });
const eventArg = (rc, ev) => c.tallies.interface.parseLog(rc.logs.find((l) => l.topics[0] === c.tallies.interface.getEvent(ev).topicHash)).args;
const addPlace = async (contest, name) => Number(eventArg(await send(c.tallies.addPlace(contest, name)), 'PlaceAdded').place);

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, clerk2, outsider] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  ({ contracts: c } = await deployAll(admin, { rules: { MIN_POLL_MINUTES: 10, BINDING_QUORUM_PCT: 0 } }));
  await send(c.tallies.grantRole(await c.tallies.CLERK_ROLE(), clerk2.address));
  await send(c.identity.setIssuer(admin.address, 1, true, 'Clerk'));
  const longAgo = (await provider.getBlock('latest')).timestamp - 3 * 365 * 86_400;
  for (const [i, v] of voters.entries()) await send(c.identity.enroll(v.commitment, 1, ethers.id(`paper-doc-${i}`), longAgo));
});
after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('official election results by place: two clerks; a correction replaces a tally and keeps the history', async () => {
  assert.equal(await errName(c.tallies.connect(outsider).createContest.staticCall(2, 'nb:0x' + '2'.repeat(64), 3)), 'AccessControlUnauthorizedAccount');
  const contest = eventArg(await send(c.tallies.createContest(2, 'nb:0x' + '2'.repeat(64), 3)), 'ContestCreated').contestId;
  const [p1, p2] = [await addPlace(contest, 'Precinct 1'), await addPlace(contest, 'Precinct 2')];
  assert.equal(await errName(c.tallies.record.staticCall(contest, entry(p1, [300, 250, 20], 500))), 'BadInput'); // more choices than ballots
  assert.equal(await errName(c.tallies.record.staticCall(contest, entry(9, [1, 1, 0], 2))), 'BadInput'); // no such place
  const t1 = eventArg(await send(c.tallies.record(contest, entry(p1, [300, 250, 20], 590))), 'TallyRecorded').tallyId;
  const t2 = eventArg(await send(c.tallies.record(contest, entry(p2, [100, 180, 10], 300))), 'TallyRecorded').tallyId;
  let [counts, ballots, places, unconfirmed] = await c.tallies.totals(contest);
  assert.deepEqual([counts.map(Number), Number(places), Number(unconfirmed)], [[0, 0, 0], 0, 2]); // nothing counts unconfirmed
  assert.equal(await errName(c.tallies.confirm.staticCall(t1)), 'SameClerk'); // two-person rule
  for (const t of [t1, t2]) await send(c.tallies.connect(clerk2).confirm(t));

  assert.equal(await errName(c.tallies.record.staticCall(contest, entry(p2, [110, 170, 10], 300, { replaces: t2 }))), 'BadInput'); // a correction says why
  const fix = eventArg(await send(c.tallies.connect(clerk2).record(contest, entry(p2, [110, 170, 10], 300, { replaces: t2, reason: 'Candidate rows swapped when typing the sheet' }))), 'TallyRecorded').tallyId;
  assert.equal((await c.tallies.getTally(t2)).replacedBy, fix);
  await send(c.tallies.confirm(fix));
  [counts, ballots] = await c.tallies.totals(contest);
  assert.deepEqual([counts.map(Number), Number(ballots)], [[410, 420, 30], 890]);
  assert.equal((await c.tallies.talliesOf(contest)).length, 3); // the corrected tally stays on the record
  await send(c.tallies.closeContest(contest));
  assert.equal(await errName(c.tallies.record.staticCall(contest, entry(p1, [1, 1, 0], 2))), 'Closed');
});

test('paper ballots for a poll: anonymous check-in matches the voter list; one person, one vote', async () => {
  await send(c.vote.createPoll(await c.identity.groupId(2), 86_400, 1, 2, 0, '0x', 'Repave Elm Street?', 0));
  const pollId = await c.vote.pollCount();
  const contest = eventArg(await send(c.tallies.contestForPoll(pollId, 2)), 'ContestCreated').contestId;
  const library = await addPlace(contest, 'Main Library');
  const proof = (v, place) => checkInProof({ provider, identityAddress: cfg.identity, voteAddress: cfg.vote, identity: v, pollId, place });
  const cfg = { identity: await c.identity.getAddress(), vote: await c.vote.getAddress() };

  // Two voters check in at the library and vote on paper; a stranger's made-up check-in fails.
  const p0 = await proof(voters[0], library);
  await send(c.tallies.connect(outsider).checkIn(pollId, library, p0)); // anyone (a relayer) can submit it
  assert.equal(await errName(c.tallies.checkIn.staticCall(pollId, library, p0)), 'AlreadyCheckedIn');
  assert.equal(await errName(c.tallies.checkIn.staticCall(pollId, library, { ...p0, message: 5n })), 'BadProof'); // bound to its place
  await send(c.tallies.checkIn(pollId, library, await proof(voters[1], library)));
  assert.equal(Number(await c.tallies.checkIns(contest, library)), 2);

  // Paper ballots can never exceed check-ins at that place.
  assert.equal(await errName(c.tallies.record.staticCall(contest, entry(library, [2, 1], 3))), 'MoreBallotsThanCheckIns');
  const t = eventArg(await send(c.tallies.record(contest, entry(library, [1, 1], 2))), 'TallyRecorded').tallyId;
  await send(c.tallies.connect(clerk2).confirm(t));

  // Voter 0 also tries to vote online: the ballot's one-time code is the check-in's, so the
  // system knows it is the same person and counts only the paper ballot.
  await send(c.vote.castBallot(pollId, await buildBallot({ provider, vote: c.vote, pollId, identity: voters[0], option: 0 })));
  await send(c.vote.castBallot(pollId, await buildBallot({ provider, vote: c.vote, pollId, identity: voters[2], option: 0 })));
  const checked = new Set((await c.tallies.checkInsOf(pollId)).map(String));
  const online = (await c.vote.queryFilter(c.vote.filters.BallotCast(pollId))).map((e) => ({ option: Number(e.args.option), nullifier: String(e.args.nullifier) }));
  const counted = online.filter((b) => !checked.has(b.nullifier));
  assert.equal(online.length, 2);
  assert.deepEqual(counted.map((b) => b.option), [0]); // voter 2 only; voter 0's online ballot is dropped
  const [paper] = await c.tallies.totals(contest);
  assert.deepEqual([counted.filter((b) => b.option === 0).length + Number(paper[0]), counted.filter((b) => b.option === 1).length + Number(paper[1])], [2, 1]); // 3 people, 3 votes

  // After the poll closes, nobody can check in.
  await provider.send('evm_increaseTime', [86_401]);
  await provider.send('evm_mine', []);
  assert.equal(await errName(c.tallies.checkIn.staticCall(pollId, library, await proof(voters[2], library))), 'NotOpen');
});
