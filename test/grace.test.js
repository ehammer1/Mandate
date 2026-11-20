// v6: a poll may give ballots sealed offline a delivery window after the close, for approved
// carriers only (clerk tablets, polling-place boxes); the result waits for the window to end.
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
const HOUR = 3600;
let c, provider, admin, carrier, stranger;
const people = Array.from({ length: 4 }, (_, i) => new Identity(`grace-voter-${i}`));
const send = async (p) => (await p).wait();
const errName = async (p) => {
  try {
    await p;
  } catch (e) {
    try {
      return c.vote.interface.parseError(e.data)?.name || e.revert?.name || e.shortMessage;
    } catch {
      return e.revert?.name || e.shortMessage;
    }
  }
  return 'no revert';
};
const ballot = (pollId, who, option) => buildBallot({ provider, vote: c.vote, pollId, identity: who, option });
const open = async (grace, changeCutoff = 0) => {
  await send(c.vote.createPollWith({ groupId: await c.identity.groupId(2), duration: 24 * HOUR, quorum: 1, options: 2, action: 0, actionData: '0x', questionCID: 'Q', bond: 0, settings: { changeCutoff, channels: 0, ranked: false, grace } }));
  return c.vote.pollCount();
};
const later = async (secs) => {
  await provider.send('evm_increaseTime', [secs]);
  await provider.send('evm_mine', []);
};

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 4, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, carrier, stranger] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  ({ contracts: c } = await deployAll(admin, { rules: { MIN_POLL_MINUTES: 10 } }));
  await send(c.identity.setIssuer(admin.address, 1, true, 'Clerk'));
  const longAgo = (await provider.getBlock('latest')).timestamp - 3 * 365 * 86_400;
  for (const [i, p] of people.entries()) await send(c.identity.enroll(p.commitment, 1, ethers.id(`grace-doc-${i}`), longAgo));
  await send(c.vote.grantRole(await c.vote.CARRIER_ROLE(), carrier.address));
});
after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('the delivery window is at most 24 hours', async () => {
  assert.equal(Number(await c.vote.MAX_GRACE()), 24 * HOUR);
  assert.equal(await errName(c.vote.createPollWith.staticCall({ groupId: await c.identity.groupId(2), duration: 24 * HOUR, quorum: 1, options: 2, action: 0, actionData: '0x', questionCID: 'Q', bond: 0, settings: { changeCutoff: 0, channels: 0, ranked: false, grace: 24 * HOUR + 1 } })), 'InvalidParams');
});

test('after the close only an approved carrier delivers, only within the window; the result waits for it', async () => {
  const id = await open(6 * HOUR);
  assert.equal(Number((await c.vote.settingsOf(id)).grace), 6 * HOUR);
  await send(c.vote.castBallot(id, await ballot(id, people[0], 0)));
  // Sealed offline before the close, handed to the carrier.
  const carried = await ballot(id, people[1], 1);
  const lateChange = await ballot(id, people[0], 1);
  const another = await ballot(id, people[2], 1);
  await later(24 * HOUR + 60); // closed

  assert.equal(await errName(c.vote.connect(stranger).castBallot.staticCall(id, carried)), 'NotOpen'); // not a carrier (nor the public relay)
  assert.equal(await errName(c.vote.finalize.staticCall(id)), 'StillOpen'); // the window is still open
  await send(c.vote.connect(carrier).castBallot(id, carried));
  assert.equal(await errName(c.vote.connect(carrier).castBallot.staticCall(id, lateChange)), 'ChangesClosed'); // no changing votes after the close

  await later(6 * HOUR);
  assert.equal(await errName(c.vote.connect(carrier).castBallot.staticCall(id, another)), 'NotOpen'); // too late even for a carrier
  await send(c.vote.finalize(id));
  const t = await c.vote.tally(id);
  assert.deepEqual(t.slice(0, 2).map(Number), [1, 1]);
});

test('a poll without a delivery window closes for carriers too', async () => {
  const id = await open(0);
  const b = await ballot(id, people[3], 0);
  await later(24 * HOUR + 60);
  assert.equal(await errName(c.vote.connect(carrier).castBallot.staticCall(id, b)), 'NotOpen');
  await send(c.vote.finalize(id));
});
