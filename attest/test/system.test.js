// End-to-end tests on an in-process chain (ganache). Run: npm test
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const ganache = require('ganache');
const { ethers } = require('ethers');
const sdk = require('../src');
const { deploySystem } = require('../src/deploy');

const art = (n) => require(`../build/${n}.json`);
const ERRORS = new ethers.Interface(
  ['PrincipalRegistry', 'AgentRegistry', 'ProvenanceResolver', 'Disputes', 'EAS'].flatMap((n) => art(n).abi.filter((x) => x.type === 'error')),
);

let provider, admin, addrs, c;
let issuer, basicIssuer, alice, bob, carol, orgKey, mallory, challenger;

before(async () => {
  const g = ganache.provider({
    logging: { quiet: true },
    wallet: { totalAccounts: 1, defaultBalance: 1_000_000 },
    chain: { hardfork: 'shanghai' },
  });
  provider = new ethers.BrowserProvider(g, undefined, { cacheTimeout: -1 });
  admin = await provider.getSigner(0);
  [issuer, basicIssuer, alice, bob, carol, orgKey, mallory, challenger] = await Promise.all(
    Array.from({ length: 8 }, () => fund(ethers.Wallet.createRandom().connect(provider))),
  );
  addrs = await deploySystem(admin);
  c = sdk.connect(addrs, admin);
  await wait(c.principals.setIssuer(issuer.address, 2, true, 'Test ID verifier'));
  await wait(c.principals.setIssuer(basicIssuer.address, 1, true, 'Test email sign-up'));
  await wait(c.disputes.grantRole(ethers.id('ARBITER_ROLE'), await admin.getAddress()));
});

async function fund(w) {
  await wait(admin.sendTransaction({ to: w.address, value: ethers.parseEther('10') }));
  return w;
}
const wait = (p) => p.then((tx) => tx.wait());
const fp = (s) => ethers.id(`fingerprint:${s}`);
const as = (who) => sdk.connect(addrs, who);
const newKey = () => fund(ethers.Wallet.createRandom().connect(provider));

// Ganache drops revert data when estimating gas, so replay the call to read it.
async function revertName(e) {
  if (e.revert?.name) return e.revert.name;
  let data = e.data;
  if (!data && e.transaction) {
    try {
      await provider.call(e.transaction);
    } catch (e2) {
      data = e2.data;
    }
  }
  if (!data || data === '0x') return undefined;
  return ERRORS.parseError(data)?.name;
}

async function reverts(fn, name) {
  try {
    await fn();
  } catch (e) {
    assert.equal(await revertName(e), name, e.shortMessage || e.message);
    return;
  }
  assert.fail(`expected revert ${name}`);
}

test('issuers enrol humans: one document, one person; tiers bounded by the issuer', async () => {
  await wait(as(issuer).principals.enrollHuman(alice.address, 2, fp('alice-passport')));
  await wait(as(issuer).principals.enrollHuman(bob.address, 2, fp('bob-licence')));
  await reverts(() => as(issuer).principals.enrollHuman(mallory.address, 2, fp('alice-passport')), 'FingerprintUsed');
  await reverts(() => as(basicIssuer).principals.enrollHuman(mallory.address, 2, fp('m')), 'TierNotAllowed');
  await reverts(() => as(issuer).principals.enrollHuman(mallory.address, 2, ethers.ZeroHash), 'MissingFingerprint');
  await reverts(() => as(mallory).principals.enrollHuman(mallory.address, 1, ethers.ZeroHash), 'IssuerInactive');
  await wait(as(basicIssuer).principals.enrollHuman(carol.address, 1, fp('carol@gmail')));

  const [kind, tier, active, accountable] = await c.principals.standing(alice.address);
  assert.deepEqual([kind, tier, active, accountable], [1n, 2n, true, alice.address]);
});

test('organizations need a domain and a verified human steward', async () => {
  const domain = ethers.id('example-labs.com');
  await reverts(() => as(issuer).principals.enrollOrg(orgKey.address, 'Example Labs', domain, carol.address), 'StewardNotVerified');
  await reverts(() => as(basicIssuer).principals.enrollOrg(orgKey.address, 'Example Labs', domain, alice.address), 'TierNotAllowed');
  await wait(as(issuer).principals.enrollOrg(orgKey.address, 'Example Labs', domain, alice.address));
  const [kind, , active, accountable] = await c.principals.standing(orgKey.address);
  assert.deepEqual([kind, active, accountable], [2n, true, alice.address]);
});

let labAgent, labAgentId;
test('agents: controller sends, agent key consents; keys are never reused or shared with principals', async () => {
  labAgent = await newKey();
  labAgentId = await sdk.registerAgent({
    addresses: addrs,
    controller: orgKey,
    agentKey: labAgent,
    modelRef: 'example-provider/model-x@2026-10',
    uri: 'https://example-labs.com/.well-known/agent.json',
  });
  assert.equal(labAgentId, 1n);
  assert.equal(await c.agents.ownerOf(labAgentId), orgKey.address);
  assert.equal(await c.agents.tokenURI(labAgentId), 'https://example-labs.com/.well-known/agent.json');

  const [id, controller, accountable, retiredAt, active] = await c.agents.resolveKey(labAgent.address);
  assert.deepEqual([id, controller, accountable, retiredAt, active], [1n, orgKey.address, alice.address, 0n, true]);

  // Same key again, a principal's own key, an unregistered controller, a forged consent.
  await reverts(() => sdk.registerAgent({ addresses: addrs, controller: bob, agentKey: labAgent }), 'KeyAlreadyUsed');
  await reverts(() => sdk.registerAgent({ addresses: addrs, controller: bob, agentKey: alice }), 'KeyIsAPrincipal');
  await reverts(async () => sdk.registerAgent({ addresses: addrs, controller: mallory, agentKey: await newKey() }), 'ControllerNotInGoodStanding');

  const victim = await newKey();
  const { chainId } = await provider.getNetwork();
  const deadline = BigInt((await provider.getBlock('latest')).timestamp + 600);
  const forged = await sdk.signBinding(mallory, { chainId, agents: addrs.agents, controller: bob.address, nonce: 0n, deadline });
  await reverts(() => as(bob).agents.register(victim.address, '', '', 0, deadline, forged), 'BadSignature');
});

test('honest labels: agents cannot claim HUMAN_MADE, people cannot claim AGENT_ACTION', async () => {
  const h = sdk.hashContent(Buffer.from('a generated picture'));
  await sdk.attest(labAgent, addrs, { contentHash: h, origin: 'ai-generated', mediaType: 'image/png' });
  await reverts(() => sdk.attest(labAgent, addrs, { contentHash: h, origin: 'human-made' }), 'OriginNotAllowed');

  const essay = sdk.hashContent(Buffer.from('an essay bob wrote'));
  await sdk.attest(bob, addrs, { contentHash: essay, origin: 'human-made', mediaType: 'text/plain' });
  await reverts(() => sdk.attest(bob, addrs, { contentHash: essay, origin: 'agent-action' }), 'OriginNotAllowed');
  await reverts(() => sdk.attest(mallory, addrs, { contentHash: essay, origin: 'human-made' }), 'SignerNotInGoodStanding');

  assert.equal((await c.resolver.attestationsFor(h)).length, 1);
});

test('verify: report walks content -> agent -> org -> accountable human', async () => {
  const h = sdk.hashContent(Buffer.from('a generated picture'));
  const r = await sdk.inspect(h, { provider, addresses: addrs });
  assert.equal(r.verdict, 'signed');
  const [claim] = r.claims;
  assert.equal(claim.origin, 'AI_GENERATED');
  assert.equal(claim.signer.type, 'agent');
  assert.equal(claim.signer.agent.modelRef, 'example-provider/model-x@2026-10');
  assert.equal(claim.signer.controller.name, 'Example Labs');
  assert.equal(claim.signer.accountable.address, alice.address);
  assert.equal(claim.signer.accountable.tier, 'verified');
  assert.equal(claim.signer.accountable.issuer.name, 'Test ID verifier');

  const unknown = await sdk.inspect(sdk.hashContent(Buffer.from('never seen')), { provider, addresses: addrs });
  assert.equal(unknown.verdict, 'unsigned');
  assert.equal(unknown.claims.length, 0);
});

test('off-chain receipts verify against the registry; tampering is caught', async () => {
  const h = sdk.hashContent(Buffer.from('agent summary'));
  const receipt = await sdk.signReceipt(labAgent, { contentHash: h, origin: 'ai-generated', mediaType: 'text/markdown' }, { chainId: addrs.chainId, agents: addrs.agents });
  const r = await sdk.inspect(h, { provider, addresses: addrs, receipts: [receipt] });
  assert.equal(r.verdict, 'signed');
  assert.equal(r.claims[0].source, 'receipt');
  assert.equal(r.claims[0].signer.keyCurrentWhenSigned, true);

  assert.throws(() => sdk.recoverReceipt({ ...receipt, origin: 'HUMAN_MADE' }), /does not match/);
  const stranger = await sdk.signReceipt(mallory, { contentHash: h, origin: 'human-made' }, { chainId: addrs.chainId, agents: addrs.agents });
  const s = await sdk.inspect(sdk.hashContent(Buffer.from('agent summary')), { provider, addresses: addrs, receipts: [stranger] });
  assert.equal(s.verdict, 'unregistered-signer');
  await assert.rejects(sdk.inspect(sdk.hashContent(Buffer.from('other')), { provider, addresses: addrs, receipts: [receipt] }), /different content/);
});

test('key rotation retires the old key but keeps its earlier signatures attributable', async () => {
  const h = sdk.hashContent(Buffer.from('signed before rotation'));
  const before = await sdk.signReceipt(labAgent, { contentHash: h, origin: 'ai-generated', signedAt: (await provider.getBlock('latest')).timestamp }, { chainId: addrs.chainId, agents: addrs.agents });

  const next = await newKey();
  const { chainId } = await provider.getNetwork();
  const deadline = BigInt((await provider.getBlock('latest')).timestamp + 600);
  const sig = await sdk.signBinding(next, { chainId, agents: addrs.agents, controller: orgKey.address, nonce: 0n, deadline });
  await provider.send('evm_increaseTime', [60]);
  await wait(as(orgKey).agents.rotateKey(labAgentId, next.address, deadline, sig));

  await reverts(() => sdk.attest(labAgent, addrs, { contentHash: h, origin: 'ai-generated' }), 'SignerNotInGoodStanding');
  const r = await sdk.inspect(h, { provider, addresses: addrs, receipts: [before] });
  assert.equal(r.claims[0].signer.keyCurrentWhenSigned, true);
  assert.equal(r.claims[0].signer.agent.id, 1);
  labAgent = next;
});

test('responsibility only moves to principals in good standing', async () => {
  const agentKey = await newKey();
  const id = await sdk.registerAgent({ addresses: addrs, controller: bob, agentKey });
  await reverts(() => as(bob).agents.transferFrom(bob.address, mallory.address, id), 'ControllerNotInGoodStanding');
  await wait(as(bob).agents.transferFrom(bob.address, carol.address, id));
  const [, controller, accountable] = await c.agents.resolveKey(agentKey.address);
  assert.deepEqual([controller, accountable], [carol.address, carol.address]);
});

test('disputes: upheld strikes agent and controller and flags the claim; rejected pays the controller', async () => {
  const h = sdk.hashContent(Buffer.from('claimed as assisted, actually fully generated'));
  const uid = await sdk.attest(labAgent, addrs, { contentHash: h, origin: 'ai-assisted' });
  const bond = await c.disputes.bond();

  await reverts(() => as(challenger).disputes.open(uid, 'ipfs://evidence', { value: 1n }), 'WrongBond');
  await reverts(() => as(challenger).disputes.open.staticCall(ethers.id('nope'), 'x', { value: bond }), 'NotThisSchema');
  await wait(as(challenger).disputes.open(uid, 'ipfs://evidence', { value: bond }));
  await reverts(() => as(challenger).disputes.rule(1, true, 'x'), 'AccessControlUnauthorizedAccount');
  await wait(c.disputes.rule(1, true, 'Generation logs show no human editing.'));
  await reverts(() => c.disputes.rule(1, false, 'again'), 'NotOpen');

  const r = await sdk.inspect(h, { provider, addresses: addrs });
  assert.equal(r.verdict, 'disputed');
  assert.equal(r.claims[0].signer.agent.strikes, 1);
  assert.equal(r.claims[0].signer.controller.strikes, 1);
  assert.equal(await c.disputes.owed(challenger.address), bond);
  await wait(as(challenger).disputes.withdraw());
  assert.equal(await c.disputes.owed(challenger.address), 0n);

  const fair = await sdk.attest(labAgent, addrs, { contentHash: sdk.hashContent(Buffer.from('fair')), origin: 'ai-generated' });
  await wait(as(challenger).disputes.open(fair, 'weak', { value: bond }));
  await wait(c.disputes.rule(2, false, 'Label is accurate.'));
  assert.equal(await c.disputes.owed(orgKey.address), bond);
});

test("an org's agents lapse when its steward is revoked; banned documents stay reserved", async () => {
  const h = sdk.hashContent(Buffer.from('a generated picture'));
  await wait(as(issuer).principals.revoke(alice.address, true));
  const [, , , , active] = await c.agents.resolveKey(labAgent.address);
  assert.equal(active, false);
  await reverts(() => sdk.attest(labAgent, addrs, { contentHash: h, origin: 'ai-generated' }), 'SignerNotInGoodStanding');
  assert.equal((await sdk.inspect(h, { provider, addresses: addrs })).verdict, 'lapsed');
  await reverts(() => as(issuer).principals.enrollHuman(mallory.address, 2, fp('alice-passport')), 'FingerprintUsed');

  // A lost key (not misconduct) frees the document for re-enrolment with a new key.
  await wait(as(issuer).principals.revoke(bob.address, false));
  const fresh = await newKey();
  await wait(as(issuer).principals.enrollHuman(fresh.address, 2, fp('bob-licence')));
});
