// Civic credits: anonymous quadratic allocations in participatory-budgeting rounds, real proofs.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Identity } = require('@semaphore-protocol/identity');
const { deployAll } = require('../scripts/deploy');
const { buildAllocation } = require('../client/budget');
const { createRelayer } = require('../broker/relayer');

process.env.SEMAPHORE_ARTIFACTS_DIR = path.dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json'));
const DAY = 86_400;
let provider, admin, clerk, relayKey, c, relay, relayUrl;
const people = Array.from({ length: 5 }, (_, i) => new Identity(`budget-resident-${i}`));
const outsider = new Identity('budget-outsider');
const send = async (p) => (await p).wait();
const revertName = async (p) => {
  try {
    await p;
  } catch (e) {
    try {
      return c.budget.interface.parseError(e.data)?.name || e.revert?.name;
    } catch {
      return e.revert?.name || e.shortMessage;
    }
  }
  return 'no revert';
};
const post = async (body) => {
  const r = await fetch(`${relayUrl}/allocation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) });
  return { status: r.status, ...(await r.json()) };
};

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 4, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, clerk, relayKey] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  ({ contracts: c } = await deployAll(admin, { rules: { MIN_POLL_MINUTES: 60 } }));
  await send(c.identity.setIssuer(clerk.address, 1, true, 'Clerk'));
  const longAgo = (await provider.getBlock('latest')).timestamp - 3 * 365 * DAY;
  for (const [i, p] of people.entries()) await send(c.identity.connect(clerk).enroll(p.commitment, 1, ethers.id(`doc-b${i}`), longAgo));
  relay = createRelayer({ provider, signer: relayKey, voteAddress: await c.vote.getAddress(), budgetAddress: await c.budget.getAddress(), log: () => {} });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  relayUrl = `http://127.0.0.1:${relay.address().port}`;
});

after(async () => {
  relay?.closeAllConnections();
  await new Promise((r) => relay.close(r));
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('a budget round: quadratic credits, anonymous and once per person, funded from most votes down', async () => {
  const full = await c.identity.groupId(2);
  const refs = ['Repave Oak Street', 'Library Sunday hours', 'New playground'];
  const costs = [50_000, 30_000, 40_000];
  assert.equal(await revertName(c.budget.createRound.staticCall(full, 30 * 60, 9, 80_000, 'Spring 2027', refs, costs)), 'RoundTooShort'); // the charter's shortest poll
  assert.equal(await revertName(c.budget.connect(clerk).createRound.staticCall(full, 7 * DAY, 9, 80_000, 'Spring 2027', refs, costs)), 'AccessControlUnauthorizedAccount');
  await send(c.budget.createRound(full, 7 * DAY, 9, 80_000, 'Spring 2027', refs, costs));
  const id = await c.budget.roundCount();

  // 9 credits each: 3 votes on one proposal (9), or 2 + 2 + 1 (9). 3 + 1 would cost 10.
  const plan = [[3, 0, 0], [3, 0, 0], [0, 2, 2], [0, 2, 2], [1, 2, 0]];
  for (const [i, votes] of plan.entries()) {
    const a = await buildAllocation({ provider, budget: c.budget, roundId: id, identity: people[i], votes });
    assert.equal((await post({ roundId: id, allocation: a })).status, 200);
  }
  await assert.rejects(buildAllocation({ provider, budget: c.budget, roundId: id, identity: people[0], votes: [3, 1, 0] }), /cost 10 credits/);
  // Once per person, and the votes can't be altered after proving.
  const again = await buildAllocation({ provider, budget: c.budget, roundId: id, identity: people[0], votes: [0, 0, 3] });
  assert.equal((await post({ roundId: id, allocation: again })).status, 409);
  const forged = await buildAllocation({ provider, budget: c.budget, roundId: id, identity: outsider, votes: [0, 0, 0] }).catch((e) => e.message);
  assert.match(forged, /not eligible/);
  const proof = await buildAllocation({ provider, budget: c.budget, roundId: id, identity: people[4], votes: [0, 0, 3] });
  proof.votes = [3, 0, 0];
  assert.equal(await revertName(c.budget.allocate.staticCall(id, proof)), 'NullifierUsed'); // already allocated...

  const [, , votes] = await c.budget.getProposals(id);
  assert.deepEqual(votes.map(Number), [7, 6, 4]); // Oak 3+3+1, Library 2+2+2, Playground 2+2
  assert.equal(await revertName(c.budget.finalize.staticCall(id)), 'StillOpen');
  await provider.send('evm_increaseTime', [7 * DAY + 1]);
  await provider.send('evm_mine', []);
  await send(c.budget.finalize(id));
  const r = await c.budget.getRound(id);
  // Oak (50k) then Library (30k) fill the 80k budget; the playground no longer fits.
  assert.equal(r.fundedMask, 0b011n);
  assert.equal(r.spent, 80_000n);
  assert.equal(r.participants, 5n);
});

test('allocations are bound to their votes: changing them breaks the proof', async () => {
  const full = await c.identity.groupId(2);
  await send(c.budget.createRound(full, DAY, 4, 10, 'Quick round', ['A', 'B'], [5, 5]));
  const id = await c.budget.roundCount();
  const a = await buildAllocation({ provider, budget: c.budget, roundId: id, identity: people[0], votes: [2, 0] });
  a.votes = [0, 2];
  assert.equal(await revertName(c.budget.allocate.staticCall(id, a)), 'InvalidProof');
  a.votes = [2, 1];
  assert.equal(await revertName(c.budget.allocate.staticCall(id, a)), 'OverBudget');
});
