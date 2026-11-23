// Sample content for the demo: added after people join, by an account the council made demo host.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { deployAll } = require('../scripts/deploy');
const { seed, ISSUES, CANDIDATES } = require('../scripts/seed-demo');

test('the demo host adds a sample poll, agenda season with candidates, review panel and petition', async () => {
  const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 3, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  const admin = await provider.getSigner(0);
  const { contracts: c, addresses } = await deployAll(admin, { rules: { MIN_POLL_MINUTES: 10 } });
  const cfg = { voteAddress: addresses.vote, identityAddress: addresses.identity, agendaAddress: addresses.agenda, assembliesAddress: addresses.assemblies, feedbackAddress: addresses.feedback, noticeBoardAddress: addresses.notices };
  const keysFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seed-')), 'keys.json');
  await assert.rejects(seed('demo', { signer: admin, cfg, keysFile, log: () => {} }), /Nobody has joined yet/);
  await (await c.identity.setIssuer(admin.address, 1, true, 'Clerk')).wait();
  for (const n of [1n, 2n]) await (await c.identity.enroll(n, 0, ethers.ZeroHash, 0)).wait();
  await seed('demo', { signer: admin, cfg, keysFile, log: () => {} });
  assert.equal(await c.vote.pollCount(), 1n);
  const [refs] = await c.agenda.issues(1);
  assert.equal(refs.length, ISSUES.length);
  const cands = await c.agenda.candidatesOf(1);
  assert.equal(cands.length, CANDIDATES.length);
  const p = await c.agenda.positionsOf(cands[0]);
  assert.equal(p.answered.filter(Boolean).length, CANDIDATES[0][2].filter((v) => v !== null).length);
  const a = await c.assemblies.getAssembly(1);
  assert.equal(Number(a.seats), 2); // no more seats than people on the list
  assert.equal(await c.feedback.petitionCount(), 1n);
  assert.ok(JSON.parse(await c.notices.read(refs[0].slice(3))).sample); // labelled as sample content
});
