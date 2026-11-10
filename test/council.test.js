// Council: multi-signature admin with a public waiting period, holding every admin power.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { deployAll } = require('../scripts/deploy');

const HOUR = 3600;
let provider, deployer, alice, bob, carol, outsider, clerk, c, council;

const send = async (p) => (await p).wait();
const warp = async (s) => {
  await provider.send('evm_increaseTime', [s]);
  await provider.send('evm_mine', []);
};
const rejects = (p, name) => assert.rejects(p, (e) => (e.revert?.name || e.shortMessage || e.message || '').includes(name) || String(e.data || '').length > 0 && council.interface.parseError(e.data)?.name === name);
const S = { None: 0n, Pending: 1n, Queued: 2n, Ready: 3n, Executed: 4n, Cancelled: 5n, Expired: 6n };

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 7, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [deployer, alice, bob, carol, outsider, clerk] = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => provider.getSigner(i)));
  ({ contracts: c } = await deployAll(deployer, { admin: alice.address, council: { members: [alice.address, bob.address, carol.address], threshold: 2, delaySeconds: 24 * HOUR } }));
  council = c.council;
});

/** Propose from `who`, return the id. */
async function propose(who, target, data, description = 'test') {
  const rc = await send(council.connect(who).propose(target, 0, data, description));
  return council.interface.parseLog(rc.logs.find((l) => { try { return council.interface.parseLog(l).name === 'Proposed'; } catch { return false; } })).args.id;
}

test('after hand-over only the council is admin: no single key, not even the deployer', async () => {
  const ca = await council.getAddress();
  for (const k of [c.identity, c.registry, c.vote, c.market]) {
    assert.equal(await k.hasRole(ethers.ZeroHash, ca), true);
    for (const a of [deployer, alice, bob, carol]) assert.equal(await k.hasRole(ethers.ZeroHash, a.address), false);
  }
  assert.equal(await c.credits.owner(), ca);
  assert.deepEqual([...(await council.members())], [alice.address, bob.address, carol.address]);
  assert.equal(await council.threshold(), 2n);
  await assert.rejects(c.identity.connect(alice).setIssuer(clerk.address, 1, true, 'Rogue clerk'));
});

test('granting power: two approvals, then a public wait, then anyone can run it', async () => {
  const data = c.identity.interface.encodeFunctionData('setIssuer', [clerk.address, 1, true, 'City Hall desk']);
  const id = await propose(alice, await c.identity.getAddress(), data, 'Approve City Hall desk as a clerk');
  assert.equal(await council.state(id), S.Pending);
  await assert.rejects(council.connect(outsider).execute(id));
  await send(council.connect(bob).approve(id));
  assert.equal(await council.state(id), S.Queued);
  const [p, , approvals] = await council.proposal(id);
  assert.equal(approvals, 2n);
  assert.equal(p.fast, false);
  assert.equal(p.description, 'Approve City Hall desk as a clerk');
  await assert.rejects(council.connect(outsider).execute(id)); // still waiting
  await warp(24 * HOUR + 1);
  assert.equal(await council.state(id), S.Ready);
  await send(council.connect(outsider).execute(id)); // anyone may run it after the wait
  assert.equal(await council.state(id), S.Executed);
  assert.equal((await c.identity.issuers(clerk.address)).active, true);
  await assert.rejects(council.connect(outsider).execute(id)); // only once
});

test('taking power away is instant once approved (revokeRole, or removing a clerk)', async () => {
  const id = await propose(bob, await c.identity.getAddress(), c.identity.interface.encodeFunctionData('setIssuer', [clerk.address, 1, false, 'City Hall desk']), 'Remove City Hall desk');
  assert.equal((await council.proposal(id))[0].fast, true);
  await send(council.connect(carol).approve(id));
  assert.equal(await council.state(id), S.Ready);
  await send(council.connect(carol).execute(id));
  assert.equal((await c.identity.issuers(clerk.address)).active, false);

  const proposer = await c.vote.PROPOSER_ROLE();
  const id2 = await propose(alice, await c.vote.getAddress(), c.vote.interface.encodeFunctionData('revokeRole', [proposer, deployer.address]));
  assert.equal((await council.proposal(id2))[0].fast, true);
  // Granting the same role back is not fast.
  const id3 = await propose(alice, await c.vote.getAddress(), c.vote.interface.encodeFunctionData('grantRole', [proposer, deployer.address]));
  assert.equal((await council.proposal(id3))[0].fast, false);
});

test('safety brake: one member can cancel, but not the proposal that removes them', async () => {
  const data = c.identity.interface.encodeFunctionData('grantRole', [ethers.ZeroHash, outsider.address]);
  const id = await propose(alice, await c.identity.getAddress(), data, 'Make outsider an admin');
  await send(council.connect(bob).approve(id));
  await send(council.connect(carol).cancel(id)); // the honest member stops it during the wait
  assert.equal(await council.state(id), S.Cancelled);
  await warp(25 * HOUR);
  await assert.rejects(council.connect(alice).execute(id));
  assert.equal(await c.identity.hasRole(ethers.ZeroHash, outsider.address), false);

  const ca = await council.getAddress();
  const rm = await propose(alice, ca, council.interface.encodeFunctionData('removeMember', [carol.address]), 'Remove Carol');
  await assert.rejects(council.connect(carol).cancel(rm)); // CannotCancelOwnRemoval
  await send(council.connect(bob).cancel(rm)); // others still can
});

test('council settings change only through its own proposals; removed members stop counting', async () => {
  const ca = await council.getAddress();
  await assert.rejects(council.connect(alice).addMember(outsider.address)); // OnlyCouncil
  await assert.rejects(council.connect(outsider).propose(ca, 0, '0x', 'x')); // NotMember

  // A proposal approved by Carol, then Carol is removed: her approval no longer counts.
  const pending = await propose(carol, await c.identity.getAddress(), c.identity.interface.encodeFunctionData('setIssuer', [clerk.address, 1, true, 'Library']));
  const add = await propose(alice, ca, council.interface.encodeFunctionData('addMember', [outsider.address]), 'Add a fourth member');
  await send(council.connect(bob).approve(add));
  const rm = await propose(alice, ca, council.interface.encodeFunctionData('removeMember', [carol.address]), 'Remove Carol');
  await send(council.connect(bob).approve(rm));
  await warp(24 * HOUR + 1);
  await send(council.execute(add));
  await send(council.execute(rm));
  assert.equal(await council.isMember(carol.address), false);
  assert.equal(await council.isMember(outsider.address), true);
  assert.equal(await council.approvalCount(pending), 0n);
  await assert.rejects(council.connect(carol).approve(pending));

  // Expiry: an approved proposal not run within the grace period can't be run later.
  const later = await propose(alice, ca, council.interface.encodeFunctionData('setDelay', [HOUR]), 'Shorter wait');
  await send(council.connect(bob).approve(later));
  await warp(24 * HOUR + 15 * 24 * HOUR);
  assert.equal(await council.state(later), S.Expired);
  await assert.rejects(council.execute(later));

  // A failing call reverts the execution and leaves it ready to retry.
  const bad = await propose(alice, ca, council.interface.encodeFunctionData('setThreshold', [9]), 'Impossible threshold');
  await send(council.connect(bob).approve(bad));
  await warp(24 * HOUR + 1);
  await assert.rejects(council.execute(bad));
  assert.equal(await council.state(bad), S.Ready);
});
