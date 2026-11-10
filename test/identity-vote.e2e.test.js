// Identity + private voting end to end, with real zero-knowledge proofs:
// issuers enrol residents, seasoning, snapshot electorates, ballots built by the
// client library and submitted through the relayer (voters have no wallets),
// bonds, and binding actions. Run: npm test
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Identity } = require('@semaphore-protocol/identity');
const { Group } = require('@semaphore-protocol/group');
const { buildBallot } = require('../client/ballot');
const { createRelayer } = require('../broker/relayer');

process.env.SEMAPHORE_ARTIFACTS_DIR = path.dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json'));

const art = (n) => require(`../build/${n}.json`);
const DAY = 86_400;
const E = (n) => ethers.parseEther(String(n));
const docHash = (s) => ethers.keccak256(ethers.toUtf8Bytes(`pepper:${s}`)); // issuers use an HMAC with a secret pepper

let provider, admin, clerk, phoneCheck, treasury, agency, relayerKey, outsider;
let semaphore, identity, vote, registry, credits, server, relayerUrl;

function link(bytecode, linkReferences, libs) {
  let out = bytecode.slice(2);
  for (const [file, names] of Object.entries(linkReferences || {})) {
    for (const [name, refs] of Object.entries(names)) {
      const addr = libs[name].slice(2).toLowerCase();
      for (const { start } of refs) out = out.slice(0, start * 2) + addr + out.slice(start * 2 + 40);
      void file;
    }
  }
  return '0x' + out;
}
async function deploy(name, libs, ...args) {
  const a = art(name);
  const f = new ethers.ContractFactory(a.abi, link(a.bytecode, a.linkReferences, libs), admin);
  return (await f.deploy(...args)).waitForDeployment();
}
const wait = (p) => p.then((t) => t.wait());
async function advance(s) {
  await provider.send('evm_increaseTime', [s]);
  await provider.send('evm_mine', []);
}
async function reverts(fn, name) {
  try {
    await fn();
  } catch (e) {
    if (name) assert.equal(e.revert?.name, name, e.shortMessage || e.message);
    return;
  }
  assert.fail(`expected revert ${name || ''}`);
}
async function post(pathname, body) {
  const res = await fetch(relayerUrl + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

// Residents. Each Identity's secret would live on the person's phone (or a card).
const residents = Array.from({ length: 5 }, (_, i) => new Identity(`resident-secret-${i}`));
const newcomer = new Identity('newcomer-secret');
const lateJoiner = new Identity('late-joiner-secret');

before(async () => {
  const g = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 8, defaultBalance: 1000 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } });
  provider = new ethers.BrowserProvider(g, undefined, { cacheTimeout: -1 });
  [admin, clerk, phoneCheck, treasury, agency, relayerKey, outsider] = await Promise.all([...Array(7).keys()].map((i) => provider.getSigner(i)));

  const poseidon = await deploy('PoseidonT3', {});
  const verifier = await deploy('SemaphoreVerifier', {});
  semaphore = await deploy('Semaphore', { PoseidonT3: await poseidon.getAddress() }, await verifier.getAddress());
  identity = await deploy('IdentityRegistry', {}, admin.address, await semaphore.getAddress(), 30 * DAY);
  credits = await deploy('PlayCredits', {}, admin.address);
  vote = await deploy('MandateVote', {}, admin.address, await identity.getAddress(), await verifier.getAddress(), await credits.getAddress(), treasury.address, E(100), ethers.ZeroAddress); // no charter: rules tested in charter.test.js
  registry = await deploy('MandateRegistry', {}, admin.address);
  await wait(registry.grantRole(await registry.GOVERNOR_ROLE(), await vote.getAddress()));
  await wait(registry.grantRole(await registry.VERIFIER_ROLE(), clerk.address));
  await wait(vote.grantRole(await vote.PROPOSER_ROLE(), admin.address));

  // Identity sources: the city clerk (verified tier) and a phone-check service (basic only).
  await wait(identity.setIssuer(clerk.address, 1, true, 'Example City Clerk'));
  await wait(identity.setIssuer(phoneCheck.address, 0, true, 'Phone check'));

  // Long-standing residents verified at the clerk desk skip seasoning.
  const longAgo = (await provider.getBlock('latest')).timestamp - 2 * 365 * DAY;
  for (const [i, r] of residents.entries()) {
    await wait(identity.connect(clerk).enroll(r.commitment, 1, docHash(`DL-${i}`), longAgo));
  }
  // A newcomer who just moved here: verified, but must wait out seasoning.
  await wait(identity.connect(clerk).enroll(newcomer.commitment, 1, docHash('DL-new'), 0));

  server = createRelayer({ provider, signer: relayerKey, voteAddress: await vote.getAddress(), log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  relayerUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections(); // fetch keeps connections alive, which would block close()
  await new Promise((r) => server.close(r));
  // The proof library keeps a pool of worker threads for its elliptic-curve maths.
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('identity: tiers, issuer limits, one document one person, seasoning', async () => {
  const [basic, verified, seasoned] = await Promise.all([0, 1, 2].map((t) => identity.groupId(t)));
  assert.equal(await semaphore.getMerkleTreeSize(verified), 6n);
  assert.equal(await semaphore.getMerkleTreeSize(seasoned), 5n); // newcomer not yet

  const someone = new Identity('someone');
  await reverts(() => identity.connect(phoneCheck).enroll.staticCall(someone.commitment, 1, docHash('x'), 0), 'TierNotAllowed');
  await reverts(() => identity.connect(outsider).enroll.staticCall(someone.commitment, 0, ethers.ZeroHash, 0), 'IssuerInactive');
  await reverts(() => identity.connect(clerk).enroll.staticCall(someone.commitment, 1, docHash('DL-0'), 0), 'DocumentAlreadyUsed');

  await wait(identity.connect(phoneCheck).enroll(lateJoiner.commitment, 0, ethers.ZeroHash, 0));
  assert.equal(await semaphore.getMerkleTreeSize(basic), 7n);
  await reverts(() => identity.season.staticCall(newcomer.commitment), 'NotYetSeasoned');
});

test('vote: full flow with real proofs', async () => {
  // Fresh poll on SEASONED residents.
  const seasonedGroup = await identity.groupId(2);
  const data = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint64', 'uint16', 'bytes32', 'string'],
    [await registry.getAddress(), agency.address, 60 * DAY, 1, ethers.id('budget'), 'bafyBudgetSpec'],
  );
  await wait(vote.createPoll(seasonedGroup, 35 * DAY, 3, 2, 2, data, 'bafyQuestion', 0));
  const pollId = await vote.pollCount();

  // The newcomer's 30-day seasoning ends while the poll is open. Joining the
  // electorate mid-poll must not count: the poll froze its voter list at creation.
  await advance(31 * DAY);
  await wait(identity.season(newcomer.commitment));
  await assert.rejects(buildBallot({ provider, vote, pollId, identity: newcomer, option: 0 }), /not eligible/);

  // Four residents vote YES/NO through the relayer; none of them has a wallet.
  const choices = [0, 0, 0, 1];
  for (const [i, option] of choices.entries()) {
    const ballot = await buildBallot({ provider, vote, pollId, identity: residents[i], option });
    const r = await post('/ballot', { pollId: pollId.toString(), ballot });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }

  // Same resident again: same nullifier -> rejected.
  const again = await buildBallot({ provider, vote, pollId, identity: residents[0], option: 1 });
  assert.equal((await post('/ballot', { pollId: pollId.toString(), ballot: again })).status, 409);

  // Tampering with the choice breaks the proof.
  const forged = await buildBallot({ provider, vote, pollId, identity: residents[4], option: 1 });
  forged.message = '0';
  const fr = await post('/ballot', { pollId: pollId.toString(), ballot: forged });
  assert.equal(fr.status, 422);
  assert.equal(fr.json.error, 'InvalidProof');

  // A proof built for a different group snapshot is rejected.
  const other = new Group([residents[4].commitment, newcomer.commitment]);
  const { generateProof } = require('@semaphore-protocol/proof');
  const scope = await vote.scopeOf(pollId);
  const dir = process.env.SEMAPHORE_ARTIFACTS_DIR;
  const p = await generateProof(residents[4], other, 0, scope, 1, { wasm: `${dir}/semaphore-1.wasm`, zkey: `${dir}/semaphore-1.zkey` });
  const wr = await post('/ballot', { pollId: pollId.toString(), ballot: p });
  assert.equal(wr.json.error, 'WrongRoot');

  assert.deepEqual((await vote.tally(pollId)).map(Number), [3, 1]);
  const summary = await (await fetch(`${relayerUrl}/poll/${pollId}`)).json();
  assert.equal(summary.electorate, '5');

  await advance(4 * DAY);
  await wait(vote.finalize(pollId));
  const poll = await vote.getPoll(pollId);
  assert.equal(poll.passed, true);
  assert.equal(await registry.mandateCount(), 1n); // the public vote created the mandate
  assert.equal(await registry.responsibleOf(1n), agency.address);
});

test('vote: bonds - anyone may propose by locking capital; refunded only if quorum is reached', async () => {
  const basicGroup = await identity.groupId(0);
  await wait(credits.mint(outsider.address, E(1000)));
  await wait(credits.connect(outsider).approve(await vote.getAddress(), ethers.MaxUint256));
  await reverts(() => vote.connect(outsider).createPoll.staticCall(basicGroup, DAY, 2, 3, 0, '0x', 'bafyQ', E(10)), 'BondTooLow');

  // Advisory 3-option poll that nobody votes in -> bond forfeited.
  await wait(vote.connect(outsider).createPoll(basicGroup, DAY, 2, 3, 0, '0x', 'bafyIgnored', E(100)));
  const ignored = await vote.pollCount();
  // Poll that reaches quorum -> bond returned.
  await wait(vote.connect(outsider).createPoll(basicGroup, DAY, 2, 3, 0, '0x', 'bafyPopular', E(100)));
  const popular = await vote.pollCount();
  for (const [i, who] of [residents[0], lateJoiner].entries()) {
    const ballot = await buildBallot({ provider, vote, pollId: popular, identity: who, option: i + 1 });
    assert.equal((await post('/ballot', { pollId: popular.toString(), ballot })).status, 200);
  }
  await advance(DAY);
  const t0 = await credits.balanceOf(treasury.address);
  const o0 = await credits.balanceOf(outsider.address);
  await wait(vote.finalize(ignored));
  await wait(vote.finalize(popular));
  assert.equal((await credits.balanceOf(treasury.address)) - t0, E(100));
  assert.equal((await credits.balanceOf(outsider.address)) - o0, E(100));
});

test('identity: revoke frees the document for re-enrolment on a new device', async () => {
  // Rebuild each group off-chain to get Merkle siblings for removal.
  const siblings = [];
  for (const t of [0, 1, 2]) {
    const gid = await identity.groupId(t);
    const logs = await semaphore.queryFilter(semaphore.filters.MemberAdded(gid));
    const group = new Group(logs.map((l) => l.args.identityCommitment));
    const idx = group.indexOf(residents[4].commitment);
    siblings.push(idx === -1 ? [] : group.generateMerkleProof(idx).siblings);
  }
  await reverts(() => identity.connect(phoneCheck).revoke.staticCall(residents[4].commitment, siblings), 'NotAuthorized');
  await wait(identity.connect(clerk).revoke(residents[4].commitment, siblings));
  const replacement = new Identity('resident-4-new-phone');
  await wait(identity.connect(clerk).enroll(replacement.commitment, 1, docHash('DL-4'), 1));
  assert.equal((await identity.members(replacement.commitment)).tier, 2n); // residency carried over -> seasoned
});

test('vote: residents veto a market PASS; a too-late veto is recorded as failed without trapping anything', async () => {
  const mkt = await deploy('DecisionMarket', {}, admin.address, await credits.getAddress(), ethers.ZeroAddress);
  await wait(mkt.grantRole(await mkt.CREATOR_ROLE(), admin.address));
  await wait(mkt.grantRole(await mkt.VETO_ROLE(), await vote.getAddress())); // the people hold the veto
  await wait(credits.mint(admin.address, E(1000)));
  await wait(credits.approve(await mkt.getAddress(), ethers.MaxUint256));
  const params = (vetoWindow) => ({
    proposalCID: 'bafyP', metricCID: 'bafyM', tradingDuration: DAY, vetoWindow, marginBps: 0, liquidity: E(100), maxStake: E(500),
    responsible: ethers.ZeroAddress, mandateDuration: 0, verifierThreshold: 0, category: ethers.ZeroHash, mandateSpecCID: '',
  });
  // Two markets with equal prices -> PASS (margin 0). One with a long veto window, one short.
  await wait(mkt.createMarket(params(5 * DAY)));
  await wait(mkt.createMarket(params(DAY)));
  await advance(DAY);
  await wait(mkt.close(1n));
  await wait(mkt.close(2n));

  const seasonedGroup = await identity.groupId(2);
  const mktAddr = await mkt.getAddress();
  const encode = (id) => ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [mktAddr, id]);
  await wait(vote.createPoll(seasonedGroup, 2 * DAY, 2, 2, 1 /* VetoMarket */, encode(1n), 'bafyVeto1', 0));
  const p1 = await vote.pollCount();
  await wait(vote.createPoll(seasonedGroup, 2 * DAY, 2, 2, 1, encode(2n), 'bafyVeto2', 0));
  const p2 = await vote.pollCount();
  for (const pid of [p1, p2]) {
    for (const r of residents.slice(0, 2)) {
      const ballot = await buildBallot({ provider, vote, pollId: pid, identity: r, option: 0 });
      assert.equal((await post('/ballot', { pollId: pid.toString(), ballot })).status, 200);
    }
  }
  await advance(2 * DAY);
  const rc1 = await wait(vote.finalize(p1));
  const rc2 = await wait(vote.finalize(p2));
  const names = (rc) => rc.logs.map((l) => { try { return vote.interface.parseLog(l)?.name; } catch { return null; } });
  assert.ok(names(rc1).includes('ActionExecuted'));
  assert.ok(names(rc2).includes('ActionFailed')); // market 2's 1-day veto window had closed
  assert.equal((await mkt.getMarket(1n)).vetoed, true);
  assert.equal((await mkt.getMarket(2n)).vetoed, false);
});

test('vote: a member revoked after a poll opens does not break other voters (snapshot rewind)', async () => {
  const verifiedGroup = await identity.groupId(1);
  await wait(vote.createPoll(verifiedGroup, 2 * DAY, 1, 2, 0, '0x', 'bafyRewind', 0));
  const pollId = await vote.pollCount();

  // Revoke resident 3 after the snapshot (e.g. they moved away mid-poll).
  const siblings = [];
  for (const t of [0, 1, 2]) {
    const gid = await identity.groupId(t);
    const added = await semaphore.queryFilter(semaphore.filters.MemberAdded(gid));
    const removed = await semaphore.queryFilter(semaphore.filters.MemberRemoved(gid));
    const group = new Group(added.map((l) => l.args.identityCommitment));
    for (const r of removed) group.removeMember(Number(r.args.index));
    const idx = group.indexOf(residents[3].commitment);
    siblings.push(idx === -1 ? [] : group.generateMerkleProof(idx).siblings);
  }
  await wait(identity.connect(clerk).revoke(residents[3].commitment, siblings));

  // Resident 2's app must rewind that removal to rebuild the frozen list and prove membership.
  const ballot = await buildBallot({ provider, vote, pollId, identity: residents[2], option: 1 });
  assert.equal((await post('/ballot', { pollId: pollId.toString(), ballot })).status, 200);
  assert.deepEqual((await vote.tally(pollId)).map(Number), [0, 1]);
});

test('identity: a sign-in account can enrol only one person (basic tier)', async () => {
  const acct = ethers.keccak256(ethers.toUtf8Bytes('hmac(google:1234567890)'));
  const a = new Identity('signin-a');
  const b = new Identity('signin-b');
  await wait(identity.connect(phoneCheck).enroll(a.commitment, 0, acct, 0));
  assert.equal(await identity.commitmentOfAccount(acct), a.commitment);
  await reverts(() => identity.connect(phoneCheck).enroll.staticCall(b.commitment, 0, acct, 0), 'AccountAlreadyUsed');
  // Without an account fingerprint, basic enrolment still works (e.g. a phone check).
  await wait(identity.connect(phoneCheck).enroll(b.commitment, 0, ethers.ZeroHash, 0));
});

test('vote: cross-checked poll - when ID-checked residents disagree with everyone, the result is held', async () => {
  // Four people who only signed up online (basic tier) and the ID-checked residents vote in one poll.
  const online = Array.from({ length: 4 }, (_, i) => new Identity(`online-only-${i}`));
  for (const [i, o] of online.entries()) await wait(identity.connect(phoneCheck).enroll(o.commitment, 0, docHash(`account-${i}`), 0));
  const everyone = await identity.groupId(0);
  const checked = await identity.groupId(1);
  const data = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint64', 'uint16', 'bytes32', 'string'],
    [await registry.getAddress(), agency.address, 60 * DAY, 1, ethers.id('parks'), 'bafyParksSpec'],
  );
  await reverts(() => vote.createCheckedPoll.staticCall(everyone, everyone, 2, 7 * DAY, 3, 2, data, 'bafyCheckedQ', 0), 'InvalidParams');
  const mandatesBefore = await registry.mandateCount();
  await wait(vote.createCheckedPoll(everyone, checked, 2, 7 * DAY, 3, 2, data, 'bafyCheckedQ', 0));
  const pollId = await vote.pollCount();
  const [ck] = await vote.getCheck(pollId);
  assert.equal(ck.groupId, checked);

  // Online-only members vote Yes; three ID-checked residents vote No. Each person votes once.
  for (const o of online) assert.equal((await post('/ballot', { pollId: pollId.toString(), ballot: await buildBallot({ provider, vote, pollId, identity: o, option: 0 }) })).status, 200);
  for (const r of residents.slice(0, 3)) assert.equal((await post('/ballot', { pollId: pollId.toString(), ballot: await buildBallot({ provider, vote, pollId, identity: r, option: 1 }) })).status, 200);
  // A checked resident can't vote a second time through the wider list: same person, same nullifier.
  const { generateProof } = require('@semaphore-protocol/proof');
  const wide = new Group();
  for (let i = 0; i < Number((await vote.getPoll(pollId)).electorate); i++) {
    const [[cm]] = await identity.leaves(0, i, 1);
    wide.addMember(cm);
  }
  const dir = process.env.SEMAPHORE_ARTIFACTS_DIR;
  const depth = Math.max(wide.depth, 1);
  const twice = await generateProof(residents[0], wide, 0, await vote.scopeOf(pollId), depth, { wasm: `${dir}/semaphore-${depth}.wasm`, zkey: `${dir}/semaphore-${depth}.zkey` });
  assert.equal((await post('/ballot', { pollId: pollId.toString(), ballot: twice })).status, 409);

  assert.deepEqual((await vote.tally(pollId)).map(Number), [4, 3]); // Yes would win overall
  const [, counts] = await vote.getCheck(pollId);
  assert.deepEqual(counts.map(Number), [0, 3]); // ...but every ID-checked voter said No

  await advance(8 * DAY);
  const rc = await wait(vote.finalize(pollId));
  const disputed = rc.logs.map((l) => { try { return vote.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'PollDisputed');
  assert.deepEqual([disputed.args.yes, disputed.args.no, disputed.args.checkYes, disputed.args.checkNo].map(Number), [4, 3, 0, 3]);
  assert.equal((await vote.getPoll(pollId)).passed, false);
  assert.equal((await vote.getCheck(pollId))[0].disputed, true);
  assert.equal(await registry.mandateCount(), mandatesBefore); // the binding action did not run

  // When both agree, a cross-checked poll passes and acts as usual.
  await wait(vote.createCheckedPoll(everyone, checked, 2, 7 * DAY, 3, 2, data, 'bafyCheckedQ2', 0));
  const agreed = await vote.pollCount();
  for (const v of [...online.slice(0, 2), ...residents.slice(0, 3)]) await post('/ballot', { pollId: agreed.toString(), ballot: await buildBallot({ provider, vote, pollId: agreed, identity: v, option: 0 }) });
  await advance(8 * DAY);
  await wait(vote.finalize(agreed));
  assert.equal((await vote.getPoll(agreed)).passed, true);
  assert.equal((await vote.getCheck(agreed))[0].disputed, false);
  assert.equal(await registry.mandateCount(), mandatesBefore + 1n);
});
