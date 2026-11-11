// Changing your vote: the same voter key gives the same one-time code, so a new ballot
// replaces the earlier one until the poll closes; only the latest counts (resists pressure and
// vote-buying). Works for direct, delegated and cross-checked ballots.
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
let c, provider, admin, delegate;
const people = Array.from({ length: 3 }, (_, i) => new Identity(`revoter-${i}`));
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

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, delegate] = await Promise.all([0, 1].map((i) => provider.getSigner(i)));
  ({ contracts: c } = await deployAll(admin, { rules: { MIN_POLL_MINUTES: 10, BINDING_QUORUM_PCT: 0 } }));
  await send(c.identity.setIssuer(admin.address, 1, true, 'Clerk'));
  const longAgo = (await provider.getBlock('latest')).timestamp - 3 * 365 * 86_400;
  for (const [i, p] of people.entries()) await send(c.identity.enroll(p.commitment, 1, ethers.id(`revote-doc-${i}`), longAgo));
});
after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('a voter changes their vote; only the latest counts', async () => {
  await send(c.vote.createPoll(await c.identity.groupId(2), 86_400, 1, 2, 0, '0x', 'Close Elm Street to cars on Sundays?', 0));
  const id = await c.vote.pollCount();
  await send(c.vote.castBallot(id, await ballot(id, people[0], 0)));
  await send(c.vote.castBallot(id, await ballot(id, people[1], 0)));
  assert.deepEqual((await c.vote.tally(id)).map(Number), [2, 0]);

  // Person 0 was pressured into Yes; later, privately, they change it to No.
  const rc = await send(c.vote.castBallot(id, await ballot(id, people[0], 1)));
  const changed = rc.logs.map((l) => { try { return c.vote.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'BallotChanged');
  assert.deepEqual([Number(changed.args.previous), Number(changed.args.option)], [0, 1]);
  assert.deepEqual((await c.vote.tally(id)).map(Number), [1, 1]); // still 2 people, 2 votes
  assert.equal(await errName(c.vote.castBallot.staticCall(id, await ballot(id, people[0], 1))), 'NullifierUsed'); // the same choice again changes nothing

  // Hand the vote to a delegate, then take it back.
  await send(c.officials.connect(delegate).registerDelegate('Pat Delegate', ''));
  const d = await c.officials.idOf(delegate.address);
  const BASE = await c.vote.DELEGATE_BASE();
  await send(c.vote.castBallot(id, await ballot(id, people[2], BASE + d)));
  let [ids, counts] = await c.vote.delegatedVotes(id);
  assert.deepEqual([ids.map(Number), counts.map(Number)], [[Number(d)], [1]]);
  await send(c.vote.castBallot(id, await ballot(id, people[2], 0)));
  [ids, counts] = await c.vote.delegatedVotes(id);
  assert.deepEqual(counts.map(Number), [0]);
  assert.deepEqual((await c.vote.tally(id)).map(Number), [2, 1]);

  // Once the poll closes, votes are final.
  await provider.send('evm_increaseTime', [86_401]);
  await provider.send('evm_mine', []);
  assert.equal(await errName(c.vote.castBallot.staticCall(id, await ballot(id, people[1], 1))), 'NotOpen');
  await send(c.vote.finalize(id));
  assert.deepEqual((await c.vote.tally(id)).map(Number), [2, 1]);
  assert.equal((await c.vote.getPoll(id)).passed, true);
});
