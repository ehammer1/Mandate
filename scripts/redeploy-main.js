#!/usr/bin/env node
/**
 * scripts/redeploy-main.js - move the main community (the one at the app's root address) to the
 * latest contracts with a fresh deployment, the way the demo was moved. Its council, roles and
 * voting rules come from communities/main.json; every other setting in the app's config (sign-in,
 * explanations, feeds, the community plan…) is kept, and only the contract addresses and start
 * block change. The old addresses stay on record under "previous" in deployments/<network>.json.
 * Residents rejoin once (the voter list is new); their voter codes are the same.
 *
 *   NETWORK=base-sepolia SIGNUP_ISSUER=0x… NODE_USE_ENV_PROXY=1 node scripts/redeploy-main.js
 */
'use strict';

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { createCommunity, communityConfig, PatientProvider, finishHandover, attach, normalizeSpec } = require('./new-community');

const ROOT = path.join(__dirname, '..');

/** The app config with the new contracts' addresses in place of the old ones; nothing else changes. */
function mergeConfig(old, fresh) {
  const out = { ...old };
  for (const [k, v] of Object.entries(fresh)) if (/Address$/.test(k) && v) out[k] = v;
  out.startBlock = fresh.startBlock;
  if (fresh.keepSignedIn) out.keepSignedIn = true;
  return out;
}

async function main() {
  const name = process.env.NETWORK || 'base-sepolia';
  const preset = require('./networks')[name];
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'communities', 'main.json'), 'utf8'));
  const cfgFile = path.join(ROOT, 'app', `config.${name}.json`);
  const depFile = path.join(ROOT, 'deployments', `${name}.json`);
  const provider = new PatientProvider(preset.rpcUrl, preset.chainId, { staticNetwork: true });
  const signer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const log = (m) => console.log(`[main] ${m}`);
  // Progress is saved as it goes, so a dropped connection can be finished with --resume.
  const partial = path.join(ROOT, 'deployments', `${name}-main.partial.json`);
  let addresses, startBlock;
  if (process.argv.includes('--resume')) {
    if (!fs.existsSync(partial)) throw new Error(`nothing to resume (no ${path.relative(ROOT, partial)})`);
    ({ addresses, startBlock } = JSON.parse(fs.readFileSync(partial, 'utf8')));
    if (!addresses.council) throw new Error('the council was never deployed: start over (without --resume)');
    const runner = new ethers.NonceManager(signer);
    await finishHandover(runner, attach(runner, addresses), normalizeSpec(spec), { log });
  } else {
    ({ addresses, startBlock } = await createCommunity(signer, spec, { signupIssuer: process.env.SIGNUP_ISSUER, log, onProgress: (x) => fs.writeFileSync(partial, JSON.stringify(x, null, 2) + '\n') }));
  }
  const old = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const fresh = communityConfig(spec, addresses, startBlock, old, {});
  fs.writeFileSync(cfgFile, JSON.stringify(mergeConfig(old, fresh), null, 2) + '\n');
  const prevDep = JSON.parse(fs.readFileSync(depFile, 'utf8'));
  const { previous: older, ...prevRest } = prevDep;
  const record = { network: name, chainId: preset.chainId, startBlock, deployedAt: new Date().toISOString(), deployer: signer.address, addresses, previous: { ...prevRest, ...(older ? { previous: older } : {}) } };
  fs.writeFileSync(depFile, JSON.stringify(record, null, 2) + '\n');
  fs.rmSync(partial, { force: true });
  console.log(`[main] done: ${cfgFile} and ${depFile} updated; publish by pushing`);
}

module.exports = { mergeConfig };

if (require.main === module) {
  main().catch((e) => {
    console.error(e.shortMessage || e.message);
    process.exit(1);
  });
}
