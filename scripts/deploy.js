#!/usr/bin/env node
/**
 * scripts/deploy.js - deploy the whole Mandate stack and write the web app's config.
 *
 *   RPC_URL=... DEPLOYER_PRIVATE_KEY=... node scripts/deploy.js
 *
 * Optional env:
 *   SEASONING_DAYS     default 30
 *   MIN_BOND           proposal bond in play credits, default 100
 *   TREASURY           address receiving forfeited bonds and clawbacks (default: deployer)
 *   RELAYERS           comma-separated relayer URLs for the app config
 *   IPFS_GATEWAY       default https://gateway.pinata.cloud
 *   ARTIFACTS_BASE     URL of Semaphore proving files for the app (default: download on demand)
 *
 * Writes deployments/<chainId>.json and app/config.json. The deployer is admin
 * of everything; hand admin roles to a timelock before any real use.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..');
const art = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'build', `${n}.json`), 'utf8'));

function link(bytecode, linkReferences, libs) {
  let out = bytecode.slice(2);
  for (const names of Object.values(linkReferences || {})) {
    for (const [name, refs] of Object.entries(names)) {
      if (!libs[name]) throw new Error(`missing library ${name}`);
      const addr = libs[name].slice(2).toLowerCase();
      for (const { start } of refs) out = out.slice(0, start * 2) + addr + out.slice(start * 2 + 40);
    }
  }
  return '0x' + out;
}

async function deploy(signer, name, libs, ...args) {
  const a = art(name);
  const factory = new ethers.ContractFactory(a.abi, link(a.bytecode, a.linkReferences, libs), signer);
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  return c;
}

/**
 * Deploy and wire every contract. Returns the contracts and an address map.
 * @param {ethers.Signer} signer
 * @param {{ seasoningDays?: number, minBond?: bigint, treasury?: string, log?: (m: string) => void }} [opts]
 */
async function deployAll(signer, opts = {}) {
  const log = opts.log || (() => {});
  const me = await signer.getAddress();
  const treasury = opts.treasury || me;
  const seasoning = BigInt(opts.seasoningDays ?? 30) * 86_400n;
  const minBond = opts.minBond ?? ethers.parseEther('100');
  const send = async (p) => (await p).wait();

  const poseidon = await deploy(signer, 'PoseidonT3', {});
  const verifier = await deploy(signer, 'SemaphoreVerifier', {});
  const semaphore = await deploy(signer, 'Semaphore', { PoseidonT3: await poseidon.getAddress() }, await verifier.getAddress());
  log('semaphore deployed');
  const identity = await deploy(signer, 'IdentityRegistry', {}, me, await semaphore.getAddress(), seasoning);
  const credits = await deploy(signer, 'PlayCredits', {}, me);
  const registry = await deploy(signer, 'MandateRegistry', {}, me);
  const vote = await deploy(signer, 'MandateVote', {}, me, await identity.getAddress(), await verifier.getAddress(), await credits.getAddress(), treasury, minBond);
  const market = await deploy(signer, 'DecisionMarket', {}, me, await credits.getAddress(), await registry.getAddress());
  log('mandate contracts deployed');

  // Wiring: the public vote can create/repeal mandates and veto markets; markets can create mandates.
  await send(registry.grantRole(await registry.GOVERNOR_ROLE(), await vote.getAddress()));
  await send(registry.grantRole(await registry.GOVERNOR_ROLE(), await market.getAddress()));
  await send(market.grantRole(await market.VETO_ROLE(), await vote.getAddress()));
  await send(vote.grantRole(await vote.PROPOSER_ROLE(), me));
  log('roles granted');

  const contracts = { semaphore, verifier, identity, credits, registry, vote, market };
  const addresses = {};
  for (const [k, c] of Object.entries(contracts)) addresses[k] = await c.getAddress();
  return { contracts, addresses };
}

module.exports = { deployAll, link };

if (require.main === module) {
  require('dotenv').config();
  (async () => {
    const need = (n) => process.env[n] || (console.error(`missing env ${n}`), process.exit(2));
    const provider = new ethers.JsonRpcProvider(need('RPC_URL'));
    const signer = new ethers.Wallet(need('DEPLOYER_PRIVATE_KEY'), provider);
    const { chainId } = await provider.getNetwork();
    const { addresses } = await deployAll(signer, {
      seasoningDays: Number(process.env.SEASONING_DAYS || 30),
      minBond: ethers.parseEther(process.env.MIN_BOND || '100'),
      treasury: process.env.TREASURY,
      log: (m) => console.log(`[deploy] ${m}`),
    });
    fs.mkdirSync(path.join(ROOT, 'deployments'), { recursive: true });
    const record = { chainId: Number(chainId), deployedAt: new Date().toISOString(), addresses };
    fs.writeFileSync(path.join(ROOT, 'deployments', `${chainId}.json`), JSON.stringify(record, null, 2));
    const appConfig = {
      chainId: Number(chainId),
      rpcUrl: process.env.RPC_URL,
      voteAddress: addresses.vote,
      identityAddress: addresses.identity,
      creditsAddress: addresses.credits,
      relayers: (process.env.RELAYERS || '').split(',').map((s) => s.trim()).filter(Boolean),
      ipfsGateway: process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud',
      artifactsBase: process.env.ARTIFACTS_BASE || '',
    };
    fs.writeFileSync(path.join(ROOT, 'app', 'config.json'), JSON.stringify(appConfig, null, 2));
    console.log(JSON.stringify(record, null, 2));
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
