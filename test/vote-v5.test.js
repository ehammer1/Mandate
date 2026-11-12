// Poll settings chosen by each community: until when votes can change, online/paper/both,
// ranked choices (instant runoff from the public counts), and polls for a smaller voter list
// (a district or ward) that is a subset of the main list.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Identity } = require('@semaphore-protocol/identity');
const { Group } = require('@semaphore-protocol/group');
const { deployAll } = require('../scripts/deploy');
const { buildBallot, encodeRanking, decodeRanking, instantRunoff } = require('../client/ballot');

process.env.SEMAPHORE_ARTIFACTS_DIR = path.dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json'));
let c, provider, admin, clerk;
const people = Array.from({ length: 5 }, (_, i) => new Identity(`v5-voter-${i}`));
const outsider = new Identity('v5-not-on-the-list');
const send = async (p) => (await p).wait();
const errName = async (p) => {
  try {
    await p;
  } catch (e) {
    for (const k of [c.vote, c.voterGroups]) {
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
const ballot = (pollId, who, option) => buildBallot({ provider, vote: c.vote, pollId, identity: who, option });
const settings = (o = {}) => ({ changeCutoff: 0, channels: 0, ranked: false, ...o });
const open = async (o = {}, poll = {}) => {
  await send(c.vote.createPollWith({ groupId: await c.identity.groupId(2), duration: 86_400, quorum: 1, options: 2, action: 0, actionData: '0x', questionCID: 'A question', bond: 0, ...poll, settings: settings(o) }));
  return c.vote.pollCount();
};
const later = async (secs) => {
  await provider.send('evm_increaseTime', [secs]);
  await provider.send('evm_mine', []);
};

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, clerk] = await Promise.all([0, 1].map((i) => provider.getSigner(i)));
  ({ contracts: c } = await deployAll(admin, { rules: { MIN_POLL_MINUTES: 10, BINDING_QUORUM_PCT: 0 } }));
  await send(c.identity.setIssuer(admin.address, 1, true, 'Clerk'));
  const longAgo = (await provider.getBlock('latest')).timestamp - 3 * 365 * 86_400;
  for (const [i, p] of people.entries()) await send(c.identity.enroll(p.commitment, 1, ethers.id(`v5-doc-${i}`), longAgo));
});
after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('change cutoff: votes can change until the cutoff; "no changes" makes the first vote final', async () => {
  const firm = await open({ changeCutoff: await c.vote.NO_CHANGES() });
  await send(c.vote.castBallot(firm, await ballot(firm, people[0], 0)));
  assert.equal(await errName(c.vote.castBallot.staticCall(firm, await ballot(firm, people[0], 1))), 'ChangesClosed');
  await send(c.vote.castBallot(firm, await ballot(firm, people[1], 1))); // first votes are still welcome

  const cutoff = await open({ changeCutoff: 3600 }); // changes allowed until 1 hour before the close
  await send(c.vote.castBallot(cutoff, await ballot(cutoff, people[0], 0)));
  await send(c.vote.castBallot(cutoff, await ballot(cutoff, people[0], 1)));
  assert.deepEqual((await c.vote.tally(cutoff)).map(Number), [0, 1]);
  await later(86_400 - 1800); // 30 minutes left
  assert.equal(await errName(c.vote.castBallot.staticCall(cutoff, await ballot(cutoff, people[0], 0))), 'ChangesClosed');
  await send(c.vote.castBallot(cutoff, await ballot(cutoff, people[2], 0))); // a first vote still counts
  assert.deepEqual((await c.vote.tally(cutoff)).map(Number), [1, 1]);
  const s = await c.vote.settingsOf(cutoff);
  assert.equal(Number(s.changeCutoff), 3600);
});

test('paper only: online ballots are refused (voters check in and vote at a polling place)', async () => {
  const id = await open({ channels: 2 });
  assert.equal(await errName(c.vote.castBallot.staticCall(id, await ballot(id, people[0], 0))), 'OnlineClosed');
  const online = await open({ channels: 1 });
  await send(c.vote.castBallot(online, await ballot(online, people[0], 0)));
  assert.equal(await errName(c.vote.createPollWith.staticCall({ groupId: await c.identity.groupId(2), duration: 86_400, quorum: 1, options: 2, action: 0, actionData: '0x', questionCID: 'Q', bond: 0, settings: settings({ channels: 3 }) })), 'InvalidParams');
});

test('ranked choice: voters rank the options; instant runoff from the public counts', async () => {
  assert.equal(encodeRanking([2, 0]), 0x13n);
  assert.deepEqual(decodeRanking(0x13n), [2, 0]);
  assert.equal(await errName(c.vote.createPollWith.staticCall({ groupId: await c.identity.groupId(2), duration: 86_400, quorum: 1, options: 2, action: 0, actionData: '0x', questionCID: 'Q', bond: 0, settings: settings({ ranked: true }) })), 'InvalidParams'); // needs 3+ choices
  const id = await open({ ranked: true }, { options: 3, questionCID: 'Which park project first?' });
  // A: 2 first choices, B: 2, C: 1 whose next choice is B -> C drops, B wins 3-2.
  const ranks = [[0, 1], [0], [1, 0], [1], [2, 1, 0]];
  for (const [i, r] of ranks.entries()) await send(c.vote.castBallot(id, await ballot(id, people[i], encodeRanking(r))));
  assert.deepEqual((await c.vote.tally(id)).map(Number), [2, 2, 1]); // first choices
  // Bad rankings are refused: repeated choice, a choice that doesn't exist, a gap.
  for (const bad of [0x11n, 0x4n, 0x102n]) assert.equal(await errName(c.vote.castBallot.staticCall(id, await ballot(id, outsiderOk(), bad))), 'BadRanking');
  let [codes, counts] = await c.vote.rankings(id);
  let r = instantRunoff(3, codes, counts);
  assert.equal(r.winner, 1);
  assert.deepEqual(r.rounds.map((x) => x.eliminated), [2, null]);
  // The C voter changes their ranking to put A second instead: now A wins.
  await send(c.vote.castBallot(id, await ballot(id, people[4], encodeRanking([2, 0]))));
  [codes, counts] = await c.vote.rankings(id);
  r = instantRunoff(3, codes, counts);
  assert.equal(r.winner, 0);
  assert.deepEqual((await c.vote.tally(id)).map(Number), [2, 2, 1]);
});
// Bad-ranking checks only need any eligible voter's proof: use one who has not voted in that poll.
let spare;
function outsiderOk() {
  spare ||= people[0];
  return spare;
}

test('a smaller voter list: a district group drawn from the main list, for advisory polls', async () => {
  await send(c.voterGroups.grantRole(await c.voterGroups.GROUP_CREATOR_ROLE(), admin.address));
  const rc = await send(c.voterGroups.createGroup('Ward 3', 1, clerk.address));
  const ev = rc.logs.map((l) => { try { return c.voterGroups.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'GroupCreated');
  const ward = ev.args.groupId;
  const asClerk = c.voterGroups.connect(clerk);
  // Only people already on the voter list can be added; only the group's manager adds them.
  assert.equal(await errName(asClerk.addMembers.staticCall(ward, [outsider.commitment])), 'NotOnVoterList');
  assert.equal(await errName(c.voterGroups.connect(provider.getSigner ? await provider.getSigner(2) : clerk).addMembers.staticCall(ward, [people[0].commitment])), 'NotManager');
  await send(asClerk.addMembers(ward, [people[0].commitment, people[1].commitment, people[2].commitment]));
  assert.equal(await errName(asClerk.addMembers.staticCall(ward, [people[0].commitment])), 'AlreadyMember');

  // Binding polls belong to the whole list; a ward poll is advisory.
  assert.equal(await errName(c.vote.createPollWith.staticCall({ groupId: ward, duration: 86_400, quorum: 1, options: 2, action: 2, actionData: '0x', questionCID: 'Q', bond: 0, settings: settings() })), 'InvalidParams');
  const id = await open({}, { groupId: ward, questionCID: 'Add a stop sign at 3rd and Oak?' });
  assert.equal(Number((await c.vote.getPoll(id)).electorate), 3);
  await send(c.vote.castBallot(id, await ballot(id, people[1], 0)));
  await assert.rejects(ballot(id, people[4], 0), /not eligible/); // lives elsewhere: not in the ward list

  // Removing a member (their Merkle proof computed from the public leaves) doesn't change open polls.
  const [leaves] = await c.voterGroups.leaves(ward, 0, 10);
  const g = new Group(leaves);
  const { siblings } = g.generateMerkleProof(g.indexOf(people[2].commitment));
  await send(asClerk.removeMember(ward, people[2].commitment, siblings));
  assert.equal(await c.voterGroups.isMember(ward, people[2].commitment), false);
  await send(c.vote.castBallot(id, await ballot(id, people[2], 1))); // was in the ward when the poll opened
  assert.deepEqual((await c.vote.tally(id)).map(Number), [1, 1]);
});
