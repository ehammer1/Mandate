#!/usr/bin/env node
/**
 * scripts/admin.js - testnet operations for a deployed Mandate stack.
 *
 *   NETWORK=base-sepolia node scripts/admin.js status
 *   NETWORK=base-sepolia node scripts/admin.js enroll <voterCode> [--new-resident]
 *   NETWORK=base-sepolia node scripts/admin.js poll <questionId> [--days 7] [--group seasoned|verified|basic] [--quorum 1]
 *   NETWORK=base-sepolia node scripts/admin.js finalize <pollId>
 *
 * Uses DEPLOYER_PRIVATE_KEY (the demo clerk and poll proposer on testnet) and
 * deployments/<NETWORK>.json. `enroll` stands in for a clerk-desk check: by
 * default it records the voter as a long-standing resident (full voting rights
 * at once); --new-resident applies the 30-day waiting period instead.
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const networks = require('./networks');

const ROOT = path.join(__dirname, '..');
const abi = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'build', `${n}.json`), 'utf8')).abi;
const GROUPS = { basic: 0, verified: 1, seasoned: 2 };

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

async function main() {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  const name = process.env.NETWORK || 'base-sepolia';
  const preset = networks[name];
  const dep = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', `${name}.json`), 'utf8'));
  const provider = new ethers.JsonRpcProvider(preset?.rpcUrl || process.env.RPC_URL, dep.chainId, { staticNetwork: true });
  const signer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const identity = new ethers.Contract(dep.addresses.identity, abi('IdentityRegistry'), signer);
  const vote = new ethers.Contract(dep.addresses.vote, abi('MandateVote'), signer);
  const link = (h) => (preset?.explorer ? `${preset.explorer}/tx/${h}` : h);

  if (cmd === 'status') {
    const sizes = [];
    const sem = new ethers.Contract(dep.addresses.semaphore, ['function getMerkleTreeSize(uint256) view returns (uint256)'], provider);
    for (const g of ['basic', 'verified', 'seasoned']) sizes.push(`${g}=${await sem.getMerkleTreeSize(await identity.groupId(GROUPS[g]))}`);
    console.log(`network ${name} (chain ${dep.chainId})`);
    console.log(`groups: ${sizes.join(', ')}`);
    console.log(`polls: ${await vote.pollCount()}`);
    console.log(`signer ${signer.address} balance ${ethers.formatEther(await provider.getBalance(signer.address))} ETH`);
    return;
  }

  if (cmd === 'enroll') {
    if (!arg) throw new Error('usage: enroll <voterCode> [--new-resident]');
    const commitment = BigInt(arg);
    const newResident = flag(rest, 'new-resident', false) === true;
    const now = (await provider.getBlock('latest')).timestamp;
    const residentSince = newResident ? 0 : now - 5 * 365 * 86_400;
    // Testnet stand-in for HMAC(document number, pepper): unique per voter code.
    const docHash = ethers.keccak256(ethers.toUtf8Bytes(`testnet-demo:${commitment}`));
    const tx = await identity.enroll(commitment, 1, docHash, residentSince);
    await tx.wait();
    console.log(`enrolled ${String(commitment).slice(0, 12)}… as ${newResident ? 'a new resident (30-day wait)' : 'a long-standing resident (full voting rights)'}: ${link(tx.hash)}`);
    return;
  }

  if (cmd === 'poll') {
    if (!arg) throw new Error('usage: poll <questionId> [--days 7] [--group seasoned] [--quorum 1]');
    const days = Number(flag(rest, 'days', 7));
    const group = String(flag(rest, 'group', 'seasoned'));
    const quorum = Number(flag(rest, 'quorum', 1));
    if (!(group in GROUPS)) throw new Error(`--group must be one of ${Object.keys(GROUPS).join(', ')}`);
    const tx = await vote.createPoll(await identity.groupId(GROUPS[group]), Math.round(days * 86_400), quorum, 2, 0, '0x', arg, 0);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return vote.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'PollCreated');
    console.log(`opened poll ${ev.args.id} on ${group} voters for ${days} days: ${link(tx.hash)}`);
    return;
  }

  if (cmd === 'finalize') {
    const tx = await vote.finalize(BigInt(arg));
    await tx.wait();
    const p = await vote.getPoll(BigInt(arg));
    console.log(`poll ${arg} finalized: ${p.passed ? 'passed' : 'did not pass'} (${(await vote.tally(BigInt(arg))).join(' / ')}): ${link(tx.hash)}`);
    return;
  }

  console.error('commands: status | enroll <voterCode> [--new-resident] | poll <questionId> [--days N] [--group G] [--quorum N] | finalize <pollId>');
  process.exit(2);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
