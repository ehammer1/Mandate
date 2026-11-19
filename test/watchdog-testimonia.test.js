// The watchdog over Testimonia's contracts (photo and video provenance, governed by the
// council): issuer and phone-checker changes, admin changes, revocations, dispute bond.
// Real Testimonia contracts on a local chain (compiled copies in attest/build).
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { createWatchdog, testimoniaAddresses } = require('../services/watchdog/server');
const { rulesForEvent, describeCall } = require('../services/watchdog/rules');

const art = (n) => require(`../attest/build/${n}.json`);
let provider, admin, checker, council, principals, devices, dog;

async function deploy(name, ...args) {
  const { abi, bytecode } = art(name);
  const c = await new ethers.ContractFactory(abi, bytecode, admin).deploy(...args);
  await c.waitForDeployment();
  return c;
}
const wait = (p) => p.then((t) => t.wait());

before(async () => {
  const g = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 3, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } });
  provider = new ethers.BrowserProvider(g, undefined, { cacheTimeout: -1 });
  [admin, checker, council] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  principals = await deploy('PrincipalRegistry', admin.address);
  devices = await deploy('DeviceRegistry', admin.address, await principals.getAddress());
  dog = createWatchdog({
    provider,
    addresses: testimoniaAddresses({ testimonia: { principals: await principals.getAddress(), devices: await devices.getAddress() } }, () => ''),
    startBlock: (await provider.getBlockNumber()) + 1,
    log: () => {},
  });
});

test('approving a phone checker or an identity issuer, and handing admin to the council, are announced', async () => {
  await wait(devices.setDeviceIssuer(checker.address, true, 'Acme phone checks'));
  await wait(principals.setIssuer(checker.address, 2, true, 'County clerk'));
  await wait(devices.grantRole(ethers.ZeroHash, council.address));
  await wait(devices.renounceRole(ethers.ZeroHash, admin.address));
  const raised = await dog.scanOnce();
  const titles = raised.map((a) => `${a.severity} ${a.title}`);
  assert.ok(titles.some((t) => /^high "Acme phone checks" \(0x.{4}….{4}\) approved to register phones in Testimonia$/.test(t)), titles.join('\n'));
  assert.ok(titles.some((t) => /^high "County clerk" .* approved to vouch for people in Testimonia$/.test(t)));
  assert.ok(titles.some((t) => /^high ADMIN role granted to .* on Testimonia phone registry$/.test(t)));
  assert.ok(titles.some((t) => /^high ADMIN role revoked from .* on Testimonia phone registry$/.test(t)));
});

test('rules: registration bursts, revocations, strikes, rulings and the bond', () => {
  const ctx = { thresholds: { enrolPerHour: 3 }, enrolWindows: new Map(), spikeFlagged: new Map(), issuerNames: new Map() };
  const ev = (name, args, t = 1000) => ({ contract: 'Testimonia phone registry', name, args, tx: '0x1', block: 1, time: t });
  const issuer = '0x' + '11'.repeat(20);
  const burst = [];
  for (let i = 0; i < 6; i++) burst.push(...rulesForEvent(ev('DeviceRegistered', { keyId: '0x' + '00'.repeat(32), owner: issuer, issuer, platform: 1, ownerTier: 2 }, 1000 + i), ctx));
  assert.equal(burst.length, 1, 'flagged once an hour, not per phone');
  assert.match(burst[0].title, /^4 phones registered by 0x1111…1111 in an hour/);

  const one = (contract, name, args) => rulesForEvent({ ...ev(name, args), contract }, ctx)[0];
  assert.equal(one('Testimonia disputes', 'BondSet', { bond: ethers.parseEther('0.01') }).title, 'Testimonia dispute bond set to 0.01 ETH');
  assert.match(one('Testimonia disputes', 'Ruled', { id: 3n, uid: '0x' + '22'.repeat(32), upheld: true, ruling: 'r' }).title, /dispute #3 upheld/);
  assert.match(one('Testimonia identity registry', 'Revoked', { account: issuer, by: issuer, banned: true }).title, /banned in Testimonia/);
  assert.match(one('Testimonia AI-agent registry', 'AgentStruck', { agentId: 7n, strikes: 2 }).title, /AI agent #7 struck in Testimonia \(2 strikes\)/);
  // A Promissa voter-list revocation is still described as before.
  assert.match(rulesForEvent({ ...ev('Revoked', { commitment: 1n, by: issuer }), contract: 'identity registry' }, ctx)[0].title, /removed from the voter list/);
});

test('council proposals on Testimonia contracts read in plain words', () => {
  const i = new ethers.Interface(['function setDeviceIssuer(address,bool,string)', 'function setIssuer(address,uint8,bool,string)', 'function setBond(uint96)']);
  const dev = '0x' + '33'.repeat(20);
  const names = { [dev]: 'Testimonia phone registry' };
  assert.match(describeCall(dev, i.encodeFunctionData('setDeviceIssuer', [dev, true, 'Acme']), names), /^approve 0x3333…3333 \("Acme"\) to register phones in Testimonia$/);
  assert.match(describeCall(dev, i.encodeFunctionData('setIssuer', [dev, 2, false, 'Clerk']), { [dev]: 'Testimonia identity registry' }), /remove Testimonia identity issuer/);
  assert.equal(describeCall(dev, i.encodeFunctionData('setBond', [ethers.parseEther('0.5')]), names), 'set the Testimonia dispute bond to 0.5 ETH');
});
