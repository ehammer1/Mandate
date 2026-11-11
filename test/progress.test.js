// Progress on mandates: only the responsible party posts milestones and updates, only while the
// mandate is under way; everyone can read them.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { deployAll } = require('../scripts/deploy');

let c, admin, team, outsider;
const send = async (p) => (await p).wait();
const errName = async (p) => {
  try {
    await p;
  } catch (e) {
    try {
      return c.progress.interface.parseError(e.data)?.name || e.revert?.name || e.shortMessage;
    } catch {
      return e.revert?.name || e.shortMessage;
    }
  }
  return 'no revert';
};

before(async () => {
  const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, team, outsider] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  ({ contracts: c } = await deployAll(admin, {}));
  await send(c.registry.grantRole(await c.registry.GOVERNOR_ROLE(), admin.address));
  await send(c.registry.grantRole(await c.registry.VERIFIER_ROLE(), admin.address));
  const deadline = (await provider.getBlock('latest')).timestamp + 90 * 86_400;
  await send(c.registry.createMandate(team.address, deadline, 1, ethers.id('roads'), 'nb:0x' + '1'.repeat(64)));
});

test('the responsible party reports progress; nobody else can; it stops when the mandate is settled', async () => {
  const id = await c.registry.mandateCount();
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await errName(c.progress.connect(outsider).postUpdate.staticCall(id, 10, 'nb:0x' + '2'.repeat(64))), 'NotResponsible');
  await send(c.progress.connect(team).addMilestone(id, 'Survey and design', now + 30 * 86_400));
  await send(c.progress.connect(team).addMilestone(id, 'Repave 1st to 5th', now + 60 * 86_400));
  await send(c.progress.connect(team).postUpdate(id, 25, 'nb:0x' + '3'.repeat(64)));
  await send(c.progress.connect(team).completeMilestone(id, 0, 'nb:0x' + '4'.repeat(64)));
  assert.equal(await errName(c.progress.connect(team).completeMilestone.staticCall(id, 0, '')), 'AlreadyDone');
  assert.equal(await errName(c.progress.connect(team).postUpdate.staticCall(id, 101, 'nb:0x' + '5'.repeat(64))), 'BadInput');
  const [percent, last, done, total] = await c.progress.summary(id);
  assert.deepEqual([Number(percent), Number(done), Number(total)], [25, 1, 2]);
  assert.ok(Number(last) > 0);
  assert.equal((await c.progress.milestonesOf(id))[1].title, 'Repave 1st to 5th');
  assert.equal((await c.progress.updatesOf(id)).length, 1);

  // Settled (verified as done): no more updates.
  await send(c.registry.connect(team).submitEvidence(id, 'nb:0x' + '6'.repeat(64)));
  await send(c.registry.attest(id, true, ''));
  assert.equal(await errName(c.progress.connect(team).postUpdate.staticCall(id, 100, 'nb:0x' + '7'.repeat(64))), 'NotActive');
});
