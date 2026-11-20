// v6: a lost voter code is replaced in one step, keeping the person's place on the voter list,
// and the community's "keep me signed in" setting is a rule decided by vote.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Identity } = require('@semaphore-protocol/identity');
const { deployAll } = require('../scripts/deploy');
const { siblingsFor } = require('../client/voterlist');
const { buildBallot } = require('../client/ballot');

process.env.SEMAPHORE_ARTIFACTS_DIR = path.dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json'));
const DAY = 86_400;
let provider, admin, desk, otherDesk, c;
const send = async (p) => (await p).wait();
const doc = (s) => ethers.id(`doc:${s}`);
const revertName = async (p) => {
  try {
    await p;
  } catch (e) {
    try {
      return c.identity.interface.parseError(e.data)?.name || e.revert?.name || e.shortMessage;
    } catch {
      return e.revert?.name || e.shortMessage;
    }
  }
  return 'no revert';
};
const isOnList = async (tier, commitment) => {
  const n = Number(await c.identity.leafCount(tier));
  const [leaves, removed] = await c.identity.leaves(tier, 0, n);
  return leaves.some((x, i) => x === commitment && removed[i] === 0n);
};

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 4, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, desk, otherDesk] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  ({ contracts: c } = await deployAll(admin, {}));
  await send(c.identity.setIssuer(desk.address, 1, true, 'Main Library desk'));
  await send(c.identity.setIssuer(otherDesk.address, 1, true, 'City Hall desk'));
});

test('the desk that enrolled someone replaces their lost code in one step: same rights, old code off the list', async () => {
  const lost = new Identity('replace-lost');
  const fresh = new Identity('replace-fresh');
  const longAgo = (await provider.getBlock('latest')).timestamp - 5 * 365 * DAY;
  await send(c.identity.connect(desk).enroll(lost.commitment, 1, doc('A1'), longAgo));
  const before = await c.identity.members(lost.commitment);
  assert.equal(before.tier, 2n); // a long-time resident: full voting rights at once

  const siblings = await siblingsFor(c.identity, lost.commitment, Number(before.tier));
  const r = await send(c.identity.connect(desk).replace(lost.commitment, fresh.commitment, siblings));
  assert.ok(r.logs.some((l) => c.identity.interface.parseLog(l)?.name === 'Replaced'));

  const after = await c.identity.members(fresh.commitment);
  assert.equal((await c.identity.members(lost.commitment)).active, false);
  assert.equal(after.active, true);
  assert.equal(after.tier, before.tier);
  assert.equal(after.issuer, desk.address);
  assert.equal(after.residentSince, before.residentSince);
  assert.equal(after.docHash, before.docHash);
  assert.equal(await c.identity.commitmentOfDoc(doc('A1')), fresh.commitment);
  for (const t of [0, 1, 2]) {
    assert.equal(await isOnList(t, fresh.commitment), true, `new code missing from list ${t}`);
    assert.equal(await isOnList(t, lost.commitment), false, `old code still on list ${t}`);
  }
});

test('only the enrolling desk or the council may replace, never onto a code already in use', async () => {
  const lost = new Identity('replace-guard-lost');
  const fresh = new Identity('replace-guard-fresh');
  const taken = new Identity('replace-guard-taken');
  await send(c.identity.connect(desk).enroll(lost.commitment, 1, doc('B1'), 0));
  await send(c.identity.connect(desk).enroll(taken.commitment, 0, ethers.ZeroHash, 0));
  const siblings = await siblingsFor(c.identity, lost.commitment, 1);
  assert.equal(await revertName(c.identity.connect(otherDesk).replace.staticCall(lost.commitment, fresh.commitment, siblings)), 'NotAuthorized');
  assert.equal(await revertName(c.identity.connect(desk).replace.staticCall(lost.commitment, taken.commitment, siblings)), 'AlreadyEnrolled');
  // A desk the council switched off can't either; the council (admin) still can.
  await send(c.identity.setIssuer(desk.address, 1, false, 'Main Library desk'));
  assert.equal(await revertName(c.identity.connect(desk).replace.staticCall(lost.commitment, fresh.commitment, siblings)), 'IssuerInactive');
  await send(c.identity.connect(admin).replace(lost.commitment, fresh.commitment, siblings));
  assert.equal((await c.identity.members(fresh.commitment)).active, true);
  await send(c.identity.setIssuer(desk.address, 1, true, 'Main Library desk'));
});

test('an account that joined online moves with the person to the new code', async () => {
  const lost = new Identity('replace-online-lost');
  const fresh = new Identity('replace-online-fresh');
  const account = ethers.id('google|12345');
  await send(c.identity.connect(desk).enroll(lost.commitment, 0, account, 0));
  await send(c.identity.connect(desk).replace(lost.commitment, fresh.commitment, await siblingsFor(c.identity, lost.commitment, 0)));
  assert.equal(await c.identity.commitmentOfAccount(account), fresh.commitment);
  assert.equal((await c.identity.members(fresh.commitment)).accountHash, account);
});

test('a poll opened before the swap keeps its frozen list: the new code can\'t vote twice in it', async () => {
  const lost = new Identity('replace-poll-lost');
  const fresh = new Identity('replace-poll-fresh');
  await send(c.identity.connect(desk).enroll(lost.commitment, 1, doc('C1'), 0));
  await send(c.vote.createPoll(await c.identity.groupId(1), 7 * DAY, 1, 2, 0, '0x', 'Before the swap', 0));
  const pollId = await c.vote.pollCount();
  await send(c.vote.castBallot(pollId, await buildBallot({ provider, vote: c.vote, pollId, identity: lost, option: 0 })));
  await send(c.identity.connect(desk).replace(lost.commitment, fresh.commitment, await siblingsFor(c.identity, lost.commitment, 1)));
  await assert.rejects(buildBallot({ provider, vote: c.vote, pollId, identity: fresh, option: 1 }), /not eligible/);
});

test('a desk can replace at most 50 codes a day (bounds a compromised desk)', async () => {
  assert.equal(await c.identity.MAX_REPLACEMENTS_PER_DAY(), 50n);
  const day = BigInt(Math.floor((await provider.getBlock('latest')).timestamp / DAY));
  const used = Number(await c.identity.replacementsOn(desk.address, day));
  assert.ok(used >= 3 && used < 50, `used ${used}`);
});

test('the community decides "keep me signed in" by vote: a rule, off by default, 0 or 1', async () => {
  const key = ethers.id('KEEP_SIGNED_IN');
  assert.equal(await c.charter.rule(key), 0n);
  await c.charter.check(key, 1);
  await assert.rejects(c.charter.check(key, 2));
});
