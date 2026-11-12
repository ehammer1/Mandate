#!/usr/bin/env node
/**
 * scripts/deploy.js - deploy the whole Mandate stack and write the web app's config.
 *
 *   NETWORK=base-sepolia DEPLOYER_PRIVATE_KEY=... node scripts/deploy.js
 *   RPC_URL=... DEPLOYER_PRIVATE_KEY=... node scripts/deploy.js          (any EVM chain)
 *
 * Optional env:
 *   NETWORK            a preset from scripts/networks.js (sets RPC_URL)
 *   ADMIN_ADDRESS      also grant every admin role to this address (e.g. your own wallet),
 *                      so control survives the deployer key
 *   DEMO_ISSUER        1 = register the deployer as a "testnet demo clerk" issuer
 *   RELAYER_PRIVATE_KEY + RELAYER_FUND  send RELAYER_FUND ETH to the relayer's address
 *   SEASONING_DAYS     default 30
 *   MIN_BOND           proposal bond in play credits, default 100
 *   TREASURY           address receiving forfeited bonds and clawbacks (default: deployer)
 *   RELAYERS           comma-separated relayer URLs for the app config
 *   IPFS_GATEWAY       default https://gateway.pinata.cloud
 *   ARTIFACTS_BASE     URL of Semaphore proving files for the app (default: download on demand)
 *   WALLETCONNECT_PROJECT_ID  free project id from cloud.reown.com; enables any mobile wallet
 *   IDENTITY_SERVICE   URL of the sign-in identity service (services/identity)
 *   WATCHDOG_ALERTS_URL  the watchdog's published alerts.json, shown on the public dashboard
 *   RULES              starting voting rules as JSON, e.g. {"MIN_POLL_MINUTES":10} (see Charter.sol)
 *   COUNCIL_MEMBERS    comma-separated addresses: deploy a Council (multi-signature admin
 *                      with a waiting period) and hand it every admin power; no single key
 *                      stays admin. COUNCIL_THRESHOLD (default: majority), COUNCIL_DELAY_HOURS
 *                      (default 48)
 *
 * Writes deployments/<chainId>.json and app/config.json. Without COUNCIL_MEMBERS the
 * deployer (and ADMIN_ADDRESS) stay admins: fine for a demo, not for real use.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { handOver } = require('./council-lib');

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
  // Sequential nonces from the start: public RPCs can lag behind on pending counts.
  if (opts.nonceManager) signer = new ethers.NonceManager(signer);
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
  // The community's voting rules; starting values that differ from the defaults go in opts.rules.
  const rules = Object.entries(opts.rules || {});
  const charter = await deploy(signer, 'Charter', {}, me, rules.map(([k]) => ethers.id(k)), rules.map(([, v]) => v));
  const vote = await deploy(signer, 'MandateVote', {}, me, await identity.getAddress(), await verifier.getAddress(), await credits.getAddress(), treasury, minBond, await charter.getAddress());
  const budget = await deploy(signer, 'CivicBudget', {}, me, await identity.getAddress(), await verifier.getAddress(), await charter.getAddress());
  const market = await deploy(signer, 'DecisionMarket', {}, me, await credits.getAddress(), await registry.getAddress());
  log('mandate contracts deployed');

  // Wiring: the public vote can create/repeal mandates and veto markets; markets can create mandates.
  await send(registry.grantRole(await registry.GOVERNOR_ROLE(), await vote.getAddress()));
  await send(registry.grantRole(await registry.GOVERNOR_ROLE(), await market.getAddress()));
  await send(market.grantRole(await market.VETO_ROLE(), await vote.getAddress()));
  await send(vote.grantRole(await vote.PROPOSER_ROLE(), me));
  await send(budget.grantRole(await budget.PROPOSER_ROLE(), me)); // can open budget rounds
  await send(charter.grantRole(await charter.GOVERNOR_ROLE(), await vote.getAddress())); // only a passed vote changes a rule
  log('roles granted');

  if (opts.admin) {
    for (const c of [identity, registry, vote, market, charter, budget]) await send(c.grantRole(ethers.ZeroHash, opts.admin)); // DEFAULT_ADMIN_ROLE
    await send(budget.grantRole(await budget.PROPOSER_ROLE(), opts.admin));
    await send(vote.grantRole(await vote.PROPOSER_ROLE(), opts.admin));
    if (!opts.council) await send(credits.transferOwnership(opts.admin)); // with a council, the council gets it
    log(`admin roles also granted to ${opts.admin}`);
  }
  if (opts.demoIssuer) {
    await send(identity.setIssuer(me, 1, true, 'Testnet demo clerk'));
    log('deployer registered as the testnet demo clerk');
  }

  const contracts = { semaphore, verifier, identity, credits, registry, vote, market, charter, budget };
  // Officials and public delegates: positions, anonymous delegation, emergency measures.
  contracts.officials = await deploy(signer, 'Officials', {}, me, await vote.getAddress(), await identity.getAddress());
  await send(vote.setDelegates(await contracts.officials.getAddress()));
  // Smaller voter lists (districts, wards, union locals) for advisory polls: subsets of the main list.
  contracts.voterGroups = await deploy(signer, 'VoterGroups', {}, me, await identity.getAddress());
  await send(contracts.voterGroups.grantRole(await contracts.voterGroups.GROUP_CREATOR_ROLE(), me));
  await send(vote.setVoterGroups(await contracts.voterGroups.getAddress()));
  await send(vote.grantRole(await vote.PROPOSER_ROLE(), await contracts.officials.getAddress())); // ratification polls for emergencies
  await send(contracts.officials.grantRole(await contracts.officials.REGISTRAR_ROLE(), opts.registrar || me));
  // Government bodies and organizations: their own rules, public agendas and roll-call votes.
  contracts.bodies = await deploy(signer, 'Bodies', {}, me, await vote.getAddress(), await identity.getAddress());
  await send(vote.grantRole(await vote.PROPOSER_ROLE(), await contracts.bodies.getAddress())); // residents' polls on agenda items
  if (opts.registrar) await send(contracts.bodies.grantRole(await contracts.bodies.REGISTRAR_ROLE(), opts.registrar));
  // Residents' comments, ratings and petitions; a successful petition opens its poll itself.
  contracts.feedback = await deploy(signer, 'Feedback', {}, await identity.getAddress(), await vote.getAddress(), await charter.getAddress());
  await send(vote.grantRole(await vote.PROPOSER_ROLE(), await contracts.feedback.getAddress()));
  if (opts.council) {
    const { members, threshold = Math.floor(opts.council.members.length / 2) + 1, delaySeconds = 48 * 3600, termDays = 0 } = opts.council;
    const termEnd = termDays ? (await signer.provider.getBlock('latest')).timestamp + Math.round(termDays * 86_400) : 0;
    // The public vote elects and recalls members and can take power away, without the council.
    contracts.council = await deploy(signer, 'Council', {}, members, threshold, delaySeconds, termEnd, await vote.getAddress(), await identity.groupId(2), Math.round((opts.council.ratifyDays ?? 7) * 86_400));
    await send(vote.grantRole(await vote.PROPOSER_ROLE(), await contracts.council.getAddress())); // emergency ratification polls
    await handOver(signer, contracts, await contracts.council.getAddress(), { revoke: [opts.admin].filter(Boolean), log });
    log(`council of ${members.length} (${threshold} to approve, ${delaySeconds / 3600} h wait) now holds every admin power`);
  }
  // Public text (questions, goals, evidence) and per-mandate budget escrows. Neither has an
  // admin. Overdue budgets drain to the council when there is one, else the treasury.
  contracts.notices = await deploy(signer, 'NoticeBoard', {});
  // Paper ballots, in-person votes and official election results (two-clerk confirmation).
  contracts.tallies = await deploy(signer, 'Tallies', {}, me, await vote.getAddress(), await identity.getAddress());
  // Progress on mandates: milestones and dated updates from the responsible party.
  contracts.progress = await deploy(signer, 'Progress', {}, await registry.getAddress());
  if (opts.registrar) await send(contracts.tallies.grantRole(await contracts.tallies.CLERK_ROLE(), opts.registrar));
  // Drafts and closed-session records for government bodies.
  contracts.bodyRecords = await deploy(signer, 'BodyRecords', {}, await contracts.bodies.getAddress(), await contracts.notices.getAddress());
  const escrowTreasury = contracts.council ? await contracts.council.getAddress() : treasury;
  contracts.escrows = await deploy(signer, 'EscrowFactory', {}, await registry.getAddress(), escrowTreasury, opts.escrowDecayBps ?? 1000, Math.round((opts.escrowDecayDays ?? 7) * 86_400));
  log('notice board and escrow factory deployed');
  const addresses = {};
  for (const [k, c] of Object.entries(contracts)) addresses[k] = await c.getAddress();
  return { contracts, addresses };
}

module.exports = { deployAll, deploy, link };

if (require.main === module) {
  require('dotenv').config();
  (async () => {
    const networks = require('./networks');
    const preset = process.env.NETWORK ? networks[process.env.NETWORK] : null;
    if (process.env.NETWORK && !preset) throw new Error(`unknown NETWORK ${process.env.NETWORK}; see scripts/networks.js`);
    const rpcUrl = preset ? preset.rpcUrl : process.env.RPC_URL;
    if (!rpcUrl || !process.env.DEPLOYER_PRIVATE_KEY) throw new Error('set NETWORK (or RPC_URL) and DEPLOYER_PRIVATE_KEY');
    const provider = new ethers.JsonRpcProvider(rpcUrl, preset?.chainId, preset ? { staticNetwork: true } : undefined);
    const signer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
    const { chainId } = await provider.getNetwork();
    const startBlock = await provider.getBlockNumber(); // where this deployment's history begins
    if (preset && !preset.testnet && process.env.CONFIRM_MAINNET !== 'yes') throw new Error('refusing a mainnet deploy without CONFIRM_MAINNET=yes');
    console.log(`[deploy] chain ${chainId} from ${signer.address}, balance ${ethers.formatEther(await provider.getBalance(signer.address))} ETH`);

    const { addresses } = await deployAll(signer, {
      seasoningDays: Number(process.env.SEASONING_DAYS || 30),
      minBond: ethers.parseEther(process.env.MIN_BOND || '100'),
      treasury: process.env.TREASURY,
      admin: process.env.ADMIN_ADDRESS ? ethers.getAddress(process.env.ADMIN_ADDRESS) : undefined,
      demoIssuer: process.env.DEMO_ISSUER === '1',
      rules: process.env.RULES ? JSON.parse(process.env.RULES) : undefined,
      council: process.env.COUNCIL_MEMBERS
        ? {
            members: process.env.COUNCIL_MEMBERS.split(',').map((a) => ethers.getAddress(a.trim())),
            threshold: process.env.COUNCIL_THRESHOLD ? Number(process.env.COUNCIL_THRESHOLD) : undefined,
            delaySeconds: Math.round(Number(process.env.COUNCIL_DELAY_HOURS || 48) * 3600),
          }
        : undefined,
      nonceManager: true,
      log: (m) => console.log(`[deploy] ${m}`),
    });

    if (process.env.RELAYER_PRIVATE_KEY && process.env.RELAYER_FUND) {
      const relayer = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY).address;
      await (await signer.sendTransaction({ to: relayer, value: ethers.parseEther(process.env.RELAYER_FUND) })).wait();
      console.log(`[deploy] sent ${process.env.RELAYER_FUND} ETH to relayer ${relayer}`);
    }

    const name = process.env.NETWORK || String(chainId);
    fs.mkdirSync(path.join(ROOT, 'deployments'), { recursive: true });
    const record = { network: name, chainId: Number(chainId), startBlock, deployedAt: new Date().toISOString(), deployer: signer.address, admin: process.env.ADMIN_ADDRESS || null, addresses };
    fs.writeFileSync(path.join(ROOT, 'deployments', `${name}.json`), JSON.stringify(record, null, 2) + '\n');
    const appConfig = {
      chainId: Number(chainId),
      startBlock,
      rpcUrl,
      voteAddress: addresses.vote,
      identityAddress: addresses.identity,
      creditsAddress: addresses.credits,
      registryAddress: addresses.registry,
      marketAddress: addresses.market,
      ...(addresses.council ? { councilAddress: addresses.council } : {}),
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
      relayers: (process.env.RELAYERS || '').split(',').map((s) => s.trim()).filter(Boolean),
      ipfsGateway: process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud',
      artifactsBase: process.env.ARTIFACTS_BASE || '',
      explorer: preset?.explorer || '',
      chainName: process.env.NETWORK || `Chain ${chainId}`,
      walletConnectProjectId: process.env.WALLETCONNECT_PROJECT_ID || '',
      identityService: process.env.IDENTITY_SERVICE || '',
      watchdogAlertsUrl: process.env.WATCHDOG_ALERTS_URL || '',
    };
    fs.writeFileSync(path.join(ROOT, 'app', `config.${name}.json`), JSON.stringify(appConfig, null, 2) + '\n');
    console.log(JSON.stringify(record, null, 2));
  })().catch((e) => {
    console.error(e.shortMessage || e.message);
    process.exit(1);
  });
}
