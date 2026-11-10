#!/usr/bin/env node
/**
 * scripts/council.js - the council (multi-signature admin) of a deployed Mandate stack.
 *
 *   NETWORK=base-sepolia COUNCIL_MEMBERS=0xA,0xB,0xC COUNCIL_THRESHOLD=2 COUNCIL_DELAY_HOURS=1 \
 *     node scripts/council.js handover      deploy the council (once), give it every admin
 *                                           power, remove every individual admin
 *   NETWORK=base-sepolia node scripts/council.js status
 *   NETWORK=base-sepolia node scripts/council.js approve|execute|cancel <id>
 *   NETWORK=base-sepolia node scripts/council.js propose-role <identity|registry|vote|market> <ROLE_NAME> <address> "<reason>"
 *
 * Signs with DEPLOYER_PRIVATE_KEY. Hand-over must run while that key is still an admin.
 * Updates deployments/<NETWORK>.json and app/config.<NETWORK>.json with the council address.
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const networks = require('./networks');
const { deploy } = require('./deploy');
const { handOver, ADMIN } = require('./council-lib');

const ROOT = path.join(__dirname, '..');
const abi = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'build', `${n}.json`), 'utf8')).abi;
const STATES = ['none', 'collecting approvals', 'waiting period', 'ready to run', 'done', 'cancelled', 'expired'];

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const name = process.env.NETWORK || 'base-sepolia';
  const preset = networks[name];
  const depFile = path.join(ROOT, 'deployments', `${name}.json`);
  const cfgFile = path.join(ROOT, 'app', `config.${name}.json`);
  const dep = JSON.parse(fs.readFileSync(depFile, 'utf8'));
  const provider = new ethers.JsonRpcProvider(preset?.rpcUrl || process.env.RPC_URL, dep.chainId, { staticNetwork: true });
  const signer = new ethers.NonceManager(new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider));
  const me = await signer.getAddress();
  const link = (h) => (preset?.explorer ? `${preset.explorer}/tx/${h}` : h);
  const k = (n, key) => new ethers.Contract(dep.addresses[key], abi(n), signer);
  const c = { identity: k('IdentityRegistry', 'identity'), registry: k('MandateRegistry', 'registry'), vote: k('MandateVote', 'vote'), market: k('DecisionMarket', 'market'), credits: k('PlayCredits', 'credits') };
  let council = dep.addresses.council ? new ethers.Contract(dep.addresses.council, abi('Council'), signer) : null;

  if (cmd === 'handover') {
    if (!council) {
      const members = (process.env.COUNCIL_MEMBERS || '').split(',').filter(Boolean).map((a) => ethers.getAddress(a.trim()));
      if (members.length < 2) throw new Error('set COUNCIL_MEMBERS to at least two comma-separated addresses');
      const threshold = Number(process.env.COUNCIL_THRESHOLD || Math.floor(members.length / 2) + 1);
      const delay = Math.round(Number(process.env.COUNCIL_DELAY_HOURS || 48) * 3600);
      council = await deploy(signer, 'Council', {}, members, threshold, delay);
      dep.addresses.council = await council.getAddress();
      fs.writeFileSync(depFile, JSON.stringify(dep, null, 2) + '\n'); // saved at once, so a rerun reuses it
      console.log(`council deployed at ${dep.addresses.council}: ${members.length} members, ${threshold} to approve, ${delay / 3600} h wait`);
    }
    const ca = await council.getAddress();
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    cfg.councilAddress = ca;
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
    // Everyone who currently holds admin on the role-enumerable contracts, plus known extras.
    const holders = new Set((process.env.REVOKE_ADMINS || '').split(',').filter(Boolean).map((a) => ethers.getAddress(a.trim())));
    for (const x of [c.identity, c.registry]) {
      const n = Number(await x.getRoleMemberCount(ADMIN));
      for (let i = 0; i < n; i++) holders.add(await x.getRoleMember(ADMIN, i));
    }
    await handOver(signer, c, ca, { revoke: [...holders], log: (m) => console.log(m) });
    const owner = await c.credits.owner();
    if (owner !== ca) console.log(`note: play credits are owned by ${owner}; that account can hand them over in the app (Admin → Hand play credits to the council)`);
    console.log('done: the council is the only admin');
    return;
  }

  if (!council) throw new Error('no council in this deployment; run handover first');
  if (cmd === 'status') {
    const ca = await council.getAddress();
    console.log(`council ${ca}: ${(await council.members()).join(', ')}`);
    console.log(`${await council.threshold()} approvals, ${Number(await council.delay()) / 3600} h wait`);
    for (const [label, x] of Object.entries(c).filter(([key]) => key !== 'credits')) {
      console.log(`${label}: council admin=${await x.hasRole(ADMIN, ca)}, deployer admin=${await x.hasRole(ADMIN, me)}`);
    }
    console.log(`play credits owner: ${await c.credits.owner()}`);
    const n = Number(await council.proposalCount());
    for (let id = Math.max(1, n - 9); id <= n; id++) {
      const [p, s, approvals] = await council.proposal(id);
      console.log(`#${id} ${STATES[Number(s)]} (${approvals} approvals): ${p.description} -> ${p.target} ${p.data.slice(0, 10)}`);
    }
    return;
  }
  if (cmd === 'propose-role') {
    const [, key, role, who, ...why] = process.argv.slice(2);
    if (!c[key] || !role || !ethers.isAddress(who)) throw new Error('usage: propose-role <identity|registry|vote|market> <ROLE_NAME> <address> "<reason>"');
    const roleId = role === 'ADMIN' ? ADMIN : ethers.id(role);
    const data = c[key].interface.encodeFunctionData('grantRole', [roleId, ethers.getAddress(who)]);
    const tx = await council.propose(await c[key].getAddress(), 0, data, why.join(' ') || `Grant ${role} to ${who}`);
    const rc = await tx.wait();
    const id = rc.logs.map((l) => { try { return council.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'Proposed').args.id;
    console.log(`proposed council change #${id}: ${link(tx.hash)}`);
    return;
  }
  if (['approve', 'execute', 'cancel'].includes(cmd)) {
    const tx = await council[cmd](BigInt(arg));
    await tx.wait();
    console.log(`${cmd} #${arg}: ${link(tx.hash)}`);
    return;
  }
  console.error('commands: handover | status | approve <id> | execute <id> | cancel <id>');
  process.exit(2);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
