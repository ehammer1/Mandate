// Public track records: promises delivered (on time or late), petitions started from one's own
// account, public roles. Never votes.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { deployAll } = require('../scripts/deploy');
const { recordIndex, recordLine } = require('../client/record');

test('a track record from public actions only: delivered, on time, overdue, petitions, public role', async () => {
  const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 4, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  const [admin, worker, checker] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const { contracts: c } = await deployAll(admin, {});
  const send = async (p) => (await p).wait();
  await send(c.registry.grantRole(await c.registry.GOVERNOR_ROLE(), admin.address));
  await send(c.registry.grantRole(await c.registry.VERIFIER_ROLE(), checker.address));
  const now = (await provider.getBlock('latest')).timestamp;
  const make = async (days) => {
    await send(c.registry.createMandate(worker.address, now + days * 86_400, 1, ethers.id('roads'), 'nb:0x' + 'a'.repeat(64)));
    return c.registry.mandateCount();
  };
  const done = await make(30);
  await send(c.registry.connect(worker).submitEvidence(done, 'nb:0x' + 'b'.repeat(64)));
  await send(c.registry.connect(checker).attest(done, true, ''));
  await make(2); // will be overdue
  await make(90); // in progress
  await send(c.feedback.connect(worker).createPetition(0, 0, '0x', 'nb:0x' + 'c'.repeat(64)));
  await send(c.officials.connect(worker).registerDelegate('Dana Ortiz', ''));
  await provider.send('evm_increaseTime', [5 * 86_400]);
  await provider.send('evm_mine', []);

  const cfg = { registryAddress: await c.registry.getAddress(), feedbackAddress: await c.feedback.getAddress(), officialsAddress: await c.officials.getAddress() };
  const idx = await recordIndex({ provider, cfg });
  const p = idx.of(worker.address);
  assert.deepEqual([p.promises, p.delivered, p.onTime, p.overdue, p.open, p.petitions, p.reachedVote, p.name, p.role], [3, 1, 1, 1, 1, 1, 0, 'Dana Ortiz', 'Public delegate']);
  assert.equal(recordLine(p), '1 of 3 promises delivered (1 on time) · 1 overdue · 1 in progress · started 1 petition, 0 reached a vote');
  assert.equal(recordLine(idx.of(checker.address)), 'No public track record yet');
  assert.deepEqual(idx.people().map((x) => x.account), [worker.address]); // only public roles and promises are listed
});
