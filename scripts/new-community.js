#!/usr/bin/env node
/**
 * scripts/new-community.js - set up a new community (a city, a school board, a union local, an
 * association) with its own contracts, served by the same app and services as everyone else.
 *
 *   NETWORK=base-sepolia NODE_USE_ENV_PROXY=1 node scripts/new-community.js communities/lincoln-high.json
 *   ... node scripts/new-community.js communities/lincoln-high.json --resume   (finish one that stopped partway)
 *   node scripts/new-community.js --domain lincoln-high vote.lincolnhigh.org  (give it its own web address)
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

const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A community's own web address, e.g. "vote.lincolnhigh.org" ('' for none). */
function normalizeDomain(d) {
  if (d === undefined || d === null || d === '') return '';
  const h = String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!HOST.test(h) || /(^|\.)github\.io$/.test(h)) throw new Error(`domain: "${d}" is not a web address like vote.lincolnhigh.org`);
  return h;
}

/** Where members open this community: its own address, or the shared app with ?org=. */
const appUrlFor = (spec, sharedAppUrl = 'https://ehammer1.github.io/Mandate/') =>
  spec.domain ? `https://${spec.domain}/` : `${sharedAppUrl.replace(/\/?$/, '/')}?org=${spec.slug}`;

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
  s.domain = normalizeDomain(s.domain);
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
  o.onProgress?.({ addresses, startBlock }); // so a dropped connection can be finished with --resume
  // deployAll wraps the signer; use its contracts' runner for everything that follows.
  const runner = c.vote.runner;
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
  o.onProgress?.({ addresses, startBlock });
  await grant(c.vote, P, council, 'council can open emergency ratification polls');
  await finishHandover(runner, c, s, { log });
  return { addresses, council, startBlock, spec: s };
}

/**
 * The last part of setting up: the council takes every admin power and the deployer gives up the
 * rest. Safe to run again: each step is skipped if already done.
 */
async function finishHandover(runner, c, s, { log = () => {} } = {}) {
  const me = await runner.getAddress();
  const council = await c.council.getAddress();
  const send = async (label, p) => (await (await p).wait(), log(label));
  const P = await c.vote.PROPOSER_ROLE();
  const BP = await c.budget.PROPOSER_ROLE();
  await handOver(runner, c, council, { log });

  // The deployer gives up everything else it was given while setting up.
  const drop = async (k, role, label) => (await k.hasRole(role, me)) && send(label, k.renounceRole(role, me));
  await drop(c.vote, P, 'deployer gave up opening polls');
  await drop(c.budget, BP, 'deployer gave up budget rounds');
  await drop(c.officials, await c.officials.REGISTRAR_ROLE(), 'deployer gave up registering officials');
  await drop(c.bodies, await c.bodies.REGISTRAR_ROLE(), 'deployer gave up setting up bodies');
  await drop(c.voterGroups, await c.voterGroups.GROUP_CREATOR_ROLE(), 'deployer gave up creating voter lists');
  await drop(c.tallies, await c.tallies.CLERK_ROLE(), 'deployer gave up recording counts');
  log(`council ${council} (${s.council.threshold} of ${s.council.members.length}) now holds every admin power`);
}

/** A provider that waits and retries when a public network says "too many requests". */
class PatientProvider extends ethers.JsonRpcProvider {
  async _send(payload) {
    for (let i = 0; ; i++) {
      const out = await super._send(payload);
      const limited = out.some((r) => r.error && (r.error.code === -32007 || r.error.code === 429 || /limit|rate/i.test(r.error.message || '')));
      if (!limited || i >= 8) return out;
      await new Promise((r) => setTimeout(r, 500 * 2 ** Math.min(i, 4)));
    }
  }
}

/** Contracts at known addresses (for --resume). */
function attach(runner, addresses) {
  const abi = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'build', `${n}.json`), 'utf8')).abi;
  const names = { identity: 'IdentityRegistry', registry: 'MandateRegistry', vote: 'MandateVote', market: 'DecisionMarket', charter: 'Charter', budget: 'CivicBudget', officials: 'Officials', bodies: 'Bodies', tallies: 'Tallies', voterGroups: 'VoterGroups', credits: 'PlayCredits', council: 'Council' };
  const c = {};
  for (const [k, n] of Object.entries(names)) if (addresses[k]) c[k] = new ethers.Contract(addresses[k], abi(n), runner);
  return c;
}

/** The app's settings for this community: its own addresses, the shared network and services. */
function communityConfig(spec, addresses, startBlock, base = {}, services = {}) {
  const trim = (u) => String(u || '').replace(/\/+$/, '');
  return {
    communityName: spec.name,
    communitySlug: spec.slug,
    appUrl: appUrlFor(spec, services.appUrl),
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
  const before = (index.communities || []).find((x) => x.slug === spec.slug);
  index.communities = (index.communities || []).filter((x) => x.slug !== spec.slug);
  const domain = spec.domain === undefined ? before?.domain : spec.domain;
  if (domain && index.communities.some((x) => x.domain === domain)) throw new Error(`domain: ${domain} is already used by another community`);
  index.communities.push({ slug: spec.slug, name: spec.name, ...(spec.type ? { type: spec.type } : {}), ...(domain ? { domain } : {}), addedAt: before?.addedAt || new Date().toISOString().slice(0, 10) });
  index.communities.sort((a, b) => a.slug.localeCompare(b.slug));
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
}

/** Give an existing community its own web address (or take it away with ''), in both files. */
function setDomain(outDir, slug, domain) {
  const file = path.join(outDir, `${slug}.json`);
  if (!fs.existsSync(file)) throw new Error(`no community called "${slug}" (expected ${file})`);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const d = normalizeDomain(domain);
  const shared = String(cfg.appUrl || '').includes('?org=') ? cfg.appUrl.split('?')[0] : undefined;
  addToIndex(path.join(outDir, 'index.json'), { slug, name: cfg.communityName, type: cfg.communityType, domain: d });
  cfg.appUrl = appUrlFor({ slug, domain: d }, shared);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return cfg.appUrl;
}

/** What to tell the organization's IT person (or whoever runs their domain). */
function domainSteps(domain, pagesHost) {
  const sub = domain.split('.').length > 2;
  return [
    `At the company that runs ${domain.split('.').slice(-2).join('.')} (GoDaddy, Namecheap, Cloudflare, Google Domains...), add one DNS record:`,
    sub ? `  type CNAME, name "${domain.split('.')[0]}", value "${pagesHost}"` : `  ${domain} is a whole domain: use a sub-address like vote.${domain} instead, or point the domain at ${pagesHost} with the company's "CNAME flattening" or "ALIAS" record`,
    `Then add ${domain} to the Cloudflare Pages project (Custom domains -> Set up a domain). The padlock (https) appears by itself within an hour.`,
  ];
}

module.exports = { PatientProvider, normalizeSpec, normalizeDomain, createCommunity, finishHandover, attach, communityConfig, addToIndex, setDomain, domainSteps };

if (require.main === module) {
  require('dotenv').config();
  (async () => {
    if (process.argv[2] === '--domain') {
      // node scripts/new-community.js --domain <slug> <vote.example.org | "">
      const [, , , slug, domain = ''] = process.argv;
      const url = setDomain(path.join(ROOT, 'app', 'communities'), slug, domain);
      console.log(`[community] ${slug} now opens at ${url}`);
      if (domain) for (const l of domainSteps(normalizeDomain(domain), process.env.PAGES_HOST || 'promissa.pages.dev')) console.log(`[community] ${l}`);
      return;
    }
    const file = process.argv[2];
    if (!file) throw new Error('usage: node scripts/new-community.js <spec.json>   (see communities/example.json)');
    const spec = normalizeSpec(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
    const network = process.env.NETWORK || 'base-sepolia';
    const networks = require('./networks');
    const preset = networks[network];
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', `config.${network}.json`), 'utf8'));
    const outDir = path.join(ROOT, 'app', 'communities');
    const target = path.join(outDir, `${spec.slug}.json`);
    if (fs.existsSync(target) && process.env.REPLACE !== '1' && !process.argv.includes('--resume')) throw new Error(`${spec.slug} already exists (set REPLACE=1 to deploy it again)`);
    if (preset && !preset.testnet && process.env.CONFIRM_MAINNET !== 'yes') throw new Error('refusing a mainnet deploy without CONFIRM_MAINNET=yes');
    const provider = new PatientProvider(process.env.RPC_URL || base.rpcUrl, base.chainId, { staticNetwork: true });
    const signer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
    console.log(`[community] creating "${spec.name}" (${spec.slug}) on ${network} from ${signer.address}, balance ${ethers.formatEther(await provider.getBalance(signer.address))} ETH`);
    const services = {
      relayers: (base.relayers || []).map((u) => u.replace(/\/c\/[^/]+\/?$/, '')),
      identity: (base.identityService || '').replace(/\/c\/[^/]+\/?$/, ''),
      watchdogBase: (base.watchdogAlertsUrl || '').replace(/\/alerts\.json$/, ''),
      appUrl: process.env.APP_URL || 'https://ehammer1.github.io/Mandate/',
    };
    const depDir = path.join(ROOT, 'deployments', 'communities');
    fs.mkdirSync(depDir, { recursive: true });
    const partial = path.join(depDir, `${network}-${spec.slug}.partial.json`);
    const log = (m) => console.log(`[community] ${m}`);
    let addresses, startBlock;
    if (process.argv.includes('--resume')) {
      // A setup that stopped partway (a dropped connection): finish the handover from where it was.
      if (!fs.existsSync(partial)) throw new Error(`nothing to resume for ${spec.slug} (no ${path.relative(ROOT, partial)})`);
      ({ addresses, startBlock } = JSON.parse(fs.readFileSync(partial, 'utf8')));
      if (!addresses.council) throw new Error('the council was never deployed: start over (REPLACE=1, without --resume)');
      const runner = new ethers.NonceManager(signer);
      await finishHandover(runner, attach(runner, addresses), spec, { log });
    } else {
      ({ addresses, startBlock } = await createCommunity(signer, spec, {
        signupIssuer: process.env.SIGNUP_ISSUER || spec.signupIssuer,
        log,
        onProgress: (x) => fs.writeFileSync(partial, JSON.stringify(x, null, 2) + '\n'),
      }));
    }
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(communityConfig(spec, addresses, startBlock, base, services), null, 2) + '\n');
    addToIndex(path.join(outDir, 'index.json'), spec);
    fs.writeFileSync(path.join(depDir, `${network}-${spec.slug}.json`), JSON.stringify({ network, slug: spec.slug, name: spec.name, startBlock, deployedAt: new Date().toISOString(), deployer: signer.address, addresses }, null, 2) + '\n');
    fs.rmSync(partial, { force: true });
    console.log(`[community] done. App: ${appUrlFor(spec, services.appUrl)}`);
    if (spec.domain) for (const l of domainSteps(spec.domain, process.env.PAGES_HOST || 'promissa.pages.dev')) console.log(`[community] ${l}`);
    if (services.identity) console.log(`[community] if this community uses Google or Microsoft sign-in, add this callback to those sign-in apps: ${services.identity}/c/${spec.slug}/callback`);
  })().catch((e) => {
    console.error(`[community] ${e.shortMessage || e.message}`);
    process.exit(1);
  });
}
