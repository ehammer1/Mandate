#!/usr/bin/env node
/**
 * scripts/seed-demo.js - sample content for the demo community, so visitors find something to
 * try: an advisory poll, a People's Agenda season with issues and two sample candidates who
 * state positions, a citizens' review panel for the poll, and a petition. Everything is
 * labelled "Sample". Run it after people have joined: polls and seasons only count those on the
 * voter list when they open.
 *
 *   NETWORK=base-sepolia NODE_USE_ENV_PROXY=1 node scripts/seed-demo.js demo
 *
 * The signer (DEPLOYER_PRIVATE_KEY) needs, on that community only: "open polls" (voting
 * PROPOSER_ROLE), "open People's Agenda seasons" and "organize citizens' assemblies"
 * (ORGANIZER_ROLE on each), granted by its council. It funds two throwaway sample-candidate
 * accounts with a little test ETH so they can state positions; their keys are kept in
 * .demo-candidates.json (ignored by git) for later updates.
 */
'use strict';

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..');
const abi = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'build', `${n}.json`), 'utf8')).abi;
const DAY = 86_400;

const ISSUES = [
  ['Rents are rising faster than wages', 'housing', 'Many families spend over half their income on rent.'],
  ['Safer crossings near schools', 'roads', 'Children cross four lanes of traffic on the way to Lincoln Elementary.'],
  ['Keep the library open on Sundays', 'education', 'Sunday is the only day many working parents can go.'],
  ['Fix the potholes on Oak Street', 'roads', ''],
  ['Publish the city budget line by line', 'budget', 'Only totals are published today.'],
  ['More shade trees in Riverside Park', 'environment', ''],
];
const CANDIDATES = [
  // name, race, stances per issue (-2..2 or null), importance per issue (0..3)
  ['Alex Rivera (sample)', 'Mayor', [2, 1, 1, null, 2, 0], [3, 2, 1, 0, 3, 1]],
  ['Sam Chen (sample)', 'Mayor', [-1, 2, 0, 2, 1, 1], [1, 3, 1, 3, 2, 1]],
];

async function seed(slug, { signer, log = console.log, cfg: given, keysFile: kf } = {}) {
  const cfg = given || JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'communities', `${slug}.json`), 'utf8'));
  const send = async (label, p) => {
    const tx = await p;
    await tx.wait();
    log(`${label}: ${tx.hash}`);
    return tx;
  };
  const notices = new ethers.Contract(cfg.noticeBoardAddress, abi('NoticeBoard'), signer);
  const post = async (doc) => {
    const text = JSON.stringify({ ...doc, sample: true });
    await send(`published "${doc.title.slice(0, 40)}"`, notices.post(text));
    return `nb:${ethers.keccak256(ethers.toUtf8Bytes(text))}`;
  };
  const me = await signer.getAddress();
  const vote = new ethers.Contract(cfg.voteAddress, abi('MandateVote'), signer);
  const identity = new ethers.Contract(cfg.identityAddress, abi('IdentityRegistry'), signer);
  const agenda = cfg.agendaAddress && new ethers.Contract(cfg.agendaAddress, abi('Agenda'), signer);
  const assemblies = cfg.assembliesAddress && new ethers.Contract(cfg.assembliesAddress, abi('Assemblies'), signer);
  const feedback = cfg.feedbackAddress && new ethers.Contract(cfg.feedbackAddress, abi('Feedback'), signer);
  const ORG = ethers.id('ORGANIZER_ROLE');
  const roles = {
    polls: await vote.hasRole(await vote.PROPOSER_ROLE(), me),
    agenda: agenda ? await agenda.hasRole(ORG, me) : false,
    assemblies: assemblies ? await assemblies.hasRole(ORG, me) : false,
  };
  const members = Number(await identity.leafCount(0));
  log(`${slug}: ${members} member(s) on the voter list; roles ${JSON.stringify(roles)}`);
  if (!members) throw new Error('Nobody has joined yet: seed after people join (polls and seasons count only those on the list when they open).');

  // 1. An advisory poll, open to all members.
  let pollId = null;
  if (roles.polls) {
    const ref = await post({ title: 'Sample: Should Main Street get protected bike lanes?', body: 'Sample poll for the demo. Protected lanes on Main Street between 1st and 9th, replacing one parking lane on each side.', options: ['Yes', 'No'], category: 'roads' });
    await send('sample poll opened', vote.createPoll(await identity.groupId(0), 21 * DAY, 1, 2, 0, '0x', ref, 0));
    pollId = await vote.pollCount();
  }

  // 2. A People's Agenda season with issues, and two sample candidates who state positions.
  if (roles.agenda) {
    const ref = await post({ title: 'Sample season: what should Demo Town work on this winter?', body: 'Sample People\'s Agenda season for the demo: add your own issue, then rank what matters most.' });
    await send('sample season opened', agenda.openSeason(0, 3 * DAY, 14 * DAY, 16, ref));
    const season = await agenda.seasonCount();
    for (const [title, category, body] of ISSUES) await send(`issue "${title}"`, agenda.addIssue(season, await post({ title, category, ...(body ? { body } : {}) })));
    const keysFile = kf || path.join(ROOT, '.demo-candidates.json');
    const keys = fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, 'utf8')) : {};
    for (const [name, race, stances, importance] of CANDIDATES) {
      keys[name] ||= ethers.Wallet.createRandom().privateKey;
      const w = new ethers.Wallet(keys[name], signer.provider);
      fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2));
      // Enough for one statement of positions at today's gas price (a tiny amount on Base).
      const fee = await signer.provider.getFeeData();
      const need = (fee.maxFeePerGas || fee.gasPrice || 1_000_000_000n) * 700_000n;
      if ((await signer.provider.getBalance(w.address)) < need) await send(`gas for ${name}`, signer.sendTransaction({ to: w.address, value: need }));
      await send(`candidate ${name}`, agenda.addCandidate(season, w.address, name, race, ''));
      const id = await agenda.candidateCount();
      const picked = stances.map((v, i) => [i, v, importance[i]]).filter(([, v]) => v !== null);
      const statement = await post({ title: 'Candidate statement', body: `${name.replace(' (sample)', '')} is a sample candidate for the demo. Positions are made up to show how the candidate match works.` });
      await send(`${name} states positions`, agenda.connect(w).statePositions(id, picked.map((p) => p[0]), picked.map((p) => p[1]), picked.map((p) => p[2]), statement));
    }
  }

  // 3. A citizens' review panel for the sample poll.
  if (roles.assemblies && pollId) {
    const seats = Math.min(3, members);
    const ref = await post({ title: 'Sample review panel: protected bike lanes on Main Street', body: 'Sample citizens\' review panel for the demo: residents drawn at random hear both sides and write the for-and-against statement shown with the poll.', reviewOf: { poll: Number(pollId) } });
    await send('sample review panel announced', assemblies.announce(0, seats, 30, ref));
  }

  // 4. A petition anyone on the list can sign.
  if (feedback) {
    const ref = await post({ title: 'Sample petition: add a crosswalk at Oak and 5th', body: 'Sample petition for the demo. Sign it to see how a petition opens its own poll when enough residents sign.', category: 'roads' });
    await send('sample petition started', feedback.createPetition(0, 0, '0x', ref));
  }
  log('sample content added');
}

module.exports = { seed, ISSUES, CANDIDATES };

if (require.main === module) {
  const slug = process.argv[2] || 'demo';
  const networks = require('./networks');
  const preset = networks[process.env.NETWORK || 'base-sepolia'];
  const provider = new ethers.JsonRpcProvider(preset?.rpcUrl || process.env.RPC_URL, undefined, { staticNetwork: true });
  const signer = new ethers.NonceManager(new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider));
  seed(slug, { signer }).catch((e) => {
    console.error(e.shortMessage || e.message);
    process.exit(1);
  });
}
