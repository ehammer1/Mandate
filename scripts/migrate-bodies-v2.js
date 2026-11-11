#!/usr/bin/env node
/**
 * scripts/migrate-bodies-v2.js - replace the government-bodies contract with the version that
 * has roles (chair, clerks, staff) with end dates, seat terms, recusal, alternates, bodies
 * that vote on their own roles, and BodyRecords (drafts and closed sessions with sealed
 * minutes). Nothing else changes.
 *
 *   NETWORK=base-sepolia REGISTRARS=0xA NODE_USE_ENV_PROXY=1 node scripts/migrate-bodies-v2.js
 *
 * The new contract needs the voting contract's permission to open residents' polls; only the
 * council can give it, so this proposes it there (members approve it in the app). The old
 * bodies contract's permission is removed in a second proposal (removing power needs no wait).
 * Resumable: progress is saved in deployments/<NETWORK>.json under "bodiesMigration".
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
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || networks[name]?.rpcUrl, dep.chainId, { staticNetwork: true });
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
  const m = (dep.bodiesMigration ||= {});
  const council = at('Council', dep.addresses.council);
  const vote = at('MandateVote', dep.addresses.vote);
  if (!(await council.isMember(me))) throw new Error('the deployer must be a council member to propose the voting permission');

  if (!m.bodies) m.bodies = await (await deploy(signer, 'Bodies', {}, me, dep.addresses.vote, dep.addresses.identity)).getAddress(), save();
  if (!m.records) m.records = await (await deploy(signer, 'BodyRecords', {}, m.bodies, dep.addresses.notices)).getAddress(), save();
  if (!m.block) m.block = await provider.getBlockNumber(), save();
  const bodies = at('Bodies', m.bodies);
  const REG = await bodies.REGISTRAR_ROLE();
  const registrars = list(process.env.REGISTRARS || process.env.PROPOSERS);
  for (const a of registrars) if (!(await bodies.hasRole(REG, a))) await send(`${a} sets up government bodies`, bodies.grantRole(REG, a));
  if (registrars.length && !registrars.includes(me) && (await bodies.hasRole(REG, me))) await send('deployer gave up registrar', bodies.renounceRole(REG, me));
  if (!(await bodies.hasRole(ADMIN, dep.addresses.council))) await send('council is admin of bodies', bodies.grantRole(ADMIN, dep.addresses.council));
  if (await bodies.hasRole(ADMIN, me)) await send('deployer gave up admin of bodies', bodies.renounceRole(ADMIN, me));

  // The voting permission, through the council.
  const PROPOSER = await vote.PROPOSER_ROLE();
  const proposedId = (rc) => String(council.interface.parseLog(rc.logs.find((l) => l.topics[0] === council.interface.getEvent('Proposed').topicHash)).args.id);
  if (!m.grantProposal && !(await vote.hasRole(PROPOSER, m.bodies))) {
    const why = 'Let the new government-bodies contract open residents\' polls on agenda items (roles, recusal, alternates, closed sessions)';
    m.grantProposal = proposedId(await (await council.propose(dep.addresses.vote, 0, vote.interface.encodeFunctionData('grantRole', [PROPOSER, m.bodies]), why)).wait());
    save();
    console.log(`council change #${m.grantProposal} proposed: ${why}`);
  }
  if (!m.revokeProposal && dep.addresses.bodies && dep.addresses.bodies !== m.bodies && (await vote.hasRole(PROPOSER, dep.addresses.bodies))) {
    const why = 'Retire the previous government-bodies contract: it can no longer open polls';
    m.revokeProposal = proposedId(await (await council.propose(dep.addresses.vote, 0, vote.interface.encodeFunctionData('revokeRole', [PROPOSER, dep.addresses.bodies]), why)).wait());
    save();
    console.log(`council change #${m.revokeProposal} proposed: ${why}`);
  }

  // Publish.
  dep.previous ||= [];
  if (dep.addresses.bodies && dep.addresses.bodies !== m.bodies) dep.previous.push({ replacedAt: new Date().toISOString(), bodies: dep.addresses.bodies });
  Object.assign(dep.addresses, { bodies: m.bodies, bodyRecords: m.records });
  dep.pendingCouncilChanges = [m.grantProposal, m.revokeProposal].filter(Boolean);
  delete dep.bodiesMigration;
  save();
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  Object.assign(cfg, { bodiesAddress: m.bodies, bodyRecordsAddress: m.records });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  console.log('done');
})().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
