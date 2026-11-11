#!/usr/bin/env node
/**
 * scripts/deploy-tallies.js - add paper and in-person results (Tallies) to a live deployment.
 * A standalone contract: nothing existing changes. Clerks get the role; the council becomes
 * admin; the deployer keeps nothing.
 *
 *   NETWORK=base-sepolia CLERKS=0xA,0xB NODE_USE_ENV_PROXY=1 node scripts/deploy-tallies.js
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
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const signer = new ethers.NonceManager(wallet);
  const me = wallet.address;
  const send = async (label, p) => console.log(`${label}: ${(await (await p).wait()).hash}`);
  const clerks = (process.env.CLERKS || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => ethers.getAddress(x));
  if (clerks.length < 2) throw new Error('give at least two CLERKS: one records, another confirms');
  if (!dep.addresses.tallies) {
    dep.addresses.tallies = await (await deploy(signer, 'Tallies', {}, me, dep.addresses.vote, dep.addresses.identity)).getAddress();
    fs.writeFileSync(depFile, JSON.stringify(dep, null, 2) + '\n');
    console.log(`tallies ${dep.addresses.tallies}`);
  }
  const t = new ethers.Contract(dep.addresses.tallies, JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'Tallies.json'), 'utf8')).abi, signer);
  const CLERK = await t.CLERK_ROLE();
  const ADMIN = ethers.ZeroHash;
  for (const a of clerks) if (!(await t.hasRole(CLERK, a))) await send(`${a} is a clerk`, t.grantRole(CLERK, a));
  if (!(await t.hasRole(ADMIN, dep.addresses.council))) await send('council is admin', t.grantRole(ADMIN, dep.addresses.council));
  if (!clerks.includes(me) && (await t.hasRole(CLERK, me))) await send('deployer gave up clerk', t.renounceRole(CLERK, me));
  if (await t.hasRole(ADMIN, me)) await send('deployer gave up admin', t.renounceRole(ADMIN, me));
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.talliesAddress = dep.addresses.tallies;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  console.log('done');
})().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
