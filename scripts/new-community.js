#!/usr/bin/env node
/**
 * scripts/new-community.js - set up a new community (a city, a school board, a union local, an
 * association) with its own contracts, served by the same app and services as everyone else.
 *
 *   NETWORK=base-sepolia NODE_USE_ENV_PROXY=1 node scripts/new-community.js communities/lincoln-high.json
 *
 * The spec file (see communities/example.json) names the community and its people: council
 * members, clerks, poll openers. The script deploys the community's contracts, gives each person
 * their role, then hands every admin power to the community's own council: the deployer (and you)
 * keep nothing. It writes app/communities/<slug>.json (the app opens it at ?org=<slug>) and adds
 * the community to app/communities/index.json, which the relay, sign-up service and watchdog follow.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { deployAll, deploy } = require('./deploy');
const { handOver } = require('./council-lib');

const ROOT = path.join(__dirname, '..');
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED = new Set(['default', 'index', 'example', 'config', 'admin', 'api']);

/** Check a spec and fill in defaults; throws with a plain message on anything missing. */
function normalizeSpec(spec) {
  const s = { ...spec };
  if (!SLUG.test(String(s.slug || '')) || RESERVED.has(s.slug)) throw new Error('slug: 2-40 lowercase letters, digits and dashes (e.g. "lincoln-high"), not a reserved word');
  if (!String(s.name || '').trim()) throw new Error('name: the community\'s name, e.g. "Lincoln High School PTA"');
  const addrs = (list, what) => (list || []).map((a) => {
    const v = typeof a === 'string' ? a : a?.address;
    if (!ethers.isAddress(v || '')) throw new Error(`${what}: "${v}" is not an account address (0x followed by 40 characters)`);
    return ethers.getAddress(v);
  });
  const c = s.council || {};
  const members = addrs(c.members, 'council.members');
  if (!members.length) throw new Error('council.members: at least one council member is needed (3 to 5 is better)');
  if (new Set(members).size !== members.length) throw new Error('council.members: an address is listed twice');
  const threshold = c.threshold ?? Math.floor(members.length / 2) + 1;
  if (!(threshold >= 1 && threshold <= members.length)) throw new Error('council.threshold: between 1 and the number of members');
  s.council = { members, threshold, delaySeconds: Math.round(Number(c.delayHours ?? 24) * 3600), termDays: Number(c.termDays || 0), ratifyDays: Number(c.ratifyDays ?? 7) };
  s.clerks = (s.clerks || []).map((k) => ({ address: addrs([k], 'clerks')[0], name: String(k.name || 'Clerk desk').slice(0, 60), fullRights: k.fullRights !== false }));
  s.pollOpeners = addrs(s.pollOpeners, 'pollOpeners');
  s.registrars = addrs(s.registrars, 'registrars');
  s.groupCreators = addrs(s.groupCreators, 'groupCreators');
  s.tallyClerks = addrs(s.tallyClerks ?? s.clerks.map((k) => k.address), 'tallyClerks');
  s.onlineSignup = s.onlineSignup !== false;
  s.seasoningDays = Number(s.seasoningDays ?? 30);
  if (!(s.seasoningDays >= 1 && s.seasoningDays <= 365)) throw new Error('seasoningDays: the new-member wait before full voting rights, 1 to 365 days');
  return s;
}

/**
 * Deploy one community and hand it to its council.
 * @param {ethers.Signer} signer   pays the network fees; keeps no role afterwards
 * @param {object} spec            see normalizeSpec / communities/example.json
 * @param {{ signupIssuer?: string, log?: Function }} [o]  signupIssuer: the shared sign-up service's issuer address
 * @returns {Promise<{ addresses: object, council: string, startBlock: number }>}
 */
async function createCommunity(signer, spec, o = {}) {
  const s = normalizeSpec(spec);
  const log = o.log || (() => {});
  const startBlock = await signer.provider.getBlockNumber();
  const { contracts: c, addresses } = await deployAll(signer, { seasoningDays: s.seasoningDays, rules: s.rules, minBond: s.minBond !== undefined ? ethers.parseEther(String(s.minBond)) : undefined, nonceManager: true, log });
  // deployAll wraps the signer; use its contracts' runner for everything that follows.
  const runner = c.vote.runner;
  const me = await runner.getAddress();
  const send = async (label, p) => (await (await p).wait(), log(label));
  const grant = async (k, role, who, label) => (await k.hasRole(role, who)) || send(label, k.grantRole(role, who));

  // 1. People and their roles, while the deployer can still grant them.
  for (const k of s.clerks) await send(`clerk desk "${k.name}" ${k.address}`, c.identity.setIssuer(k.address, k.fullRights ? 1 : 0, true, k.name));
  if (s.onlineSignup && o.signupIssuer && ethers.isAddress(o.signupIssuer)) await send('online sign-up enabled', c.identity.setIssuer(ethers.getAddress(o.signupIssuer), 0, true, 'Online sign-up'));
  const P = await c.vote.PROPOSER_ROLE();
  const BP = await c.budget.PROPOSER_ROLE();
  for (const a of s.pollOpeners) {
    await grant(c.vote, P, a, `${a} can open polls`);
    await grant(c.budget, BP, a, `${a} can open budget rounds`);
  }
  for (const a of s.registrars) {
    await grant(c.officials, await c.officials.REGISTRAR_ROLE(), a, `${a} registers officials`);
    await grant(c.bodies, await c.bodies.REGISTRAR_ROLE(), a, `${a} sets up government bodies`);
  }
  for (const a of s.tallyClerks) await grant(c.tallies, await c.tallies.CLERK_ROLE(), a, `${a} records paper counts`);
  for (const a of s.groupCreators) await grant(c.voterGroups, await c.voterGroups.GROUP_CREATOR_ROLE(), a, `${a} creates smaller voter lists`);

  // 2. The community's council, which takes every admin power.
  const termEnd = s.council.termDays ? (await signer.provider.getBlock('latest')).timestamp + Math.round(s.council.termDays * 86_400) : 0;
  c.council = await deploy(runner, 'Council', {}, s.council.members, s.council.threshold, s.council.delaySeconds, termEnd, await c.vote.getAddress(), await c.identity.groupId(2), Math.round(s.council.ratifyDays * 86_400));
  const council = await c.council.getAddress();
  addresses.council = council;
  await grant(c.vote, P, council, 'council can open emergency ratification polls');
  await handOver(runner, c, council, { log });

  // 3. The deployer gives up everything else it was given while setting up.
  const drop = async (k, role, label) => (await k.hasRole(role, me)) && send(label, k.renounceRole(role, me));
  await drop(c.vote, P, 'deployer gave up opening polls');
  await drop(c.budget, BP, 'deployer gave up budget rounds');
  await drop(c.officials, await c.officials.REGISTRAR_ROLE(), 'deployer gave up registering officials');
  await drop(c.bodies, await c.bodies.REGISTRAR_ROLE(), 'deployer gave up setting up bodies');
  await drop(c.voterGroups, await c.voterGroups.GROUP_CREATOR_ROLE(), 'deployer gave up creating voter lists');
  await drop(c.tallies, await c.tallies.CLERK_ROLE(), 'deployer gave up recording counts');
  log(`council ${council} (${s.council.threshold} of ${s.council.members.length}) now holds every admin power`);
  return { addresses, council, startBlock, spec: s };
}

/** The app's settings for this community: its own addresses, the shared network and services. */
function communityConfig(spec, addresses, startBlock, base = {}, services = {}) {
  const trim = (u) => String(u || '').replace(/\/+$/, '');
  return {
    communityName: spec.name,
    communitySlug: spec.slug,
    ...(spec.type ? { communityType: spec.type } : {}),
    chainId: base.chainId,
    chainName: base.chainName,
    rpcUrl: base.rpcUrl,
    explorer: base.explorer || '',
    startBlock,
    voteAddress: addresses.vote,
    identityAddress: addresses.identity,
    creditsAddress: addresses.credits,
    registryAddress: addresses.registry,
    marketAddress: addresses.market,
    councilAddress: addresses.council,
    noticeBoardAddress: addresses.notices,
    charterAddress: addresses.charter,
    budgetAddress: addresses.budget,
    feedbackAddress: addresses.feedback,
    officialsAddress: addresses.officials,
    bodiesAddress: addresses.bodies,
    bodyRecordsAddress: addresses.bodyRecords,
    talliesAddress: addresses.tallies,
    progressAddress: addresses.progress,
    voterGroupsAddress: addresses.voterGroups,
    escrowFactoryAddress: addresses.escrows,
    relayers: (services.relayers || []).map((u) => `${trim(u)}/c/${spec.slug}`),
    identityService: services.identity ? `${trim(services.identity)}/c/${spec.slug}` : '',
    watchdogAlertsUrl: services.watchdogBase ? `${trim(services.watchdogBase)}/c/${spec.slug}/alerts.json` : '',
    ipfsGateway: base.ipfsGateway || 'https://gateway.pinata.cloud',
    artifactsBase: base.artifactsBase || '',
    walletConnectProjectId: base.walletConnectProjectId || '',
    ...(base.analyticsUrl ? { analyticsUrl: base.analyticsUrl } : {}),
    ...(spec.languages ? { languages: spec.languages } : {}),
  };
}

/** Add or update the community in the list the services follow. */
function addToIndex(indexFile, spec) {
  let index = { communities: [] };
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  } catch {
    /* first community */
  }
  index.communities = (index.communities || []).filter((x) => x.slug !== spec.slug);
  index.communities.push({ slug: spec.slug, name: spec.name, ...(spec.type ? { type: spec.type } : {}), addedAt: new Date().toISOString().slice(0, 10) });
  index.communities.sort((a, b) => a.slug.localeCompare(b.slug));
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
}

module.exports = { normalizeSpec, createCommunity, communityConfig, addToIndex };

if (require.main === module) {
  require('dotenv').config();
  (async () => {
    const file = process.argv[2];
    if (!file) throw new Error('usage: node scripts/new-community.js <spec.json>   (see communities/example.json)');
    const spec = normalizeSpec(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
    const network = process.env.NETWORK || 'base-sepolia';
    const networks = require('./networks');
    const preset = networks[network];
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', `config.${network}.json`), 'utf8'));
    const outDir = path.join(ROOT, 'app', 'communities');
    const target = path.join(outDir, `${spec.slug}.json`);
    if (fs.existsSync(target) && process.env.REPLACE !== '1') throw new Error(`${spec.slug} already exists (set REPLACE=1 to deploy it again)`);
    if (preset && !preset.testnet && process.env.CONFIRM_MAINNET !== 'yes') throw new Error('refusing a mainnet deploy without CONFIRM_MAINNET=yes');
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || base.rpcUrl, base.chainId, { staticNetwork: true });
    const signer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
    console.log(`[community] creating "${spec.name}" (${spec.slug}) on ${network} from ${signer.address}, balance ${ethers.formatEther(await provider.getBalance(signer.address))} ETH`);
    const services = {
      relayers: (base.relayers || []).map((u) => u.replace(/\/c\/[^/]+\/?$/, '')),
      identity: (base.identityService || '').replace(/\/c\/[^/]+\/?$/, ''),
      watchdogBase: (base.watchdogAlertsUrl || '').replace(/\/alerts\.json$/, ''),
    };
    const { addresses, startBlock } = await createCommunity(signer, spec, { signupIssuer: process.env.SIGNUP_ISSUER || spec.signupIssuer, log: (m) => console.log(`[community] ${m}`) });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(communityConfig(spec, addresses, startBlock, base, services), null, 2) + '\n');
    addToIndex(path.join(outDir, 'index.json'), spec);
    const depDir = path.join(ROOT, 'deployments', 'communities');
    fs.mkdirSync(depDir, { recursive: true });
    fs.writeFileSync(path.join(depDir, `${network}-${spec.slug}.json`), JSON.stringify({ network, slug: spec.slug, name: spec.name, startBlock, deployedAt: new Date().toISOString(), deployer: signer.address, addresses }, null, 2) + '\n');
    const appUrl = (process.env.APP_URL || 'https://ehammer1.github.io/Mandate/').replace(/\/?$/, '/');
    console.log(`[community] done. App: ${appUrl}?org=${spec.slug}`);
    if (services.identity) console.log(`[community] if this community uses Google or Microsoft sign-in, add this callback to those sign-in apps: ${services.identity}/c/${spec.slug}/callback`);
  })().catch((e) => {
    console.error(`[community] ${e.shortMessage || e.message}`);
    process.exit(1);
  });
}
