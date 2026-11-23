// Helping everyone take part: discussion ranked by arguments people on both sides find
// helpful, and citizens' assemblies drawn at random from the voter list (real proofs).
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Identity } = require('@semaphore-protocol/identity');
const { Group } = require('@semaphore-protocol/group');
const { deployAll } = require('../scripts/deploy');
const { commentProof, markProof, topicOf, bridgeScore } = require('../client/feedback');
const { candidateAt, drawOrder, acceptCode, checkAcceptCode, endorseCode, checkEndorsements } = require('../client/assembly');

process.env.SEMAPHORE_ARTIFACTS_DIR = path.dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json'));
let provider, admin, clerk, stranger, c;
const residents = Array.from({ length: 8 }, (_, i) => new Identity(`part-resident-${i}`));
const send = async (p) => (await p).wait();
const errName = async (p) => {
  try {
    await p;
  } catch (e) {
    for (const k of [c.feedback, c.assemblies]) {
      try {
        const n = k.interface.parseError(e.data)?.name;
        if (n) return n;
      } catch {
        /* next */
      }
    }
    return e.revert?.name || e.shortMessage;
  }
  return 'no revert';
};
const mine = async (n) => {
  for (let i = 0; i < n; i++) await provider.send('evm_mine', []);
};

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 4, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, clerk, stranger] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  ({ contracts: c } = await deployAll(admin, {}));
  await send(c.identity.setIssuer(clerk.address, 1, true, 'Clerk'));
  const longAgo = (await provider.getBlock('latest')).timestamp - 3 * 365 * 86_400;
  for (const [i, r] of residents.entries()) await send(c.identity.connect(clerk).enroll(r.commitment, 1, ethers.id(`part-doc-${i}`), longAgo));
});
after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('bridging rank: an argument only one side likes ranks below one both sides find helpful', () => {
  // counts by lean*2 + helpful: [undecided no, undecided yes, for no, for yes, against no, against yes]
  const oneSided = bridgeScore([0, 0, 0, 9, 8, 1]);
  const bridging = bridgeScore([0, 1, 1, 4, 1, 4]);
  assert.ok(bridging.score > oneSided.score);
  assert.equal(bridging.bothSides, true);
  assert.equal(oneSided.bothSides, false);
  assert.equal(bridgeScore([0, 0, 0, 0, 0, 0]).score, 0);
  assert.deepEqual([bridging.marks, bridging.helpful], [11, 9]);
});

test('helpful marks: anonymous, once per person per comment, counted by stated lean', async () => {
  const topic = topicOf('poll', 1);
  const ref = 'nb:0x' + 'a'.repeat(64);
  await send(c.feedback.comment(topic, 2, ref, await commentProof({ provider, feedback: c.feedback, identity: residents[0], tier: 2, topic, ref })));
  const mark = async (who, lean, helpful) => markProof({ provider, feedback: c.feedback, identity: residents[who], tier: 2, topic, index: 0, lean, helpful });
  await send(c.feedback.mark(topic, 0, 1, true, 2, await mark(1, 1, true)));
  await send(c.feedback.mark(topic, 0, 2, true, 2, await mark(2, 2, true)));
  await send(c.feedback.mark(topic, 0, 2, false, 2, await mark(3, 2, false)));
  const [m] = await c.feedback.marks(topic, 0, 10);
  assert.deepEqual(m.map(Number), [0, 0, 0, 1, 1, 1]);
  const again = await mark(1, 2, false);
  assert.equal(await errName(c.feedback.mark.staticCall(topic, 0, 2, false, 2, again)), 'NullifierUsed'); // once per person, whatever they claim
  assert.equal(await errName(c.feedback.mark.staticCall(topic, 0, 1, true, 2, await mark(4, 2, true))), 'WrongMessage'); // the lean is sealed in the proof
  assert.equal(await errName(c.feedback.mark.staticCall(topic, 5, 1, true, 2, await mark(4, 1, true))), 'BadMark'); // no such comment
});

test("citizens' assembly: announced first, drawn from a block nobody knew, redone by anyone", async () => {
  const k = c.assemblies;
  assert.equal(await errName(k.connect(stranger).announce.staticCall(2, 3, 30, 'nb:q')), 'AccessControlUnauthorizedAccount');
  assert.equal(await errName(k.announce.staticCall(2, 3, 5, 'nb:q')), 'BadParams'); // too soon to be unknown
  assert.equal(await errName(k.announce.staticCall(2, 9, 30, 'nb:q')), 'BadParams'); // more seats than people

  // Someone removed before the announcement is never drawn.
  const leaves = (await c.identity.leaves(2, 0, 100))[0];
  const gone = residents[7].commitment;
  const siblings = [0, 1, 2].map((t) => {
    const g = new Group(leaves);
    return g.generateMerkleProof(g.indexOf(gone)).siblings;
  });
  await send(c.identity.connect(clerk).revoke(gone, siblings));

  await send(k.announce(2, 3, 30, 'nb:q'));
  const id = await k.assemblyCount();
  assert.equal(await errName(k.draw.staticCall(id)), 'TooEarly');
  await mine(31);
  // The relay runs draws as soon as they are due (anyone may), so nobody can wait one out.
  const { runDueDraws } = require('../broker/draws');
  assert.equal(await runDueDraws({ signer: stranger, cfg: { assembliesAddress: await k.getAddress() } }), 1);
  assert.equal(await errName(k.draw.staticCall(id)), 'AlreadyDrawn');
  const a = await k.getAssembly(id);
  for (const step of [0, 1, 7]) assert.equal(await k.candidate(id, step), candidateAt(a.seed, step, a.size));

  const order = await drawOrder({ assemblies: k, provider, id });
  assert.equal(order.length, 7); // 3 seats x 5, capped at the 7 people still on the list
  assert.equal(new Set(order.map((o) => o.leafIndex)).size, 7);
  assert.ok(!order.some((o) => o.commitment === gone));

  // A drawn resident's seat code: only they can make it, and the organizer's app checks it.
  const net = await provider.getNetwork();
  const where = { chainId: net.chainId, address: await k.getAddress() };
  const first = order[0];
  const holder = residents.find((r) => r.commitment === first.commitment);
  const code = acceptCode(holder, { ...where, id, position: first.position });
  assert.deepEqual(checkAcceptCode(code, { ...where, order }), { ok: true, id, position: 0 });
  const other = residents.find((r) => r.commitment === order[1].commitment);
  assert.equal(checkAcceptCode(acceptCode(other, { ...where, id, position: 0 }), { ...where, order }).ok, false); // not theirs
  assert.equal(checkAcceptCode('PA1.nonsense', { ...where, order }).ok, false);

  assert.equal(await errName(k.connect(stranger).acceptSeat.staticCall(id, 0)), 'NotOrganizer');
  for (const p of [0, 1]) await send(k.acceptSeat(id, p));
  // A seat left open goes to the alternates strictly in draw order, after the first choices' week.
  assert.equal(await errName(k.acceptSeat.staticCall(id, 4)), 'OutOfOrder');
  await provider.send('evm_increaseTime', [7 * 86_400 + 1]);
  await provider.send('evm_mine', []);
  assert.equal(await errName(k.acceptSeat.staticCall(id, 4)), 'OutOfOrder'); // number 4 (position 3) is next
  const skipped = await send(k.skipAlternate(id)); // recorded publicly
  assert.ok(skipped.logs.some((l) => k.interface.parseLog(l)?.name === 'AlternateSkipped'));
  await send(k.acceptSeat(id, 4));
  assert.equal(await errName(k.acceptSeat.staticCall(id, 1)), 'AlreadySeated');
  assert.equal(await errName(k.acceptSeat.staticCall(id, 2)), 'SeatsFull');
  await send(k.report(id, 'nb:recommendation'));
  const done = await k.getAssembly(id);
  assert.deepEqual([Number(done.filled), done.reportRef], [3, 'nb:recommendation']);
});

test("review panel statement: seated members endorse the exact draft, and anyone can count them", async () => {
  const k = c.assemblies;
  const id = 1n; // the assembly above: seats 0, 1 and 4 accepted
  const order = await drawOrder({ assemblies: k, provider, id });
  const net = await provider.getNetwork();
  const where = { chainId: net.chainId, address: await k.getAddress(), id };
  const draft = 'nb:0x' + 'd'.repeat(64);
  const who = (pos) => residents.find((r) => r.commitment === order[pos].commitment);
  const seated = new Set([0, 1, 4].filter((p) => p < order.length));
  const codes = [0, 1, 2].map((pos) => endorseCode(who(pos), { ...where, position: pos, ref: draft }));
  codes.push(endorseCode(who(0), { ...where, position: 0, ref: draft })); // the same member twice counts once
  codes.push(endorseCode(who(1), { ...where, position: 1, ref: 'nb:0x' + 'e'.repeat(64) })); // a different text
  codes.push(endorseCode(who(4), { ...where, position: 0, ref: draft })); // someone else's seat
  const r = checkEndorsements(codes, { ...where, ref: draft, order, seated });
  assert.deepEqual(r.positions, [0, 1]); // position 2 was drawn but never seated
  assert.equal(r.bad.length, 3);
});

test('a draw nobody ran in time is rescheduled to a new future block', async () => {
  const k = c.assemblies;
  await send(k.announce(1, 2, 30, 'nb:q2'));
  const id = await k.assemblyCount();
  assert.equal(await errName(k.reschedule.staticCall(id)), 'TooEarly');
  await mine(31 + 257);
  assert.equal(await errName(k.draw.staticCall(id)), 'Missed');
  await send(k.connect(stranger).reschedule(id));
  await mine(31);
  await send(k.draw(id));
  assert.notEqual((await k.getAssembly(id)).seed, ethers.ZeroHash);
});
