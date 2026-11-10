#!/usr/bin/env node
/**
 * scripts/migrate-v2.js - move a council-run deployment to the current contracts, keeping
 * the voter list (IdentityRegistry, so every enrolment and voter code stays), the
 * Semaphore groups, the notice board and the play credits.
 *
 * Deployed fresh and set up by the deployer, then handed to a new council (with terms and
 * the public vote as its electorate): charter, voting, mandates, markets, civic budget,
 * feedback (comments, ratings, petitions), escrow factory.
 *
 *   NETWORK=base-sepolia PROPOSERS=0xA VERIFIERS=0xB RULES='{"MIN_POLL_MINUTES":10}' \
 *   COUNCIL_TERM_DAYS=365 node scripts/migrate-v2.js
 *
 * The voter list's admin moves through the OLD council: this proposes "make the new
 * council admin" and "the old council steps down" there; members approve them in the app.
 * Resumable: progress is saved in deployments/<NETWORK>.json under "migration".
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

(async () => {
  const name = process.env.NETWORK || 'base-sepolia';
  const preset = networks[name];
  const depFile = path.join(ROOT, 'deployments', `${name}.json`);
  const cfgFile = path.join(ROOT, 'app', `config.${name}.json`);
  const dep = JSON.parse(fs.readFileSync(depFile, 'utf8'));
  const provider = new ethers.JsonRpcProvider(preset?.rpcUrl || process.env.RPC_URL, dep.chainId, { staticNetwork: true });
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const signer = new ethers.NonceManager(wallet);
  const me = wallet.address;
  const save = () => fs.writeFileSync(depFile, JSON.stringify(dep, null, 2) + '\n');
  const send = async (label, p) => {
    const tx = await p;
    await tx.wait();
    console.log(`${label}: ${tx.hash}`);
  };
  // Finishing a previous run: once the new council holds the voter list, the old one steps down.
  if (dep.oldCouncilPending && !dep.migration) {
    const identity = new ethers.Contract(dep.addresses.identity, abi('IdentityRegistry'), signer);
    const old = new ethers.Contract(dep.oldCouncilPending.council, abi('Council'), signer);
    if (!(await identity.hasRole(ADMIN, dep.addresses.council))) return console.log('waiting: the old council has not yet run the move of the voter list');
    if (!(await identity.hasRole(ADMIN, dep.oldCouncilPending.council))) {
      delete dep.oldCouncilPending;
      save();
      return console.log('done: the old council has stepped down');
    }
    const data = identity.interface.encodeFunctionData('revokeRole', [ADMIN, dep.oldCouncilPending.council]);
    const rc = await (await old.propose(dep.addresses.identity, 0, data, 'The old council steps down from the voter list (the new council now holds it)')).wait();
    const id = old.interface.parseLog(rc.logs.find((l) => l.topics[0] === old.interface.getEvent('Proposed').topicHash)).args.id;
    dep.oldCouncilPending.stepDown = String(id);
    save();
    return console.log(`old council change #${id} proposed: step down (approve it in the app: Admin, Previous council)`);
  }
  const m = (dep.migration ||= {});
  const oldCouncil = new ethers.Contract(dep.addresses.council, abi('Council'), signer);
  const members = [...(await oldCouncil.members())];
  const threshold = Number(await oldCouncil.threshold());
  const delay = Number(await oldCouncil.delay());
  const termEnd = (await provider.getBlock('latest')).timestamp + Math.round(Number(process.env.COUNCIL_TERM_DAYS || 365) * 86_400);
  const rules = Object.entries(process.env.RULES ? JSON.parse(process.env.RULES) : {});
  const at = (n, a) => new ethers.Contract(a, abi(n), signer);

  // 1. The council first, pointing at the voting contract about to be created (its address is known in advance).
  if (!m.council) {
    const nonce = await provider.getTransactionCount(me, 'pending');
    const voteAddress = ethers.getCreateAddress({ from: me, nonce: nonce + 2 }); // council, charter, then vote
    const council = await deploy(signer, 'Council', {}, members, threshold, delay, termEnd, voteAddress);
    m.council = await council.getAddress();
    m.expectedVote = voteAddress;
    save();
    console.log(`new council ${m.council} (terms end ${new Date(termEnd * 1000).toISOString().slice(0, 10)})`);
  }
  if (!m.charter) {
    m.charter = await (await deploy(signer, 'Charter', {}, me, rules.map(([k]) => ethers.id(k)), rules.map(([, v]) => v))).getAddress();
    save();
  }
  if (!m.vote) {
    const vote = await deploy(signer, 'MandateVote', {}, me, dep.addresses.identity, dep.addresses.verifier, dep.addresses.credits, m.council, ethers.parseEther('100'), m.charter);
    m.vote = await vote.getAddress();
    if (m.vote !== m.expectedVote) throw new Error(`voting contract landed at ${m.vote}, the council expects ${m.expectedVote}: rerun from scratch`);
    save();
  }
  if (!m.registry) m.registry = await (await deploy(signer, 'MandateRegistry', {}, me)).getAddress(), save();
  if (!m.market) m.market = await (await deploy(signer, 'DecisionMarket', {}, me, dep.addresses.credits, m.registry)).getAddress(), save();
  if (!m.budget) m.budget = await (await deploy(signer, 'CivicBudget', {}, me, dep.addresses.identity, dep.addresses.verifier, m.charter)).getAddress(), save();
  if (!m.feedback) m.feedback = await (await deploy(signer, 'Feedback', {}, dep.addresses.identity, m.vote, m.charter)).getAddress(), save();
  if (!m.escrows) m.escrows = await (await deploy(signer, 'EscrowFactory', {}, m.registry, m.council, 1000, 7 * 86_400)).getAddress(), save();
  console.log('contracts deployed');

  // 2. Wiring, done once, while the deployer can still do it directly.
  const registry = at('MandateRegistry', m.registry);
  const market = at('DecisionMarket', m.market);
  const vote = at('MandateVote', m.vote);
  const charter = at('Charter', m.charter);
  const budget = at('CivicBudget', m.budget);
  const grant = async (k, role, who, label) => {
    if (!(await k.hasRole(role, who))) await send(label, k.grantRole(role, who));
  };
  const GOV = await registry.GOVERNOR_ROLE();
  await grant(registry, GOV, m.vote, 'public votes can create, pause, revise and repeal mandates');
  await grant(registry, GOV, m.market, 'markets can create mandates');
  await grant(market, await market.VETO_ROLE(), m.vote, 'public votes can veto market decisions');
  await grant(charter, await charter.GOVERNOR_ROLE(), m.vote, 'only a passed vote changes a rule');
  const proposers = [me, m.feedback, ...(process.env.PROPOSERS || '').split(',').filter(Boolean)].map((a) => ethers.getAddress(a.trim()));
  for (const a of proposers) await grant(vote, await vote.PROPOSER_ROLE(), a, `${a} can open polls`);
  for (const a of [me, ...(process.env.PROPOSERS || '').split(',').filter(Boolean)].map((x) => ethers.getAddress(x.trim()))) await grant(budget, await budget.PROPOSER_ROLE(), a, `${a} can open budget rounds`);
  for (const a of (process.env.VERIFIERS || '').split(',').filter(Boolean).map((x) => ethers.getAddress(x.trim()))) await grant(registry, await registry.VERIFIER_ROLE(), a, `${a} is a mandate verifier`);

  // 3. Hand every admin power to the new council.
  for (const [label, k] of [['mandates', registry], ['markets', market], ['voting', vote], ['charter', charter], ['civic budget', budget]]) {
    await grant(k, ADMIN, m.council, `new council is admin of ${label}`);
    if (await k.hasRole(ADMIN, me)) await send(`deployer gave up admin of ${label}`, k.renounceRole(ADMIN, me));
  }

  // 4. The voter list moves through the old council (two proposals for members to approve).
  const identity = at('IdentityRegistry', dep.addresses.identity);
  if (!m.identityProposals) {
    const ids = [];
    // Only the move now: the step-down (instant once approved) is proposed after the move has run,
    // so the voter list is never left without an admin.
    for (const [data, why] of [[identity.interface.encodeFunctionData('grantRole', [ADMIN, m.council]), 'Move the voter list to the new council (with terms, answerable to public votes)']]) {
      const rc = await (await oldCouncil.propose(dep.addresses.identity, 0, data, why)).wait();
      ids.push(String(oldCouncil.interface.parseLog(rc.logs.find((l) => l.topics[0] === oldCouncil.interface.getEvent('Proposed').topicHash)).args.id));
      console.log(`old council change #${ids.at(-1)} proposed: ${why}`);
    }
    m.identityProposals = ids;
    save();
  }

  // 5. Publish: the app, relayer, identity service and watchdog follow the config.
  dep.previous ||= [];
  dep.previous.push({ replacedAt: new Date().toISOString(), council: dep.addresses.council, vote: dep.addresses.vote, registry: dep.addresses.registry, market: dep.addresses.market, charter: dep.addresses.charter, budget: dep.addresses.budget, escrows: dep.addresses.escrows });
  Object.assign(dep.addresses, { council: m.council, charter: m.charter, vote: m.vote, registry: m.registry, market: m.market, budget: m.budget, feedback: m.feedback, escrows: m.escrows });
  dep.oldCouncilPending = { council: dep.previous.at(-1).council, proposals: m.identityProposals };
  delete dep.migration;
  save();
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  Object.assign(cfg, { councilAddress: m.council, charterAddress: m.charter, voteAddress: m.vote, registryAddress: m.registry, marketAddress: m.market, budgetAddress: m.budget, feedbackAddress: m.feedback, escrowFactoryAddress: m.escrows });
  delete cfg.previousVoteAddress;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  console.log('done');
})().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
