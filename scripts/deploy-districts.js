#!/usr/bin/env node
/**
 * scripts/deploy-districts.js - add results by district (Districts) to a live community.
 * A standalone contract with no admin: those who create voter lists mark which are districts;
 * residents add their district to their own ballot or signature. Nothing existing changes.
 * DISTRICT_MIN_MEMBERS (default 50): how many people a district's list needs before it is counted.
 *
 *   NETWORK=base-sepolia NODE_USE_ENV_PROXY=1 node scripts/deploy-districts.js          (main community)
 *   NETWORK=base-sepolia DISTRICT_MIN_MEMBERS=3 NODE_USE_ENV_PROXY=1 node scripts/deploy-districts.js demo
 */
'use strict';

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const networks = require('./networks');
const { deploy } = require('./deploy');
const { PatientProvider } = require('./new-community');

const ROOT = path.join(__dirname, '..');
(async () => {
  const name = process.env.NETWORK || 'base-sepolia';
  const slug = process.argv[2];
  const depFile = slug ? path.join(ROOT, 'deployments', 'communities', `${name}-${slug}.json`) : path.join(ROOT, 'deployments', `${name}.json`);
  const cfgFile = slug ? path.join(ROOT, 'app', 'communities', `${slug}.json`) : path.join(ROOT, 'app', `config.${name}.json`);
  const dep = JSON.parse(fs.readFileSync(depFile, 'utf8'));
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const provider = new PatientProvider(process.env.RPC_URL || networks[name]?.rpcUrl, networks[name]?.chainId || dep.chainId, { staticNetwork: true });
  const signer = new ethers.NonceManager(new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider));
  if (!dep.addresses.districts) {
    dep.addresses.districts = await (await deploy(signer, 'Districts', {}, dep.addresses.voterGroups, Number(process.env.DISTRICT_MIN_MEMBERS || 50))).getAddress();
    fs.writeFileSync(depFile, JSON.stringify(dep, null, 2) + '\n');
  }
  cfg.districtsAddress = dep.addresses.districts;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`${slug || 'main'}: districts ${dep.addresses.districts}; restart the relayer so it picks it up`);
})().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
