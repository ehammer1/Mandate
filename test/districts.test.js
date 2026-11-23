// Results by district: a resident may add their district to their own ballot or signature
// (anonymously, real proofs); results are counted by district from the public records, and
// small districts are folded into "other" so no small group's choices can be read off.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Identity } = require('@semaphore-protocol/identity');
const { deployAll } = require('../scripts/deploy');
const { buildBallot } = require('../client/ballot');
const { signatureProof } = require('../client/feedback');
const D = require('../client/districts');

process.env.SEMAPHORE_ARTIFACTS_DIR = path.dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json'));
let provider, admin, clerk, stranger, c, districts, ward1, ward2, start;
const people = Array.from({ length: 9 }, (_, i) => new Identity(`district-person-${i}`));
const send = async (p) => (await p).wait();
const errName = async (p) => {
  try {
    await p;
  } catch (e) {
    try {
      return districts.interface.parseError(e.data)?.name || e.revert?.name || e.shortMessage;
    } catch {
      return e.revert?.name || e.shortMessage;
    }
  }
  return 'no revert';
};
const group = async (name, members) => {
  const rc = await send(c.voterGroups.createGroup(name, 1, admin.address));
  const id = rc.logs.map((l) => { try { return c.voterGroups.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'GroupCreated').args.groupId;
  await send(c.voterGroups.addMembers(id, members.map((p) => p.commitment)));
  return id;
};
const tag = async (who, groupId, scope) => send(districts.tag(groupId, await D.districtProof({ provider, districts, identity: who, groupId, scope })));

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 4, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, clerk, stranger] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  start = await provider.getBlockNumber();
  ({ contracts: c } = await deployAll(admin, { districtMinMembers: 3, rules: { MIN_POLL_MINUTES: 10, PETITION_PCT: 50 } }));
  districts = new ethers.Contract(await c.districts.getAddress(), D.DISTRICTS_ABI, admin);
  await send(c.identity.setIssuer(clerk.address, 1, true, 'Clerk'));
  const longAgo = (await provider.getBlock('latest')).timestamp - 3 * 365 * 86_400;
  for (const [i, p] of people.entries()) await send(c.identity.connect(clerk).enroll(p.commitment, 1, ethers.id(`district-doc-${i}`), longAgo));
  await send(c.voterGroups.grantRole(await c.voterGroups.GROUP_CREATOR_ROLE(), admin.address));
  ward1 = await group('Ward 1', people.slice(0, 7));
  ward2 = await group('Ward 2', people.slice(7, 9)); // two people: too few to be tagged
});
after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('only those who create voter lists mark a list as a district', async () => {
  assert.equal(await errName(districts.connect(stranger).addDistrict.staticCall(ward1)), 'NotAllowed');
  assert.equal(await errName(districts.addDistrict.staticCall(999)), 'NotADistrict');
  await send(districts.addDistrict(ward1));
  await send(districts.addDistrict(ward2));
  assert.deepEqual((await D.listDistricts(districts)).map((d) => [d.name, d.size]), [['Ward 1', 7], ['Ward 2', 2]]);
  assert.equal(await D.myDistrict(districts, people[8].commitment), ward2);
});

test("a poll by district: each tag attaches to the person's own ballot and follows its final choice", async () => {
  await send(c.vote.createPollWith({ groupId: await c.identity.groupId(1), duration: 86_400, quorum: 1, options: 2, action: 0, actionData: '0x', questionCID: 'Q', bond: 0, settings: { changeCutoff: 0, channels: 0, ranked: false, grace: 0 } }));
  const id = await c.vote.pollCount();
  const scope = await c.vote.scopeOf(id);
  const choices = [0, 0, 0, 1, 1, 0, 1, 0]; // people 0-6 in Ward 1, person 7 in Ward 2
  for (const [i, ch] of choices.entries()) await send(c.vote.castBallot(id, await buildBallot({ provider, vote: c.vote, pollId: id, identity: people[i], option: ch })));
  for (let i = 0; i < 6; i++) await tag(people[i], ward1, scope);

  // Once per ballot; the district is the proof's message; a small district can't be tagged.
  assert.equal(await errName(districts.tag.staticCall(ward1, await D.districtProof({ provider, districts, identity: people[0], groupId: ward1, scope }))), 'AlreadyTagged');
  const p = await D.districtProof({ provider, districts, identity: people[6], groupId: ward1, scope });
  assert.equal(await errName(districts.tag.staticCall(ward2, { ...p, message: ward2 })), 'TooFewMembers');
  assert.equal(await errName(districts.tag.staticCall(ward1, { ...p, message: ward1 + 1n })), 'WrongMessage');
  await assert.rejects(D.districtProof({ provider, districts, identity: people[7], groupId: ward1, scope }), /not on this district/);

  // Person 1 changes their vote: the district count follows the ballot that counts.
  await send(c.vote.castBallot(id, await buildBallot({ provider, vote: c.vote, pollId: id, identity: people[1], option: 1 })));
  const r = await D.pollByDistrict({ vote: c.vote, districts, pollId: id, options: 2, fromBlock: start });
  assert.deepEqual(r.shown.map((d) => [String(d.groupId), d.n, d.counts]), [[String(ward1), 6, [3, 3]]]);
  assert.deepEqual([r.other.n, r.other.counts], [2, [1, 1]]); // persons 6 and 7: no district added
});

test('fewer than 5 tagged: folded into "other", which itself never holds fewer than 5 but some', () => {
  const by = new Map([['1', { n: 12, counts: [8, 4] }], ['2', { n: 3, counts: [1, 2] }], ['3', { n: 7, counts: [2, 5] }]]);
  const r = D.suppress(by, { n: 0, counts: [0, 0] }, 2);
  assert.deepEqual(r.shown.map((d) => d.groupId), ['1']); // Ward 2 (3) is hidden, so Ward 3 joins "other" too
  assert.deepEqual([r.other.n, r.other.counts], [10, [3, 7]]);
  const r2 = D.suppress(by, { n: 4, counts: [2, 2] }, 2);
  assert.deepEqual([r2.shown.map((d) => d.groupId), r2.other.n], [['1', '3'], 7]);
  // Only ballots with no district in "other": nothing to hide, however few.
  const r3 = D.suppress(new Map([['1', { n: 6, counts: [3, 3] }]]), { n: 2, counts: [1, 1] }, 2);
  assert.deepEqual([r3.shown.length, r3.other.n], [1, 2]);
});

test('petition signatures by district, through the relayer', async () => {
  const { createRelayer } = require('../broker/relayer');
  await send(c.feedback.createPetition(1, 0, '0x', 'nb:0x' + 'e'.repeat(64)));
  const pid = await c.feedback.petitionCount();
  const scope = await c.feedback.petitionScope(pid);
  for (let i = 0; i < 5; i++) await send(c.feedback.sign(pid, await signatureProof({ provider, feedback: c.feedback, identity: people[i], tier: 1, petitionId: pid })));
  const server = createRelayer({ provider, signer: stranger, voteAddress: await c.vote.getAddress(), districtsAddress: await districts.getAddress(), log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = async (body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/district`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) });
    return { status: res.status, body: await res.json() };
  };
  try {
    for (let i = 0; i < 4; i++) assert.equal((await post({ groupId: ward1, proof: await D.districtProof({ provider, districts, identity: people[i], groupId: ward1, scope }) })).status, 200);
    const again = await post({ groupId: ward1, proof: await D.districtProof({ provider, districts, identity: people[0], groupId: ward1, scope }) });
    assert.deepEqual([again.status, again.body.error], [409, 'AlreadyTagged']);
    assert.equal((await post({ groupId: ward1 })).status, 400);
  } finally {
    server.close();
  }
  // A tag without a signature doesn't count (person 6 tags but never signed).
  await tag(people[6], ward1, scope);
  const feedback = new ethers.Contract(await c.feedback.getAddress(), ['function nullifierUsed(uint256) view returns (bool)'], provider);
  await tag(people[4], ward1, scope);
  const r = await D.signaturesByDistrict({ target: feedback, districts, scope, total: 5, fromBlock: start });
  assert.deepEqual(r.shown.map((d) => [String(d.groupId), d.n]), [[String(ward1), 5]]);
  assert.equal(r.other.n, 0);
});
