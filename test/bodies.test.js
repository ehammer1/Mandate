// Government bodies and organizations deciding in public: their own rules, agenda notice,
// a residents' vote first, roll-call votes with reasons, executive sign or veto, override.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Identity } = require('@semaphore-protocol/identity');
const { deployAll } = require('../scripts/deploy');
const { buildBallot } = require('../client/ballot');

process.env.SEMAPHORE_ARTIFACTS_DIR = path.dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json'));
const DAY = 86_400;
const MIN = 60;
let provider, admin, alice, mayor, clerk, outsider, members, c;
const residents = Array.from({ length: 4 }, (_, i) => new Identity(`body-resident-${i}`));
const send = async (p) => (await p).wait();
const warp = async (s) => {
  await provider.send('evm_increaseTime', [s]);
  await provider.send('evm_mine', []);
};
const errName = async (p) => {
  try {
    await p;
  } catch (e) {
    for (const k of [c.bodies, c.vote]) {
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
const STAGE = ['None', 'Scheduled', 'Voting', 'AwaitingExecutive', 'Adopted', 'Failed', 'Vetoed', 'OverrideVote', 'Lapsed'];
const stage = async (id) => STAGE[Number((await c.bodies.getMotion(id)).m.stage)];
const YES = 1, NO = 2, ABSTAIN = 3;
const ref = (n) => `nb:0x${String(n).repeat(64).slice(0, 64)}`;

const cityCouncil = (over = {}) => ({
  name: 'Example City Council', kind: 'city council', seats: 5, quorumPct: 60, passPct: 50, passOfSeats: false,
  overridePct: 67, noticeMinutes: 30, voteMinutes: 60, executiveMinutes: 120, executive: mayor.address, silenceApproves: false,
  residentTier: 2, explainDissent: true, reasonsRequired: false, clerk: clerk.address, active: true, ...over,
});
const newBody = async (rules) => {
  const rc = await send(c.bodies.createBody(rules));
  return c.bodies.interface.parseLog(rc.logs.find((l) => l.topics[0] === c.bodies.interface.getEvent('BodyCreated').topicHash)).args.bodyId;
};
const motionOf = (rc) => c.bodies.interface.parseLog(rc.logs.find((l) => l.topics[0] === c.bodies.interface.getEvent('MotionProposed').topicHash)).args.motionId;

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 12, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  const s = await Promise.all(Array.from({ length: 11 }, (_, i) => provider.getSigner(i)));
  [admin, alice, mayor, clerk, outsider] = s;
  members = s.slice(5, 10);
  ({ contracts: c } = await deployAll(admin, { rules: { MIN_POLL_MINUTES: 10, BINDING_QUORUM_PCT: 0 } }));
  await send(c.identity.setIssuer(admin.address, 1, true, 'Clerk'));
  const longAgo = (await provider.getBlock('latest')).timestamp - 3 * 365 * DAY;
  for (const [i, r] of residents.entries()) await send(c.identity.enroll(r.commitment, 1, ethers.id(`body-doc-${i}`), longAgo));
});

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('each body sets its own rules, within fixed limits; only registrars create and seat', async () => {
  assert.equal(await errName(c.bodies.connect(outsider).createBody.staticCall(cityCouncil())), 'AccessControlUnauthorizedAccount');
  assert.equal(await errName(c.bodies.createBody.staticCall(cityCouncil({ passPct: 40 }))), 'BadRules'); // less than a majority
  assert.equal(await errName(c.bodies.createBody.staticCall(cityCouncil({ voteMinutes: 0 }))), 'BadRules');
  assert.equal(await errName(c.bodies.createBody.staticCall(cityCouncil({ residentTier: 255 }))), 'BadRules'); // dissent rule needs a residents' vote
  const id = await newBody(cityCouncil());
  for (const [i, m] of members.entries()) await send(c.bodies.seat(id, m.address, `District ${i + 1}`));
  assert.equal(await errName(c.bodies.seat.staticCall(id, outsider.address, 'District 6')), 'SeatsFull');
  const [r, version, list] = await c.bodies.getBody(id);
  assert.deepEqual([r.name, Number(r.seats), Number(version), list.length], ['Example City Council', 5, 0, 5]);
  assert.equal(await c.bodies.seatOf(id, members[2].address), 'District 3');
});

test('a motion: public notice, residents vote first, roll call with reasons, veto, override', async () => {
  const bodyId = 1n;
  assert.equal(await errName(c.bodies.connect(outsider).propose.staticCall(bodyId, ref(1), ethers.id('roads'))), 'NotAMember');
  const id = motionOf(await send(c.bodies.connect(members[0]).propose(bodyId, ref(1), ethers.id('roads'))));
  const { m } = await c.bodies.getMotion(id);
  assert.equal(await stage(id), 'Scheduled');
  assert.equal(Number(m.opensAt) - Number(m.noticeAt), 30 * MIN);
  assert.ok(m.residentPoll > 0n);
  assert.equal(await errName(c.bodies.connect(members[1]).castVote.staticCall(id, YES, '')), 'NotOpen'); // still on notice

  // Residents vote during the notice period: a clear Yes.
  for (const r of residents.slice(0, 3)) await send(c.vote.castBallot(m.residentPoll, await buildBallot({ provider, vote: c.vote, pollId: m.residentPoll, identity: r, option: 0 })));
  await send(c.vote.castBallot(m.residentPoll, await buildBallot({ provider, vote: c.vote, pollId: m.residentPoll, identity: residents[3], option: 1 })));
  await warp(30 * MIN);
  assert.equal(await stage(id), 'Voting');

  // Voting against the residents' result needs a public reason.
  assert.equal(await errName(c.bodies.connect(members[1]).castVote.staticCall(id, NO, '')), 'ReasonRequired');
  await send(c.bodies.connect(members[1]).castVote(id, NO, 'Costs were not costed'));
  assert.equal(await c.bodies.residentResult(id), 1n);
  for (const k of [0, 2]) await send(c.bodies.connect(members[k]).castVote(id, YES, ''));
  await send(c.bodies.connect(clerk).recordVote(id, members[3].address, YES, 'Voted in the room'));
  assert.equal(await errName(c.bodies.connect(outsider).recordVote.staticCall(id, members[4].address, YES, '')), 'NotAllowed');
  await send(c.bodies.connect(members[4]).castVote(id, ABSTAIN, ''));
  assert.equal(await errName(c.bodies.connect(members[4]).castVote.staticCall(id, YES, '')), 'AlreadyVoted');

  // Everyone voted, so it can be counted before the window ends.
  await send(c.bodies.count(id));
  assert.equal(await stage(id), 'AwaitingExecutive');
  const [who, choice, reason, byClerk] = await c.bodies.rollCall(id);
  assert.equal(who.length, 5);
  assert.deepEqual([Number(choice[0]), reason[0]], [NO, 'Costs were not costed']);
  assert.equal(byClerk[3], true);

  // The mayor vetoes; the council overrides with 4 of 5 (needs 67% of all members).
  assert.equal(await errName(c.bodies.connect(outsider).act.staticCall(id, false, '')), 'NotAllowed');
  await send(c.bodies.connect(mayor).act(id, false, ref(2)));
  assert.equal(await stage(id), 'OverrideVote');
  for (const k of [0, 2, 3, 4]) await send(c.bodies.connect(members[k]).castOverride(id, true, ''));
  assert.equal(await errName(c.bodies.settle.staticCall(id)), 'TooEarly');
  await send(c.bodies.connect(members[1]).castOverride(id, false, 'Still too costly'));
  await send(c.bodies.settle(id));
  assert.equal(await stage(id), 'Adopted');
  assert.equal((await c.bodies.getMotion(id)).m.overridden, true);
});

test('no quorum fails; executive silence lapses or adopts as the body chose', async () => {
  const id = motionOf(await send(c.bodies.connect(clerk).propose(1n, ref(3), ethers.id('budget'))));
  await warp(30 * MIN);
  for (const k of [0, 1]) await send(c.bodies.connect(members[k]).castVote(id, YES, 'ok'));
  assert.equal(await errName(c.bodies.count.staticCall(id)), 'TooEarly');
  await warp(60 * MIN);
  assert.equal(await errName(c.bodies.connect(members[2]).castVote.staticCall(id, YES, 'late')), 'NotOpen');
  await send(c.bodies.count(id));
  assert.equal(await stage(id), 'Failed'); // 2 of 5 took part; quorum is 60%

  // A school board with no residents' poll and a chair who must sign within the deadline.
  const board = await newBody({ ...cityCouncil({ name: 'School Board', kind: 'school board', seats: 3, residentTier: 255, explainDissent: false, noticeMinutes: 0, overridePct: 0 }) });
  for (const k of [0, 1, 2]) await send(c.bodies.seat(board, members[k].address, `Seat ${k + 1}`));
  const lapse = motionOf(await send(c.bodies.connect(members[0]).propose(board, ref(4), ethers.id('education'))));
  for (const k of [0, 1, 2]) await send(c.bodies.connect(members[k]).castVote(lapse, YES, ''));
  await send(c.bodies.count(lapse));
  await warp(120 * MIN);
  assert.equal(await errName(c.bodies.connect(mayor).act.staticCall(lapse, true, '')), 'WrongStage');
  await send(c.bodies.settle(lapse));
  assert.equal(await stage(lapse), 'Lapsed');

  // Rules change later: motions already on the agenda keep the rules they started with.
  await send(c.bodies.setRules(board, { ...cityCouncil({ name: 'School Board', kind: 'school board', seats: 3, residentTier: 255, explainDissent: false, noticeMinutes: 0, overridePct: 0, silenceApproves: true }) }));
  const adopt = motionOf(await send(c.bodies.connect(members[0]).propose(board, ref(5), ethers.id('education'))));
  for (const k of [0, 1]) await send(c.bodies.connect(members[k]).castVote(adopt, YES, ''));
  await send(c.bodies.connect(members[2]).castVote(adopt, NO, ''));
  await send(c.bodies.count(adopt));
  await warp(120 * MIN);
  await send(c.bodies.settle(adopt));
  assert.equal(await stage(adopt), 'Adopted');
  assert.equal(Number((await c.bodies.getMotion(adopt)).m.version), 1);
  assert.equal(Number((await c.bodies.getMotion(lapse)).m.version), 0);
});
