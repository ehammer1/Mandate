#!/usr/bin/env node
/**
 * scripts/deploy-mandate-tools.js - add the notice board and the budget escrow factory to
 * an existing deployment (neither needs an admin, so no council approval is involved).
 *
 *   NETWORK=base-sepolia node scripts/deploy-mandate-tools.js
 *
 * Overdue budgets drain to the council (or TREASURY). ESCROW_DECAY_BPS (default 1000 = 10%)
 * every ESCROW_DECAY_DAYS (default 7). Updates deployments/<NETWORK>.json and the app config.
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
  const provider = new ethers.JsonRpcProvider(preset?.rpcUrl || process.env.RPC_URL, dep.chainId, { staticNetwork: true });
  const signer = new ethers.NonceManager(new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider));
  const treasury = process.env.TREASURY || dep.addresses.council;
  if (!treasury) throw new Error('no council in this deployment: set TREASURY');
  if (!dep.addresses.notices) {
    dep.addresses.notices = await (await deploy(signer, 'NoticeBoard', {})).getAddress();
    fs.writeFileSync(depFile, JSON.stringify(dep, null, 2) + '\n');
    console.log(`notice board: ${dep.addresses.notices}`);
  }
  if (!dep.addresses.escrows) {
    const bps = Number(process.env.ESCROW_DECAY_BPS || 1000);
    const days = Number(process.env.ESCROW_DECAY_DAYS || 7);
    dep.addresses.escrows = await (await deploy(signer, 'EscrowFactory', {}, dep.addresses.registry, treasury, bps, Math.round(days * 86_400))).getAddress();
    fs.writeFileSync(depFile, JSON.stringify(dep, null, 2) + '\n');
    console.log(`escrow factory: ${dep.addresses.escrows} (overdue: ${bps / 100}% every ${days} days to ${treasury})`);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  Object.assign(cfg, { noticeBoardAddress: dep.addresses.notices, escrowFactoryAddress: dep.addresses.escrows });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
})().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
