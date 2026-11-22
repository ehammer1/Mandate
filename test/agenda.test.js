// The People's Agenda: residents add issues and rank their priorities with quadratic credits,
// anonymously, once per person (a later ranking replaces the earlier one). Real proofs.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Identity } = require('@semaphore-protocol/identity');
const { deployAll } = require('../scripts/deploy');
const { issueProof, rankProof } = require('../client/agenda');
const { createRelayer } = require('../broker/relayer');

process.env.SEMAPHORE_ARTIFACTS_DIR = path.dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json'));
const DAY = 86_400;
let provider, admin, clerk, relayKey, stranger, c, relay, relayUrl;
const residents = Array.from({ length: 5 }, (_, i) => new Identity(`agenda-resident-${i}`));
const outsider = new Identity('agenda-outsider');
const send = async (p) => (await p).wait();
const errName = async (p) => {
  try {
    await p;
  } catch (e) {
    try {
      return c.agenda.interface.parseError(e.data)?.name || e.revert?.name || e.shortMessage;
    } catch {
      return e.revert?.name || e.shortMessage;
    }
  }
  return 'no revert';
};
const warp = async (s) => {
  await provider.send('evm_increaseTime', [s]);
  await provider.send('evm_mine', []);
};
const post = async (body) => {
  const r = await fetch(`${relayUrl}/agenda`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) });
  return { status: r.status, ...(await r.json()) };
};

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 5, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, clerk, relayKey, stranger] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  ({ contracts: c } = await deployAll(admin, {}));
  await send(c.identity.setIssuer(clerk.address, 1, true, 'Clerk'));
  for (const [i, r] of residents.entries()) await send(c.identity.connect(clerk).enroll(r.commitment, 0, ethers.ZeroHash, 0));
  relay = createRelayer({ provider, signer: relayKey, voteAddress: await c.vote.getAddress(), agendaAddress: await c.agenda.getAddress(), log: () => {} });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  relayUrl = `http://127.0.0.1:${relay.address().port}`;
});
after(async () => {
  relay?.closeAllConnections();
  await new Promise((r) => relay.close(r));
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test("a season: residents add issues, then rank them; the community's priorities are public, who ranked what is not", async () => {
  const a = c.agenda;
  assert.equal(await errName(a.connect(stranger).openSeason.staticCall(0, DAY, DAY, 16, 'nb:s')), 'AccessControlUnauthorizedAccount');
  await send(a.openSeason(0, 7 * DAY, 14 * DAY, 16, 'nb:spring'));
  const id = await a.seasonCount();
  await send(a.addIssue(id, 'nb:housing-costs')); // an organizer seeds a common one

  // Residents add their own issues, through the relay (no wallet, no fee), one each.
  const add = async (who, ref) => post({ method: 'propose', args: [id, ref], proof: await issueProof({ provider, agenda: a, seasonId: id, identity: residents[who], ref }) });
  assert.equal((await add(0, 'nb:road-safety')).status, 200);
  assert.equal((await add(1, 'nb:school-repairs')).status, 200);
  assert.equal((await add(0, 'nb:another-one')).status, 409); // one issue per person
  await assert.rejects(issueProof({ provider, agenda: a, seasonId: id, identity: outsider, ref: 'nb:x' }), /not on the voter list/);
  assert.equal((await add(2, 'nb:too-early-to-rank')).status, 200);

  // Ranking waits for the proposing part to end; the list of issues is then fixed.
  const early = await rankProof({ provider, agenda: a, seasonId: id, identity: residents[0], picks: [0], credits: [1] });
  assert.equal(await errName(a.rank.staticCall(id, [0], [1], early)), 'NotRanking');
  await warp(7 * DAY + 1);
  assert.equal(await errName(a.addIssue.staticCall(id, 'nb:late')), 'NotProposing');

  const rank = async (who, picks, credits) => post({ method: 'rank', args: [id, picks, credits], proof: await rankProof({ provider, agenda: a, seasonId: id, identity: residents[who], picks, credits }) });
  // 16 credits: 4 on one issue (16), or 2 + 2 + 2 (12), never 3 + 3 (18).
  await assert.rejects(rankProof({ provider, agenda: a, seasonId: id, identity: residents[0], picks: [0, 1], credits: [3, 3] }), /costs 18 credits/);
  assert.equal((await rank(0, [1], [4])).status, 200);
  assert.equal((await rank(1, [0, 1, 2], [2, 2, 2])).status, 200);
  assert.equal((await rank(2, [0], [4])).status, 200);
  // A ranking can't be altered in transit: the proof seals it.
  const sealed = await rankProof({ provider, agenda: a, seasonId: id, identity: residents[3], picks: [2], credits: [1] });
  assert.equal(await errName(a.rank.staticCall(id, [2], [4], sealed)), 'WrongMessage');
  assert.equal(await errName(a.rank.staticCall(id, [1, 1], [1, 1], await rankProof({ provider, agenda: a, seasonId: id, identity: residents[3], picks: [1, 2], credits: [1, 1] }))), 'BadPicks'); // the same issue twice

  // Change of mind: resident 2 moves their credits from housing to schools; only the latest counts.
  assert.equal((await rank(2, [2], [4])).status, 200);
  const [refs, credits] = await a.issues(id);
  assert.deepEqual([...refs], ['nb:housing-costs', 'nb:road-safety', 'nb:school-repairs', 'nb:too-early-to-rank']);
  assert.deepEqual(credits.map(Number), [2, 6, 6, 0]);
  assert.equal(Number((await a.getSeason(id)).participants), 3);

  await warp(14 * DAY);
  assert.equal((await rank(3, [0], [1])).status, 422); // closed
});

test('candidates state positions on the residents\' issues; every change is counted; matching ranks by what you want', async () => {
  const { matchScore } = require('../client/agenda');
  const a = c.agenda;
  const id = await a.seasonCount(); // the season above: 4 issues
  assert.equal(await errName(a.connect(stranger).addCandidate.staticCall(id, stranger.address, 'Sam', 'Mayor', '')), 'AccessControlUnauthorizedAccount');
  await send(a.addCandidate(id, clerk.address, 'Rivera', 'Mayor', 'Party A'));
  await send(a.addCandidate(id, stranger.address, 'Chen', 'Mayor', ''));
  const [riv, chen] = (await a.candidatesOf(id)).map(Number);
  assert.equal(await errName(a.connect(stranger).statePositions.staticCall(riv, [0], [2], [3], '')), 'NotCandidate'); // only the candidate
  assert.equal(await errName(a.connect(clerk).statePositions.staticCall(riv, [0], [3], [3], '')), 'BadPositions'); // stance -2..+2
  assert.equal(await errName(a.connect(clerk).statePositions.staticCall(riv, [0, 0], [1, 1], [1, 1], '')), 'BadPositions'); // once per issue
  assert.equal(await errName(a.connect(clerk).statePositions.staticCall(riv, [9], [1], [1], '')), 'BadPositions'); // no such issue
  await send(a.connect(clerk).statePositions(riv, [0, 1, 2], [2, -2, 1], [3, 1, 2], 'nb:rivera'));
  await send(a.connect(stranger).statePositions(chen, [0, 1], [-1, 2], [2, 3], ''));
  await send(a.connect(stranger).statePositions(chen, [0, 1, 2], [-2, 2, 2], [2, 3, 3], '')); // changed
  const p = await a.positionsOf(riv);
  assert.deepEqual([...p.answered], [true, true, true, false]);
  assert.deepEqual([...p.stances].map(Number), [2, -2, 1, 0]);
  assert.deepEqual([...p.importance].map(Number), [3, 1, 2, 0]);
  assert.equal(Number((await a.getCandidate(chen)).version), 2);

  // A resident who strongly supports issue 0 and opposes issue 1 matches Rivera, not Chen.
  const mine = [{ stance: 2, importance: 3 }, { stance: -1, importance: 2 }, null, { stance: 1, importance: 1 }];
  const r = matchScore(mine, await a.positionsOf(riv));
  const ch = matchScore(mine, await a.positionsOf(chen));
  assert.ok(r.percent > ch.percent, `${r.percent} vs ${ch.percent}`);
  assert.deepEqual([r.compared, r.unanswered], [2, 1]); // issue 3: Rivera gave no answer
  assert.equal(matchScore([null, null], await a.positionsOf(riv)), null);
  // Whether party labels are shown is the community's voted rule: off unless residents turn it on.
  assert.equal(await c.charter.rule(ethers.id('SHOW_PARTY_LABELS')), 0n);
});
