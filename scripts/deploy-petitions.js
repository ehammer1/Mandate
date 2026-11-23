#!/usr/bin/env node
/**
 * scripts/deploy-petitions.js - add petitions to deliver (PublicPetitions) to a live community.
 * A standalone contract with no admin: anyone on the community's voter list signs, files or
 * receives with an anonymous proof. Nothing existing changes and no council approval is needed.
 *
 *   NETWORK=base-sepolia NODE_USE_ENV_PROXY=1 node scripts/deploy-petitions.js          (main community)
 *   NETWORK=base-sepolia NODE_USE_ENV_PROXY=1 node scripts/deploy-petitions.js demo     (a community by its slug)
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
  if (!dep.addresses.petitions) {
    dep.addresses.petitions = await (await deploy(signer, 'PublicPetitions', {}, dep.addresses.identity)).getAddress();
    fs.writeFileSync(depFile, JSON.stringify(dep, null, 2) + '\n');
  }
  cfg.petitionsAddress = dep.addresses.petitions;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`${slug || 'main'}: petitions ${dep.addresses.petitions}; restart the relayer so it picks it up`);
})().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
