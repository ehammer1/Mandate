// Notice board (permanent public text) and per-mandate budget escrows from the factory.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { deployAll } = require('../scripts/deploy');

let provider, admin, responsible, backer, verifier, c;
const DAY = 86_400;
const send = async (p) => (await p).wait();

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 5, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, responsible, backer, verifier] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  ({ contracts: c } = await deployAll(admin, { escrowDecayBps: 1000, escrowDecayDays: 1 }));
  await send(c.registry.grantRole(await c.registry.GOVERNOR_ROLE(), admin.address));
  await send(c.registry.grantRole(await c.registry.VERIFIER_ROLE(), verifier.address));
});

test('notice board: text is stored once under its hash and can be read back exactly', async () => {
  const text = JSON.stringify({ title: 'Fix the Elm Street crossing', body: 'Raised crossing and lights by June.' });
  const id = ethers.keccak256(ethers.toUtf8Bytes(text));
  assert.equal(await c.notices.post.staticCall(text), id);
  await send(c.notices.post(text));
  assert.equal(await c.notices.read(id), text);
  assert.equal(await c.notices.author(id), admin.address);
  await send(c.notices.connect(backer).post(text)); // reposting is harmless and keeps the first author
  assert.equal(await c.notices.author(id), admin.address);
  await assert.rejects(c.notices.post(''));
  await assert.rejects(c.notices.post('x'.repeat(16_385)));
});

test('escrow factory: one escrow per open mandate; budget released when verified', async () => {
  const now = (await provider.getBlock('latest')).timestamp;
  await send(c.registry.createMandate(responsible.address, now + 30 * DAY, 1, ethers.id('streets'), 'nb:0x' + '1'.repeat(64)));
  const addr = await c.escrows.escrowFor.staticCall(1);
  await send(c.escrows.connect(backer).escrowFor(1));
  assert.equal(await c.escrows.escrowOf(1), addr);
  await send(c.escrows.escrowFor(1)); // same escrow, not a second one
  assert.equal(await c.escrows.escrowOf(1), addr);
  const esc = new ethers.Contract(addr, ['function depositETH() payable', 'function release()', 'function lockedBalance() view returns (uint256)', 'function treasury() view returns (address)', 'function decayInterval() view returns (uint32)'], backer);
  assert.equal(await esc.treasury(), admin.address); // no council in this deployment: the treasury
  assert.equal(await esc.decayInterval(), BigInt(DAY));
  await send(esc.depositETH({ value: ethers.parseEther('2') }));
  assert.equal(await esc.lockedBalance(), ethers.parseEther('2'));

  await send(c.registry.connect(responsible).submitEvidence(1, 'nb:0x' + '2'.repeat(64)));
  await send(c.registry.connect(verifier).attest(1, true, ''));
  const before = await provider.getBalance(responsible.address);
  await send(esc.release());
  assert.equal(await provider.getBalance(responsible.address) - before, ethers.parseEther('2'));

  await assert.rejects(c.escrows.escrowFor(2)); // no such mandate
});

test('with a council, overdue budgets drain to the council', async () => {
  const [m1, m2] = [responsible, backer];
  const { contracts: k } = await deployAll(admin, { council: { members: [m1.address, m2.address], threshold: 2, delaySeconds: 3600 } });
  assert.equal(await k.escrows.treasury(), await k.council.getAddress());
});
