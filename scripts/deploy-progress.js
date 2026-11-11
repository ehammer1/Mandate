#!/usr/bin/env node
/**
 * scripts/deploy-progress.js - add mandate progress updates (Progress) to a live deployment.
 * A standalone contract with no admin: only each mandate's responsible party (as the mandate
 * registry records it) can write. Nothing existing changes and no council approval is needed.
 *
 *   NETWORK=base-sepolia NODE_USE_ENV_PROXY=1 node scripts/deploy-progress.js
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const networks = require('./networks');
const { deploy } = require('./deploy');

const ROOT = path.join(__dirname, '..');
(async () => {
  const name = process.env.NETWORK || 'base-sepolia';
  const depFile = path.join(ROOT, 'deployments', `${name}.json`);
  const cfgFile = path.join(ROOT, 'app', `config.${name}.json`);
  const dep = JSON.parse(fs.readFileSync(depFile, 'utf8'));
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || networks[name]?.rpcUrl, dep.chainId, { staticNetwork: true });
  const signer = new ethers.NonceManager(new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider));
  if (!dep.addresses.progress) {
    dep.addresses.progress = await (await deploy(signer, 'Progress', {}, dep.addresses.registry)).getAddress();
    fs.writeFileSync(depFile, JSON.stringify(dep, null, 2) + '\n');
  }
  console.log(`progress ${dep.addresses.progress}`);
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.progressAddress = dep.addresses.progress;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  console.log('done');
})().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
