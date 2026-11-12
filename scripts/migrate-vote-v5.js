#!/usr/bin/env node
/**
 * scripts/migrate-vote-v5.js - replace the voting contract with v5: each poll's own settings
 * (until when votes can change, online/paper/both), ranked-choice polls, and polls for smaller
 * voter lists (districts, wards) through the new VoterGroups contract. The contracts tied to the
 * voting contract are redeployed alongside
 * (petitions and comments, officials and delegates, government bodies and their records, paper
 * tallies); the council, mandates, markets, voting rules, civic budget and voter list stay.
 *
 *   NETWORK=base-sepolia PROPOSERS=0xA REGISTRARS=0xA CLERKS=0xA,0xB GROUP_CREATORS=0xA NODE_USE_ENV_PROXY=1 \
 *   node scripts/migrate-vote-v5.js
 *
 * Existing contracts are run by the council, so the switch is proposed there: mandates,
 * markets and the voting rules accept the new voting contract, the council's electorate
 * becomes it, and the old one loses its powers (removals need no wait). Members approve them
 * in the app. Resumable: progress is saved in deployments/<NETWORK>.json under "voteMigration".
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const networks = require('./networks');
const { deploy } = require('./deploy');

const ROOT = path.join(__dirname, '..');
const abi = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'build', `${n}.json`), 'utf8')).abi;
const ADMIN = ethers.ZeroHash;
const list = (v) => (v || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => ethers.getAddress(x));

(async () => {
  const name = process.env.NETWORK || 'base-sepolia';
  const depFile = path.join(ROOT, 'deployments', `${name}.json`);
  const cfgFile = path.join(ROOT, 'app', `config.${name}.json`);
  const dep = JSON.parse(fs.readFileSync(depFile, 'utf8'));
  const a = dep.addresses;
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || networks[name]?.rpcUrl, dep.chainId, { staticNetwork: true });
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const signer = new ethers.NonceManager(wallet);
  const me = wallet.address;
  const save = () => fs.writeFileSync(depFile, JSON.stringify(dep, null, 2) + '\n');
  const at = (n, x) => new ethers.Contract(x, abi(n), signer);
  const send = async (label, p) => console.log(`${label}: ${(await (await p).wait()).hash}`);
  const m = (dep.voteMigration ||= {});
  const council = at('Council', a.council);
  if (!(await council.isMember(me))) throw new Error('the deployer must be a council member to propose the switch');
  const oldVote = at('MandateVote', a.vote);

  // 1. New contracts.
  if (!m.vote) {
    const minBond = await oldVote.minBond().catch(() => ethers.parseEther('100'));
    const treasury = await oldVote.treasury().catch(() => a.council);
    m.vote = await (await deploy(signer, 'MandateVote', {}, me, a.identity, a.verifier, a.credits, treasury, minBond, a.charter)).getAddress();
    save();
  }
  if (!m.feedback) m.feedback = await (await deploy(signer, 'Feedback', {}, a.identity, m.vote, a.charter)).getAddress(), save();
  if (!m.officials) m.officials = await (await deploy(signer, 'Officials', {}, me, m.vote, a.identity)).getAddress(), save();
  if (!m.bodies) m.bodies = await (await deploy(signer, 'Bodies', {}, me, m.vote, a.identity)).getAddress(), save();
  if (!m.bodyRecords) m.bodyRecords = await (await deploy(signer, 'BodyRecords', {}, m.bodies, a.notices)).getAddress(), save();
  if (!m.tallies) m.tallies = await (await deploy(signer, 'Tallies', {}, me, m.vote, a.identity)).getAddress(), save();
  if (!m.voterGroups) m.voterGroups = await (await deploy(signer, 'VoterGroups', {}, me, a.identity)).getAddress(), save();
  console.log('contracts deployed');

  // 2. Wiring, while the deployer can.
  const vote = at('MandateVote', m.vote);
  const officials = at('Officials', m.officials);
  const bodies = at('Bodies', m.bodies);
  const tallies = at('Tallies', m.tallies);
  const voterGroups = at('VoterGroups', m.voterGroups);
  const grant = async (k, role, who, label) => {
    if (!(await k.hasRole(role, who))) await send(label, k.grantRole(role, who));
  };
  if ((await vote.delegates()) === ethers.ZeroAddress) await send('delegation uses the officials registry', vote.setDelegates(m.officials));
  if ((await vote.voterGroups()) === ethers.ZeroAddress) await send('polls can use smaller voter lists', vote.setVoterGroups(m.voterGroups));
  for (const x of list(process.env.GROUP_CREATORS || process.env.PROPOSERS)) await grant(voterGroups, await voterGroups.GROUP_CREATOR_ROLE(), x, `${x} can create smaller voter lists`);
  const P = await vote.PROPOSER_ROLE();
  for (const [who, why] of [[m.feedback, 'petitions'], [m.officials, 'emergency measures'], [m.bodies, 'agenda items'], [a.council, 'emergency council changes']]) await grant(vote, P, who, `${why} open polls`);
  for (const x of list(process.env.PROPOSERS)) await grant(vote, P, x, `${x} can open polls`);
  for (const x of list(process.env.REGISTRARS || process.env.PROPOSERS)) {
    await grant(officials, await officials.REGISTRAR_ROLE(), x, `${x} registers officials`);
    await grant(bodies, await bodies.REGISTRAR_ROLE(), x, `${x} sets up government bodies`);
  }
  const clerks = list(process.env.CLERKS);
  for (const x of clerks) await grant(tallies, await tallies.CLERK_ROLE(), x, `${x} is a tally clerk`);

  // 3. The council takes every admin power; the deployer keeps none.
  if (list(process.env.REGISTRARS || process.env.PROPOSERS).length) {
    for (const [k, role] of [[officials, await officials.REGISTRAR_ROLE()], [bodies, await bodies.REGISTRAR_ROLE()]]) if (await k.hasRole(role, me)) await send('deployer gave up registrar', k.renounceRole(role, me));
  }
  if (clerks.length && !clerks.includes(me) && (await tallies.hasRole(await tallies.CLERK_ROLE(), me))) await send('deployer gave up tally clerk', tallies.renounceRole(await tallies.CLERK_ROLE(), me));
  if (await vote.hasRole(P, me)) await send('deployer gave up opening polls', vote.renounceRole(P, me));
  for (const [label, k] of [['voting', vote], ['officials', officials], ['bodies', bodies], ['tallies', tallies], ['voter groups', voterGroups]]) {
    await grant(k, ADMIN, a.council, `council is admin of ${label}`);
    if (await k.hasRole(ADMIN, me)) await send(`deployer gave up admin of ${label}`, k.renounceRole(ADMIN, me));
  }

  // 4. The switch, through the council: existing contracts accept the new voting contract,
  //    the council answers to it, and the old one loses its powers.
  const registry = at('MandateRegistry', a.registry);
  const market = at('DecisionMarket', a.market);
  const charter = at('Charter', a.charter);
  const GOV = await registry.GOVERNOR_ROLE();
  const VETO = await market.VETO_ROLE();
  const CGOV = await charter.GOVERNOR_ROLE();
  const steps = [
    ['grantGov', registry, 'grantRole', [GOV, m.vote], 'Let the new voting contract (poll settings, ranked choice, district lists) create, pause, revise and repeal mandates'],
    ['grantVeto', market, 'grantRole', [VETO, m.vote], 'Let the new voting contract veto market decisions'],
    ['grantCharter', charter, 'grantRole', [CGOV, m.vote], 'Let the new voting contract change the voting rules (by a passed rule-change poll)'],
    ['electorate', council, 'setElectorate', [m.vote], 'The council answers to the new voting contract: residents elect, recall and remove power through it'],
    ['revokeGov', registry, 'revokeRole', [GOV, a.vote], 'Retire the old voting contract: it can no longer create or change mandates'],
    ['revokeVeto', market, 'revokeRole', [VETO, a.vote], 'Retire the old voting contract: it can no longer veto market decisions'],
    ['revokeCharter', charter, 'revokeRole', [CGOV, a.vote], 'Retire the old voting contract: it can no longer change the voting rules'],
  ];
  m.proposals ||= {};
  for (const [key, target, fn, args, why] of steps) {
    if (m.proposals[key]) continue;
    const rc = await (await council.propose(await target.getAddress(), 0, target.interface.encodeFunctionData(fn, args), why)).wait();
    m.proposals[key] = String(council.interface.parseLog(rc.logs.find((l) => l.topics[0] === council.interface.getEvent('Proposed').topicHash)).args.id);
    save();
    console.log(`council change #${m.proposals[key]} proposed: ${why}`);
  }

  // 5. Publish: the app, relayer and watchdog follow the config.
  dep.previous ||= [];
  dep.previous.push({ replacedAt: new Date().toISOString(), vote: a.vote, feedback: a.feedback, officials: a.officials, bodies: a.bodies, bodyRecords: a.bodyRecords, tallies: a.tallies });
  Object.assign(a, { vote: m.vote, feedback: m.feedback, officials: m.officials, bodies: m.bodies, bodyRecords: m.bodyRecords, tallies: m.tallies, voterGroups: m.voterGroups });
  dep.pendingCouncilChanges = Object.values(m.proposals);
  delete dep.voteMigration;
  save();
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  Object.assign(cfg, { voteAddress: m.vote, feedbackAddress: m.feedback, officialsAddress: m.officials, bodiesAddress: m.bodies, bodyRecordsAddress: m.bodyRecords, talliesAddress: m.tallies, voterGroupsAddress: m.voterGroups, previousVoteAddress: dep.previous.at(-1).vote });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  console.log('done');
})().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
