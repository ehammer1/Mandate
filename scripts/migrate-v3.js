#!/usr/bin/env node
/**
 * scripts/migrate-v3.js - move a council-run deployment to the current contracts, keeping
 * the voter list (IdentityRegistry: every enrolment and voter code stays), the Semaphore
 * groups, the notice board and the play credits. The community's current voting rules are
 * copied from the old charter unchanged (RULES only overrides the ones you name).
 *
 * New in this version: officials and public delegates, anonymous delegation, emergency
 * measures and emergency council changes that lapse unless residents ratify them, and
 * government bodies with their own rules and roll-call votes.
 *
 * Deployed fresh and set up by the deployer, then handed to a new council: council, charter,
 * voting, mandates, markets, civic budget, feedback, escrow factory, officials, bodies.
 *
 *   NETWORK=base-sepolia PROPOSERS=0xA VERIFIERS=0xB REGISTRARS=0xA COUNCIL_TERM_DAYS=365 \
 *   NODE_USE_ENV_PROXY=1 node scripts/migrate-v3.js
 *
 * The voter list moves through whichever council holds it now: this proposes "make the new
 * council admin" there; members approve it in the app (Admin, Previous council). Run the
 * script again afterwards to propose that the old council steps down.
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
const list = (v) => (v || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => ethers.getAddress(x));

(async () => {
  const name = process.env.NETWORK || 'base-sepolia';
  const preset = networks[name];
  const depFile = path.join(ROOT, 'deployments', `${name}.json`);
  const cfgFile = path.join(ROOT, 'app', `config.${name}.json`);
  const dep = JSON.parse(fs.readFileSync(depFile, 'utf8'));
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || preset?.rpcUrl, dep.chainId, { staticNetwork: true });
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const signer = new ethers.NonceManager(wallet);
  const me = wallet.address;
  const save = () => fs.writeFileSync(depFile, JSON.stringify(dep, null, 2) + '\n');
  const at = (n, a) => new ethers.Contract(a, abi(n), signer);
  const send = async (label, p) => {
    const tx = await p;
    await tx.wait();
    console.log(`${label}: ${tx.hash}`);
  };
  const proposedId = (council, rc) => String(council.interface.parseLog(rc.logs.find((l) => l.topics[0] === council.interface.getEvent('Proposed').topicHash)).args.id);
  const identity = at('IdentityRegistry', dep.addresses.identity);

  // Finishing a previous run: once the new council holds the voter list, the old one steps down.
  if (dep.oldCouncilPending && !dep.migration && dep.addresses.bodies) {
    const old = at('Council', dep.oldCouncilPending.council);
    if (!(await identity.hasRole(ADMIN, dep.addresses.council))) return console.log('waiting: the old council has not yet run the move of the voter list');
    if (!(await identity.hasRole(ADMIN, dep.oldCouncilPending.council))) {
      delete dep.oldCouncilPending;
      save();
      return console.log('done: the old council has stepped down');
    }
    if (dep.oldCouncilPending.stepDown) return console.log(`waiting: old council change #${dep.oldCouncilPending.stepDown} (step down) needs approval`);
    const data = identity.interface.encodeFunctionData('revokeRole', [ADMIN, dep.oldCouncilPending.council]);
    const rc = await (await old.propose(dep.addresses.identity, 0, data, 'The old council steps down from the voter list (the new council now holds it)')).wait();
    dep.oldCouncilPending.stepDown = proposedId(old, rc);
    save();
    return console.log(`old council change #${dep.oldCouncilPending.stepDown} proposed: step down (approve it in the app: Admin, Previous council)`);
  }

  const m = (dep.migration ||= { version: 3 });
  // Whoever holds the voter list now proposes the move; the current council's members carry over.
  const holder = [dep.oldCouncilPending?.council, dep.addresses.council].filter(Boolean);
  if (!m.identityHolder) {
    for (const a of holder) if (await identity.hasRole(ADMIN, a)) m.identityHolder = a;
    if (!m.identityHolder) throw new Error('no known council is admin of the voter list');
    save();
  }
  const current = at('Council', dep.addresses.council);
  const members = [...(await current.members())];
  const threshold = Number(await current.threshold());
  const delay = Number(await current.delay());
  const termEnd = (await provider.getBlock('latest')).timestamp + Math.round(Number(process.env.COUNCIL_TERM_DAYS || 365) * 86_400);

  // The current rules, carried over; RULES overrides only what it names.
  const rules = new Map();
  if (dep.addresses.charter) {
    const [keys, values] = await at('Charter', dep.addresses.charter).allRules();
    keys.forEach((k, i) => rules.set(k, values[i].value));
  }
  for (const [k, v] of Object.entries(process.env.RULES ? JSON.parse(process.env.RULES) : {})) rules.set(ethers.id(k), BigInt(v));

  // 1. The council first, pointing at the voting contract about to be created (its address is known in advance).
  if (!m.council) {
    const nonce = await provider.getTransactionCount(me, 'pending');
    const voteAddress = ethers.getCreateAddress({ from: me, nonce: nonce + 2 }); // council, charter, then vote
    const ratifyGroup = await identity.groupId(2);
    const ratifyWindow = Math.round(Number(process.env.RATIFY_DAYS || 7) * 86_400);
    const council = await deploy(signer, 'Council', {}, members, threshold, delay, termEnd, voteAddress, ratifyGroup, ratifyWindow);
    m.council = await council.getAddress();
    m.expectedVote = voteAddress;
    save();
    console.log(`new council ${m.council} (terms end ${new Date(termEnd * 1000).toISOString().slice(0, 10)})`);
  }
  if (!m.charter) m.charter = await (await deploy(signer, 'Charter', {}, me, [...rules.keys()], [...rules.values()])).getAddress(), save();
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
  if (!m.officials) m.officials = await (await deploy(signer, 'Officials', {}, me, m.vote, dep.addresses.identity)).getAddress(), save();
  if (!m.bodies) m.bodies = await (await deploy(signer, 'Bodies', {}, me, m.vote, dep.addresses.identity)).getAddress(), save();
  console.log('contracts deployed');

  // 2. Wiring, done once, while the deployer can still do it directly.
  const registry = at('MandateRegistry', m.registry);
  const market = at('DecisionMarket', m.market);
  const vote = at('MandateVote', m.vote);
  const charter = at('Charter', m.charter);
  const budget = at('CivicBudget', m.budget);
  const officials = at('Officials', m.officials);
  const bodies = at('Bodies', m.bodies);
  const grant = async (k, role, who, label) => {
    if (!(await k.hasRole(role, who))) await send(label, k.grantRole(role, who));
  };
  const GOV = await registry.GOVERNOR_ROLE();
  await grant(registry, GOV, m.vote, 'public votes can create, pause, revise and repeal mandates');
  await grant(registry, GOV, m.market, 'markets can create mandates');
  await grant(market, await market.VETO_ROLE(), m.vote, 'public votes can veto market decisions');
  await grant(charter, await charter.GOVERNOR_ROLE(), m.vote, 'only a passed vote changes a rule');
  if ((await vote.delegates()) === ethers.ZeroAddress) await send('delegation uses the officials registry', vote.setDelegates(m.officials));
  const PROPOSER = await vote.PROPOSER_ROLE();
  await grant(vote, PROPOSER, m.feedback, 'petitions open their own polls');
  await grant(vote, PROPOSER, m.officials, 'emergency measures open ratification polls');
  await grant(vote, PROPOSER, m.bodies, 'agenda items open residents\' polls');
  await grant(vote, PROPOSER, m.council, 'emergency council changes open ratification polls');
  for (const a of [me, ...list(process.env.PROPOSERS)]) await grant(vote, PROPOSER, a, `${a} can open polls`);
  for (const a of [me, ...list(process.env.PROPOSERS)]) await grant(budget, await budget.PROPOSER_ROLE(), a, `${a} can open budget rounds`);
  for (const a of list(process.env.VERIFIERS)) await grant(registry, await registry.VERIFIER_ROLE(), a, `${a} is a mandate verifier`);
  for (const a of list(process.env.REGISTRARS || process.env.PROPOSERS)) {
    await grant(officials, await officials.REGISTRAR_ROLE(), a, `${a} registers officials`);
    await grant(bodies, await bodies.REGISTRAR_ROLE(), a, `${a} sets up government bodies`);
  }

  // The deployer's key sits on a server: it keeps no registrar role once real registrars exist.
  const registrars = list(process.env.REGISTRARS || process.env.PROPOSERS);
  if (registrars.length && !registrars.includes(me)) {
    for (const [label, k] of [['officials', officials], ['bodies', bodies]]) {
      const R = await k.REGISTRAR_ROLE();
      if (await k.hasRole(R, me)) await send(`deployer gave up registrar of ${label}`, k.renounceRole(R, me));
    }
  }

  // 3. Hand every admin power to the new council; the deployer keeps no admin role.
  for (const [label, k] of [['mandates', registry], ['markets', market], ['voting', vote], ['charter', charter], ['civic budget', budget], ['officials', officials], ['bodies', bodies]]) {
    await grant(k, ADMIN, m.council, `new council is admin of ${label}`);
    if (await k.hasRole(ADMIN, me)) await send(`deployer gave up admin of ${label}`, k.renounceRole(ADMIN, me));
  }

  // 4. The voter list moves through the council that holds it (a proposal for members to approve).
  const holderCouncil = at('Council', m.identityHolder);
  if (!m.identityProposal) {
    const why = 'Move the voter list to the new council (terms, emergency changes ratified by residents, government bodies)';
    const rc = await (await holderCouncil.propose(dep.addresses.identity, 0, identity.interface.encodeFunctionData('grantRole', [ADMIN, m.council]), why)).wait();
    m.identityProposal = proposedId(holderCouncil, rc);
    save();
    console.log(`council ${m.identityHolder} change #${m.identityProposal} proposed: ${why}`);
  }

  // 5. Publish: the app, relayer, identity service and watchdog follow the config.
  dep.previous ||= [];
  dep.previous.push({ replacedAt: new Date().toISOString(), council: dep.addresses.council, vote: dep.addresses.vote, registry: dep.addresses.registry, market: dep.addresses.market, charter: dep.addresses.charter, budget: dep.addresses.budget, feedback: dep.addresses.feedback, escrows: dep.addresses.escrows });
  Object.assign(dep.addresses, { council: m.council, charter: m.charter, vote: m.vote, registry: m.registry, market: m.market, budget: m.budget, feedback: m.feedback, escrows: m.escrows, officials: m.officials, bodies: m.bodies });
  dep.oldCouncilPending = { council: m.identityHolder, proposals: [m.identityProposal] };
  delete dep.migration;
  save();
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  Object.assign(cfg, {
    councilAddress: m.council, previousCouncilAddress: m.identityHolder, charterAddress: m.charter, voteAddress: m.vote, registryAddress: m.registry, marketAddress: m.market,
    budgetAddress: m.budget, feedbackAddress: m.feedback, escrowFactoryAddress: m.escrows, officialsAddress: m.officials, bodiesAddress: m.bodies,
  });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  console.log('done');
})().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
