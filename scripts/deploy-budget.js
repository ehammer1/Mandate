#!/usr/bin/env node
/**
 * scripts/deploy-budget.js - add civic budgeting (CivicBudget) to a council-run deployment.
 *
 *   NETWORK=base-sepolia PROPOSERS=0xA,0xB node scripts/deploy-budget.js
 *
 * PROPOSERS (and the deployer) may open budget rounds; the council becomes its admin and
 * the deployer gives up admin. Updates deployments/<NETWORK>.json and the app config.
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const networks = require('./networks');
const { deploy } = require('./deploy');

(async () => {
  const name = process.env.NETWORK || 'base-sepolia';
  const preset = networks[name];
  const ROOT = path.join(__dirname, '..');
  const depFile = path.join(ROOT, 'deployments', `${name}.json`);
  const cfgFile = path.join(ROOT, 'app', `config.${name}.json`);
  const dep = JSON.parse(fs.readFileSync(depFile, 'utf8'));
  if (!dep.addresses.council || !dep.addresses.charter) throw new Error('needs a council and a charter');
  const provider = new ethers.JsonRpcProvider(preset?.rpcUrl || process.env.RPC_URL, dep.chainId, { staticNetwork: true });
  const signer = new ethers.NonceManager(new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider));
  const me = await signer.getAddress();
  const send = async (label, p) => {
    const tx = await p;
    await tx.wait();
    console.log(`${label}: ${tx.hash}`);
  };
  let budget;
  if (dep.addresses.budget) {
    budget = new ethers.Contract(dep.addresses.budget, JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'CivicBudget.json'))).abi, signer);
  } else {
    budget = await deploy(signer, 'CivicBudget', {}, me, dep.addresses.identity, dep.addresses.verifier, dep.addresses.charter);
    dep.addresses.budget = await budget.getAddress();
    fs.writeFileSync(depFile, JSON.stringify(dep, null, 2) + '\n');
    console.log(`civic budget: ${dep.addresses.budget}`);
  }
  if (await budget.hasRole(ethers.ZeroHash, me)) {
    const P = await budget.PROPOSER_ROLE();
    for (const a of [me, ...(process.env.PROPOSERS || '').split(',').filter(Boolean)].map((x) => ethers.getAddress(x.trim()))) {
      if (!(await budget.hasRole(P, a))) await send(`${a} can open budget rounds`, budget.grantRole(P, a));
    }
    await send('council is admin of the civic budget', budget.grantRole(ethers.ZeroHash, dep.addresses.council));
    await send('deployer gave up admin', budget.renounceRole(ethers.ZeroHash, me));
  }
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.budgetAddress = dep.addresses.budget;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
})().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
