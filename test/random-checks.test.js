// Random checkers: each round of mandate evidence is checked by verifiers drawn at random once
// the evidence is in, so nobody knows in advance whom to lean on.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { deployAll } = require('../scripts/deploy');

let provider, admin, worker, outsider, verifiers, c;
const DAY = 86_400;
const send = async (p) => (await p).wait();
const errName = async (p) => {
  try {
    await p;
  } catch (e) {
    try {
      return c.registry.interface.parseError(e.data)?.name || e.revert?.name || e.shortMessage;
    } catch {
      return e.revert?.name || e.shortMessage;
    }
  }
  return 'no revert';
};
const mine = async (n) => {
  for (let i = 0; i < n; i++) await provider.send('evm_mine', []);
};
const newMandate = async (threshold) => {
  const now = (await provider.getBlock('latest')).timestamp;
  await send(c.registry.createMandate(worker.address, now + 30 * DAY, threshold, ethers.id('streets'), 'nb:0x' + 'c'.repeat(64)));
  return c.registry.mandateCount();
};

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 10, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  const all = await Promise.all([...Array(10).keys()].map((i) => provider.getSigner(i)));
  [admin, worker, outsider] = all;
  verifiers = all.slice(3); // seven verifiers
  ({ contracts: c } = await deployAll(admin, {}));
  await send(c.registry.grantRole(await c.registry.GOVERNOR_ROLE(), admin.address)); // stands in for a passed public vote
  for (const v of [...verifiers, worker]) await send(c.registry.grantRole(await c.registry.VERIFIER_ROLE(), v.address)); // the worker is a verifier too: never on their own panel
});

test('only the council sets the panel size, at most 25', async () => {
  assert.equal(await errName(c.registry.connect(outsider).setPanelSize.staticCall(3)), 'AccessControlUnauthorizedAccount');
  assert.equal(await errName(c.registry.setPanelSize.staticCall(26)), 'BadPanelSize');
  await send(c.registry.setPanelSize(3));
  assert.equal(Number(await c.registry.panelSize()), 3);
});

test('evidence in, then checkers drawn from a block nobody knew; only they decide', async () => {
  const id = await newMandate(2);
  await send(c.registry.connect(worker).submitEvidence(id, 'nb:0x' + 'e'.repeat(64)));
  const m = await c.registry.getMandate(id);
  let [size, seedBlock, members] = await c.registry.panelOf(id, m.round);
  assert.deepEqual([Number(size), members.length], [3, 0]);
  assert.equal(await errName(c.registry.connect(verifiers[0]).attest.staticCall(id, true, '')), 'PanelNotReady'); // not drawn yet
  assert.equal(await errName(c.registry.drawPanel.staticCall(id)), 'PanelNotReady'); // seed block not reached
  await mine(Number(seedBlock) - (await provider.getBlockNumber()) + 1);
  await send(c.registry.connect(outsider).drawPanel(id)); // anyone may draw
  assert.equal(await errName(c.registry.drawPanel.staticCall(id)), 'PanelAlreadyDrawn');
  [size, seedBlock, members] = await c.registry.panelOf(id, m.round);
  assert.equal(members.length, 3);
  assert.equal(new Set(members).size, 3);
  assert.ok(!members.includes(worker.address), 'the responsible party never checks their own work');

  const on = verifiers.filter((v) => members.includes(v.address));
  const off = verifiers.find((v) => !members.includes(v.address));
  assert.equal(await errName(c.registry.connect(off).attest.staticCall(id, true, '')), 'NotOnPanel');
  await send(c.registry.connect(on[0]).attest(id, true, ''));
  await send(c.registry.connect(on[1]).attest(id, true, ''));
  assert.equal(Number((await c.registry.getMandate(id)).status), 3); // fulfilled
});

test('a panel is never smaller than the checks needed; a draw nobody ran in time gets a new seed block', async () => {
  const id = await newMandate(4); // threshold above the panel size: the panel grows to 4
  await send(c.registry.connect(worker).submitEvidence(id, 'nb:0x' + 'f'.repeat(64)));
  const round = (await c.registry.getMandate(id)).round;
  const [size, seedBlock] = await c.registry.panelOf(id, round);
  assert.equal(Number(size), 4);
  await mine(Number(seedBlock) - (await provider.getBlockNumber()) + 258); // past the 256-block window
  const rc = await send(c.registry.drawPanel(id));
  assert.ok(rc.logs.some((l) => c.registry.interface.parseLog(l)?.name === 'PanelScheduled'));
  const [, later, none] = await c.registry.panelOf(id, round);
  assert.ok(later > seedBlock);
  assert.equal(none.length, 0);
  await mine(6);
  await send(c.registry.drawPanel(id));
  assert.equal((await c.registry.panelOf(id, round))[2].length, 4);
});

test('panel size 0: every verifier may check, as before', async () => {
  await send(c.registry.setPanelSize(0));
  const id = await newMandate(1);
  await send(c.registry.connect(worker).submitEvidence(id, 'nb:0x' + 'a'.repeat(64)));
  await send(c.registry.connect(verifiers[6]).attest(id, true, ''));
  assert.equal(Number((await c.registry.getMandate(id)).status), 3);
});
