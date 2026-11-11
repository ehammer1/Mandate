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
    for (const k of [c.bodies, c.vote, c.bodyRecords]) {
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
const STAGE = ['None', 'Scheduled', 'Voting', 'AwaitingExecutive', 'Adopted', 'Failed', 'Vetoed', 'OverrideVote', 'Lapsed', 'Withdrawn'];
const stage = async (id) => STAGE[Number((await c.bodies.getMotion(id)).m.stage)];
const YES = 1, NO = 2, ABSTAIN = 3;
const ref = (n) => `nb:0x${String(n).repeat(64).slice(0, 64)}`;

const cityCouncil = (over = {}) => ({
  name: 'Example City Council', kind: 'city council', seats: 5, quorumPct: 60, passPct: 50, passOfSeats: false,
  overridePct: 67, noticeMinutes: 30, voteMinutes: 60, executiveMinutes: 120, executive: mayor.address, silenceApproves: false,
  residentTier: 2, explainDissent: true, reasonsRequired: false, clerk: clerk.address, active: true, allowAlternates: false, selfGoverned: false, ...over,
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
  for (const [i, m] of members.entries()) await send(c.bodies.seat(id, m.address, `District ${i + 1}`, 0));
  assert.equal(await errName(c.bodies.seat.staticCall(id, outsider.address, 'District 6', 0)), 'SeatsFull');
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
  const [who, choice, reason, via] = await c.bodies.rollCall(id);
  assert.equal(who.length, 5);
  assert.deepEqual([Number(choice[0]), reason[0]], [NO, 'Costs were not costed']);
  assert.equal(Number(via[3]), 1); // recorded by the clerk

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
  for (const k of [0, 1, 2]) await send(c.bodies.seat(board, members[k].address, `Seat ${k + 1}`, 0));
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

test('permissions: roles that expire, staff drafts, chair withdraws, recusal, self-rule, alternates, terms, closed sessions', async () => {
  const now = async () => (await provider.getBlock('latest')).timestamp;
  const id = await newBody(cityCouncil({ name: 'Rules Committee', kind: 'committee', seats: 4, residentTier: 255, explainDissent: false, noticeMinutes: 10, executive: ethers.ZeroAddress, executiveMinutes: 0, overridePct: 0, clerk: ethers.ZeroAddress, allowAlternates: true, selfGoverned: true }));
  for (const k of [0, 1, 2]) await send(c.bodies.seat(id, members[k].address, `Seat ${k + 1}`, 0));
  await send(c.bodies.seat(id, members[3].address, 'Seat 4', (await now()) + 3600)); // a term that ends in an hour
  const CHAIR = 1, CLERK = 2, STAFF = 4;

  // Staff draft but cannot put items on the agenda; their role expires.
  await send(c.bodies.setRoles(id, outsider.address, STAFF, (await now()) + 86_400));
  await send(c.bodyRecords.connect(outsider).submitDraft(id, ref(6)));
  assert.equal((await c.bodyRecords.getDraft(1)).by, outsider.address);
  assert.equal(await errName(c.bodies.connect(outsider).propose.staticCall(id, ref(6), ethers.ZeroHash)), 'NotAMember');
  assert.equal(await errName(c.bodies.connect(alice).setRoles.staticCall(id, alice.address, CHAIR, 0)), 'AccessControlUnauthorizedAccount');

  // A non-member chair runs the agenda and can withdraw an item before voting opens.
  await send(c.bodies.setRoles(id, mayor.address, CHAIR, 0));
  const pulled = motionOf(await send(c.bodies.connect(members[0]).propose(id, ref(7), ethers.ZeroHash)));
  assert.equal(await errName(c.bodies.connect(members[1]).withdraw.staticCall(pulled)), 'NotAllowed');
  await send(c.bodies.connect(mayor).withdraw(pulled));
  assert.equal(await stage(pulled), 'Withdrawn');

  // The body votes itself a clerk: an action motion, adopted without an executive.
  const action = { kind: 1, account: alice.address, alternate: ethers.ZeroAddress, roles: CLERK, until: 0 };
  const m1 = motionOf(await send(c.bodies.connect(mayor).proposeAction(id, ref(8), ethers.ZeroHash, action)));
  await warp(10 * MIN);
  // Seat 4's term ended? Not yet: four members vote; one recuses with a reason.
  assert.equal(await errName(c.bodies.connect(members[2]).recuse.staticCall(m1, '')), 'ReasonRequired');
  await send(c.bodies.connect(members[2]).recuse(m1, 'My spouse is the nominee'));
  for (const k of [0, 1, 3]) await send(c.bodies.connect(members[k]).castVote(m1, YES, ''));
  await send(c.bodies.count(m1)); // 3 of 3 eligible voted: counted early
  assert.equal(await stage(m1), 'Adopted');
  assert.equal(await c.bodies.recusals(m1), 1n);
  assert.equal(await c.bodies.holds(id, alice.address, CLERK), true);
  const [who, choice] = await c.bodies.rollCall(m1);
  assert.equal(Number(choice[who.indexOf(members[2].address)]), 4);

  // Seat 4's term ends: no longer a member, and not counted on new items.
  await warp(3600);
  assert.equal(await c.bodies.isMember(id, members[3].address), false);
  // An alternate for Seat 2, named by the body's vote; the alternate votes in their place.
  const alt = { kind: 2, account: members[1].address, alternate: outsider.address, roles: 0, until: 0 };
  const m2 = motionOf(await send(c.bodies.connect(members[0]).proposeAction(id, ref(9), ethers.ZeroHash, alt)));
  assert.equal(Number((await c.bodies.getMotion(m2)).m.electorate), 3);
  await warp(10 * MIN);
  for (const k of [0, 1, 2]) await send(c.bodies.connect(members[k]).castVote(m2, YES, ''));
  await send(c.bodies.count(m2));
  assert.equal(await c.bodies.alternateOf(id, members[1].address), outsider.address);
  const m3 = motionOf(await send(c.bodies.connect(alice).propose(id, ref(10), ethers.ZeroHash))); // the new clerk sets the agenda
  await warp(10 * MIN);
  await send(c.bodies.connect(outsider).castVoteFor(m3, members[1].address, NO, 'Voting for Seat 2, who is away'));
  assert.equal(await errName(c.bodies.connect(outsider).castVoteFor.staticCall(m3, members[0].address, NO, '')), 'NotAllowed');
  const [w3, , , via3] = await c.bodies.rollCall(m3);
  assert.equal(Number(via3[w3.indexOf(members[1].address)]), 2);
  await send(c.bodies.connect(alice).recordVote(m3, members[0].address, YES, 'In the room'));

  // Closed session: the reason, a sealed fingerprint of the minutes, and a deadline to publish them.
  const minutes = JSON.stringify({ title: 'Closed session minutes', body: 'Discussed the clerk applicant; no action taken.' });
  const seal = ethers.keccak256(ethers.toUtf8Bytes(minutes));
  assert.equal(await errName(c.bodyRecords.connect(members[0]).recordClosedSession.staticCall(id, 1, '', seal, (await now()) + DAY)), 'NotAllowed');
  await send(c.bodyRecords.connect(mayor).recordClosedSession(id, 1, 'Open Meetings Act, personnel exception', seal, (await now()) + DAY));
  await send(c.bodyRecords.connect(alice).recordClosedSession(id, 2, '', ethers.id('other minutes'), (await now()) + DAY));
  assert.equal(await errName(c.bodyRecords.publishMinutes.staticCall(1, seal)), 'WrongMinutes'); // not on the notice board yet
  assert.equal(await errName(c.bodyRecords.publishMinutes.staticCall(1, ethers.id('changed minutes'))), 'WrongMinutes');
  await send(c.notices.post(minutes));
  await send(c.bodyRecords.publishMinutes(1, seal));
  await warp(DAY + 1);
  assert.equal((await c.bodyRecords.getSession(1)).overdue, false);
  assert.equal((await c.bodyRecords.getSession(2)).overdue, true); // minutes not published in time: everyone can see it

  // Expired staff can no longer draft.
  assert.equal(await errName(c.bodyRecords.connect(outsider).submitDraft.staticCall(id, ref(6))), 'NotAllowed');
});
