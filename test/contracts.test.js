// Contract tests on an in-process EVM (ganache). Run: npm test
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const ganache = require('ganache');
const { ethers } = require('ethers');

const art = (n) => require(`../build/${n}.json`);
const E = (n) => ethers.parseEther(String(n));
const DAY = 86_400;
// Gas is estimated one block before execution; TWAP accrual can then add a storage write.
const GAS = { gasLimit: 800_000 };

let provider, signers, admin, treasury, agency, v1, v2, v3, alice, bob, carol;

before(async () => {
  const g = ganache.provider({
    logging: { quiet: true },
    wallet: { totalAccounts: 10, defaultBalance: 1_000_000 },
    chain: { hardfork: 'shanghai' },
  });
  provider = new ethers.BrowserProvider(g, undefined, { cacheTimeout: -1 });
  signers = await Promise.all([...Array(10).keys()].map((i) => provider.getSigner(i)));
  [admin, treasury, agency, v1, v2, v3, alice, bob, carol] = signers;
});

async function deploy(name, ...args) {
  const { abi, bytecode } = art(name);
  const c = await new ethers.ContractFactory(abi, bytecode, admin).deploy(...args);
  return c.waitForDeployment();
}
const wait = (p) => p.then((tx) => tx.wait());
async function reverts(fn, name) {
  try {
    await fn();
  } catch (e) {
    if (name) assert.equal(e.revert?.name ?? decodeError(e), name, e.shortMessage || e.message);
    return;
  }
  assert.fail(`expected revert ${name || ''}`);
}
// Deployment reverts are not decoded by ethers; decode them against all artifacts.
function decodeError(e) {
  const data = e.data ?? e.info?.error?.data;
  if (!data) return undefined;
  for (const n of ['MandateRegistry', 'BudgetEscrow', 'DecisionMarket', 'PlayCredits']) {
    try {
      const parsed = new ethers.Interface(art(n).abi).parseError(data);
      if (parsed) return parsed.name;
    } catch { /* try next */ }
  }
  return undefined;
}
async function now() {
  return (await provider.getBlock('latest')).timestamp;
}
async function advance(seconds) {
  await provider.send('evm_increaseTime', [seconds]);
  await provider.send('evm_mine', []);
}

async function registryWithVerifiers() {
  const reg = await deploy('MandateRegistry', admin.address);
  const GOV = await reg.GOVERNOR_ROLE();
  const VER = await reg.VERIFIER_ROLE();
  await wait(reg.grantRole(GOV, admin.address));
  for (const v of [v1, v2, v3]) await wait(reg.grantRole(VER, v.address));
  return reg;
}
async function newMandate(reg, days = 30, threshold = 2) {
  const deadline = (await now()) + days * DAY;
  const tx = await reg.createMandate(agency.address, deadline, threshold, ethers.id('records'), 'bafySpec');
  const rc = await tx.wait();
  return reg.interface.parseLog(rc.logs.find((l) => l.fragment?.name === 'MandateCreated') || rc.logs[0]).args.id;
}

// --------------------------------------------------------------- registry

test('registry: create, reject, resubmit, fulfil', async () => {
  const reg = await registryWithVerifiers();
  await reverts(async () => reg.createMandate.staticCall(agency.address, (await now()) + DAY, 4, ethers.ZeroHash, 'x'), 'InvalidThreshold');
  await reverts(async () => reg.connect(alice).createMandate.staticCall(agency.address, (await now()) + DAY, 1, ethers.ZeroHash, 'x'));

  const id = await newMandate(reg);
  assert.equal(await reg.statusOf(id), 1n); // Active
  await reverts(() => reg.connect(alice).submitEvidence.staticCall(id, 'bafyEv'), 'NotResponsible');
  await reverts(() => reg.connect(v1).attest.staticCall(id, true, ''), 'WrongStatus');

  await wait(reg.connect(agency).submitEvidence(id, 'bafyEv1'));
  await wait(reg.connect(v1).attest(id, false, 'bafyWhy'));
  await reverts(() => reg.connect(v1).attest.staticCall(id, false, ''), 'AlreadyAttested');
  await wait(reg.connect(v2).attest(id, false, ''));
  assert.equal(await reg.statusOf(id), 1n); // back to Active after 2 rejections

  await wait(reg.connect(agency).submitEvidence(id, 'bafyEv2'));
  await wait(reg.connect(v1).attest(id, true, '')); // new round: v1 may attest again
  assert.equal(await reg.statusOf(id), 2n); // UnderReview
  await wait(reg.connect(v3).attest(id, true, ''));
  assert.equal(await reg.isFulfilled(id), true);
  assert.equal((await reg.getMandate(id)).evidenceCID, 'bafyEv2');
  await reverts(() => reg.cancelMandate.staticCall(id, ''), 'WrongStatus');
});

test('registry: overdue and cancel', async () => {
  const reg = await registryWithVerifiers();
  const id = await newMandate(reg, 1);
  assert.equal(await reg.isOverdue(id), false);
  await advance(DAY + 1);
  assert.equal(await reg.isOverdue(id), true);
  await wait(reg.cancelMandate(id, 'bafyRepeal'));
  assert.equal(await reg.isOverdue(id), false);
  assert.equal(await reg.isCancelled(id), true);
});

// ------------------------------------------------------------------ escrow

test('escrow: decay while overdue, then release on fulfilment', async () => {
  const reg = await registryWithVerifiers();
  const id = await newMandate(reg, 30);
  const esc = await deploy('BudgetEscrow', await reg.getAddress(), id, treasury.address, 500, DAY);

  await wait(esc.depositETH({ value: E(600) }));
  await wait(esc.connect(alice).depositETH({ value: E(400) })); // a citizen backer
  await reverts(() => esc.connect(bob).progressiveDecay.staticCall(), 'NotOverdue');
  await reverts(() => esc.release.staticCall(), 'NotFulfilled');

  await advance(30 * DAY + 1);
  const t0 = await provider.getBalance(treasury.address);
  await wait(esc.connect(bob).progressiveDecay());
  assert.equal(await esc.lockedBalance(), E(950));
  assert.equal((await provider.getBalance(treasury.address)) - t0, E(50));
  await reverts(() => esc.connect(bob).progressiveDecay.staticCall(), 'DecayCooldown');
  await advance(DAY);
  await wait(esc.connect(bob).progressiveDecay());
  assert.equal(await esc.lockedBalance(), E(902.5));

  await wait(reg.connect(agency).submitEvidence(id, 'bafyLate'));
  await wait(reg.connect(v1).attest(id, true, ''));
  await wait(reg.connect(v2).attest(id, true, ''));
  await advance(DAY);
  await reverts(() => esc.progressiveDecay.staticCall(), 'NotOverdue'); // fulfilled stops decay

  const a0 = await provider.getBalance(agency.address);
  await wait(esc.connect(bob).release());
  assert.equal((await provider.getBalance(agency.address)) - a0, E(902.5));
  await reverts(() => esc.depositETH.staticCall({ value: 1 }), 'NotOpen');
});

test('escrow: cancelled mandate refunds backers pro rata', async () => {
  const reg = await registryWithVerifiers();
  const id = await newMandate(reg, 1);
  const esc = await deploy('BudgetEscrow', await reg.getAddress(), id, treasury.address, 1000, DAY);
  await wait(esc.connect(alice).depositETH({ value: E(300) }));
  await wait(esc.connect(bob).depositETH({ value: E(100) }));
  await advance(DAY + 1);
  await wait(esc.connect(carol).progressiveDecay()); // 10% -> 360 left
  await wait(reg.cancelMandate(id, 'bafyRepeal'));
  await reverts(() => esc.connect(alice).claimRefund.staticCall(), 'NotCancelled');
  await wait(esc.openRefunds());
  assert.equal(await esc.connect(alice).claimRefund.staticCall(), E(270));
  assert.equal(await esc.connect(bob).claimRefund.staticCall(), E(90));
  await wait(esc.connect(alice).claimRefund());
  await reverts(() => esc.connect(alice).claimRefund.staticCall(), 'NothingToRefund');
  await reverts(() => esc.connect(carol).claimRefund.staticCall(), 'NothingToRefund');
});

test('escrow: rejects bad params, closed mandates and mixed assets', async () => {
  const reg = await registryWithVerifiers();
  const id = await newMandate(reg);
  const { abi, bytecode } = art('BudgetEscrow');
  const F = new ethers.ContractFactory(abi, bytecode, admin);
  await reverts(async () => admin.call(await F.getDeployTransaction(await reg.getAddress(), id, treasury.address, 6000, DAY)), 'InvalidDecayParams');
  await reverts(async () => admin.call(await F.getDeployTransaction(await reg.getAddress(), 999, treasury.address, 500, DAY)), 'MandateClosed');
  const esc = await deploy('BudgetEscrow', await reg.getAddress(), id, treasury.address, 500, DAY);
  await wait(esc.depositETH({ value: E(1) }));
  const tok = await deploy('PlayCredits', admin.address);
  await wait(tok.mint(admin.address, E(10)));
  await wait(tok.approve(await esc.getAddress(), E(10)));
  await reverts(async () => esc.depositToken.staticCall(await tok.getAddress(), E(1)), 'AssetMismatch');
  await reverts(() => admin.sendTransaction({ to: esc.target, value: 1 }).then((t) => t.wait()));
});

// ------------------------------------------------------------------ market

async function marketSetup({ withRegistry = true } = {}) {
  const reg = await registryWithVerifiers();
  const credits = await deploy('PlayCredits', admin.address);
  const mkt = await deploy('DecisionMarket', admin.address, await credits.getAddress(), withRegistry ? await reg.getAddress() : ethers.ZeroAddress);
  await wait(mkt.grantRole(await mkt.CREATOR_ROLE(), admin.address));
  await wait(mkt.grantRole(await mkt.RESOLVER_ROLE(), admin.address));
  await wait(mkt.grantRole(await mkt.VETO_ROLE(), carol.address)); // stands in for the ratification vote
  await wait(reg.grantRole(await reg.GOVERNOR_ROLE(), await mkt.getAddress()));
  await wait(credits.mint(admin.address, E(10_000)));
  await wait(credits.approve(await mkt.getAddress(), ethers.MaxUint256));
  for (const s of [alice, bob]) {
    await wait(credits.connect(s).claim());
    await wait(credits.connect(s).approve(await mkt.getAddress(), ethers.MaxUint256));
  }
  return { reg, credits, mkt };
}
const params = (o = {}) => ({
  proposalCID: 'bafyProposal',
  metricCID: 'bafyMetric',
  tradingDuration: 3 * DAY,
  vetoWindow: DAY,
  marginBps: 200,
  liquidity: E(100),
  maxStake: E(500),
  responsible: agency.address,
  mandateDuration: 30 * DAY,
  verifierThreshold: 2,
  category: ethers.id('policy'),
  mandateSpecCID: 'bafyMandateSpec',
  ...o,
});

test('market: PASS wins, survives veto window, creates mandate, settles', async () => {
  const { reg, credits, mkt } = await marketSetup();
  await wait(mkt.createMarket(params()));
  const id = 1n;
  assert.equal(await mkt.priceYes(id, 0), E(0.5));

  const q = await mkt.quoteBuy(id, 0, true, E(100));
  await wait(mkt.connect(alice).buy(id, 0, true, E(100), q, GAS)); // PASS/YES
  assert.ok((await mkt.priceYes(id, 0)) > E(0.5));
  await wait(mkt.connect(bob).buy(id, 1, false, E(50), 0, GAS)); // FAIL/NO
  await reverts(() => mkt.connect(alice).buy.staticCall(id, 0, true, E(401), 0), 'StakeCapExceeded');
  await reverts(() => mkt.close.staticCall(id), 'TradingOpen');

  await advance(3 * DAY);
  await reverts(() => mkt.connect(alice).buy.staticCall(id, 0, true, E(1), 0), 'TradingClosed');
  await wait(mkt.close(id));
  let m = await mkt.getMarket(id);
  assert.equal(m.chosen, 0n);
  assert.ok(m.twapPass > m.twapFail);
  await reverts(() => mkt.execute.staticCall(id), 'VetoWindowOpen');
  await advance(DAY);
  await reverts(() => mkt.connect(carol).veto.staticCall(id), 'VetoWindowClosed');
  await wait(mkt.execute(id));
  m = await mkt.getMarket(id);
  assert.equal(m.mandateId, 1n);
  assert.equal(await reg.responsibleOf(1n), agency.address);

  // Bob's FAIL-branch stake is void -> refunded now.
  const b0 = await credits.balanceOf(bob.address);
  await wait(mkt.connect(bob).claim(id));
  assert.equal((await credits.balanceOf(bob.address)) - b0, E(50));
  await reverts(() => mkt.connect(alice).claim.staticCall(id), 'NothingToClaim'); // not resolved yet

  await wait(mkt.resolveMetric(id, true));
  const shares = (await mkt.getPosition(id, alice.address, 0)).yes;
  const a0 = await credits.balanceOf(alice.address);
  await wait(mkt.connect(alice).claim(id));
  assert.equal((await credits.balanceOf(alice.address)) - a0, shares);
  assert.ok(shares > E(100)); // bought below 1.0, paid 1.0 per share

  await wait(mkt.withdrawLiquidity(id));
  assert.equal(await credits.balanceOf(await mkt.getAddress()), 0n); // fully solvent, nothing stranded
});

test('market: public veto overturns PASS, FAIL branch settles, no mandate', async () => {
  const { reg, credits, mkt } = await marketSetup();
  await wait(mkt.createMarket(params()));
  const id = 1n;
  await wait(mkt.connect(alice).buy(id, 0, true, E(200), 0, GAS));
  await wait(mkt.connect(bob).buy(id, 1, true, E(30), 0, GAS)); // FAIL/YES
  await advance(3 * DAY);
  await wait(mkt.close(id));
  await reverts(() => mkt.connect(alice).veto.staticCall(id)); // not VETO_ROLE
  await wait(mkt.connect(carol).veto(id));
  await advance(DAY);
  await wait(mkt.execute(id));
  const m = await mkt.getMarket(id);
  assert.equal(m.chosen, 1n);
  assert.equal(m.vetoed, true);
  assert.equal(await reg.mandateCount(), 0n);

  await wait(mkt.resolveMetric(id, false)); // metric missed in the FAIL world
  const a0 = await credits.balanceOf(alice.address);
  await wait(mkt.connect(alice).claim(id)); // PASS branch void -> full refund
  assert.equal((await credits.balanceOf(alice.address)) - a0, E(200));
  await reverts(() => mkt.connect(bob).claim.staticCall(id), 'NothingToClaim'); // bob held FAIL/YES, metric missed
  await wait(mkt.withdrawLiquidity(id));
  assert.equal(await credits.balanceOf(await mkt.getAddress()), 0n);
});

test('market: margin keeps ties at FAIL; advisory-only mode needs no registry', async () => {
  const { mkt } = await marketSetup({ withRegistry: false });
  await wait(mkt.createMarket(params({ responsible: ethers.ZeroAddress, mandateSpecCID: '' })));
  await advance(3 * DAY);
  await wait(mkt.close(1n));
  assert.equal((await mkt.getMarket(1n)).chosen, 1n); // equal prices, PASS needs a 2% edge
  await advance(DAY);
  await wait(mkt.execute(1n));
  assert.equal((await mkt.getMarket(1n)).mandateId, 0n);
});

test('play credits: faucet cooldown', async () => {
  const credits = await deploy('PlayCredits', admin.address);
  await wait(credits.connect(alice).claim());
  await reverts(() => credits.connect(alice).claim.staticCall(), 'FaucetCooldown');
  await advance(7 * DAY);
  await wait(credits.connect(alice).claim());
  assert.equal(await credits.balanceOf(alice.address), E(2000));
});
