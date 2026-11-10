#!/usr/bin/env node
/**
 * scripts/upgrade-vote.js - replace the voting contract of a council-run deployment.
 *
 *   NETWORK=base-sepolia PROPOSERS=0xA,0xB node scripts/upgrade-vote.js
 *
 * Deploys a new MandateVote with the same voter list, verifier, bond token, treasury and
 * bond, lets PROPOSERS (and the deployer) open polls, hands its admin role to the council,
 * then proposes the council changes that move the old contract's powers to it:
 * create/repeal mandates (registry GOVERNOR) and veto markets (market VETO), granted to the
 * new contract and revoked from the old one. Members approve them in the app.
 * Updates deployments/<NETWORK>.json and the app config (old address kept as previousVote).
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const networks = require('./networks');
const { deploy } = require('./deploy');

const abi = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'build', `${n}.json`), 'utf8')).abi;

(async () => {
  const name = process.env.NETWORK || 'base-sepolia';
  const preset = networks[name];
  const ROOT = path.join(__dirname, '..');
  const depFile = path.join(ROOT, 'deployments', `${name}.json`);
  const cfgFile = path.join(ROOT, 'app', `config.${name}.json`);
  const dep = JSON.parse(fs.readFileSync(depFile, 'utf8'));
  if (!dep.addresses.council) throw new Error('this script is for council-run deployments');
  const provider = new ethers.JsonRpcProvider(preset?.rpcUrl || process.env.RPC_URL, dep.chainId, { staticNetwork: true });
  const signer = new ethers.NonceManager(new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider));
  const me = await signer.getAddress();
  const send = async (label, p) => {
    const tx = await p;
    await tx.wait();
    console.log(`${label}: ${tx.hash}`);
  };
  const old = new ethers.Contract(dep.addresses.vote, abi('MandateVote'), provider);
  const council = new ethers.Contract(dep.addresses.council, abi('Council'), signer);
  const registry = new ethers.Contract(dep.addresses.registry, abi('MandateRegistry'), provider);
  const market = new ethers.Contract(dep.addresses.market, abi('DecisionMarket'), provider);

  let vote;
  if (dep.pendingVote) {
    vote = new ethers.Contract(dep.pendingVote, abi('MandateVote'), signer);
  } else {
    const [identityAddr, verifier, bondToken, treasury, minBond] = await Promise.all([old.identity(), old.verifier(), old.bondToken(), old.treasury(), old.minBond()]);
    vote = await deploy(signer, 'MandateVote', {}, me, identityAddr, verifier, bondToken, treasury, minBond);
    dep.pendingVote = await vote.getAddress();
    fs.writeFileSync(depFile, JSON.stringify(dep, null, 2) + '\n'); // saved at once: a rerun reuses it
    console.log(`new voting contract: ${dep.pendingVote}`);
  }
  const va = await vote.getAddress();
  const PROPOSER = await vote.PROPOSER_ROLE();
  for (const a of [me, ...(process.env.PROPOSERS || '').split(',').filter(Boolean)].map((x) => ethers.getAddress(x.trim()))) {
    if (!(await vote.hasRole(PROPOSER, a))) await send(`${a} can open polls`, vote.grantRole(PROPOSER, a));
  }
  if (!(await vote.hasRole(ethers.ZeroHash, dep.addresses.council))) await send('council is admin of the new voting contract', vote.grantRole(ethers.ZeroHash, dep.addresses.council));
  if (await vote.hasRole(ethers.ZeroHash, me)) await send('deployer gave up admin', vote.renounceRole(ethers.ZeroHash, me));

  const GOVERNOR = await registry.GOVERNOR_ROLE();
  const VETO = await market.VETO_ROLE();
  const proposals = [
    [registry, 'grantRole', [GOVERNOR, va], 'Let the new voting contract (with cross-checked polls) create and repeal mandates when a binding poll passes'],
    [market, 'grantRole', [VETO, va], 'Let the new voting contract carry out public vetoes of market decisions'],
    [registry, 'revokeRole', [GOVERNOR, dep.addresses.vote], 'Retire the old voting contract: it can no longer create or repeal mandates'],
    [market, 'revokeRole', [VETO, dep.addresses.vote], 'Retire the old voting contract: it can no longer veto market decisions'],
  ];
  for (const [k, fn, args, why] of proposals) {
    const holds = await k.hasRole(args[0], args[1]);
    if ((fn === 'grantRole' && holds) || (fn === 'revokeRole' && !holds)) continue;
    const tx = await council.propose(await k.getAddress(), 0, k.interface.encodeFunctionData(fn, args), why);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return council.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'Proposed');
    console.log(`council change #${ev.args.id} proposed: ${why}`);
  }

  dep.previousVote = dep.addresses.vote;
  dep.addresses.vote = va;
  delete dep.pendingVote;
  fs.writeFileSync(depFile, JSON.stringify(dep, null, 2) + '\n');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.previousVoteAddress = cfg.voteAddress;
  cfg.voteAddress = va;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  console.log('done: the app, relayer and watchdog switch to the new contract when the config is published');
})().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
