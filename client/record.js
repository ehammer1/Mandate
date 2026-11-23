/**
 * client/record.js - public track records: what someone has done in public roles, never how
 * anyone voted (ballots are secret, and whether someone voted is never counted).
 *   - promises (mandates) they were responsible for: delivered and confirmed by independent
 *     checkers, on time or late, overdue, repealed
 *   - petitions they started from their own account, and how many reached a vote
 *   - public roles: official or public delegate
 * Facts, not a single score: a score gets gamed and turns into a popularity contest.
 */
'use strict';

const { ethers } = require('ethers');

const REGISTRY_ABI = [
  'function mandateCount() view returns (uint256)',
  'function getMandate(uint256) view returns (tuple(address responsible, uint64 createdAt, uint64 deadline, uint64 settledAt, uint16 threshold, uint8 status, uint32 round, uint32 approvals, uint32 rejections, bytes32 category, string specCID, string evidenceCID, uint64 pausedAt))',
];
const FEEDBACK_ABI = [
  'function petitionCount() view returns (uint256)',
  'function getPetition(uint256) view returns (tuple(uint8 tier, uint8 action, uint32 needed, uint32 signatures, uint256 pollId, bytes actionData, string ref, address creator, uint64 createdAt))',
];
const OFFICIALS_ABI = [
  'function count() view returns (uint256)',
  'function getOfficial(uint256) view returns (tuple(address account, string name, string office, string jurisdiction, uint64 termEnd, bool official, bool delegate, bool active, string statementRef))',
];
const FULFILLED = 3;
const REPEALED = 4;
const LIMIT = 300; // the most recent items scanned

const blank = () => ({ promises: 0, delivered: 0, onTime: 0, overdue: 0, repealed: 0, open: 0, petitions: 0, reachedVote: 0, role: null, name: null });

/**
 * Scan the community's public records once; returns { of(account), people() }.
 * @param {{ provider, cfg, now?: number }} o  cfg: registryAddress, feedbackAddress, officialsAddress
 */
async function recordIndex({ provider, cfg, now }) {
  const by = new Map();
  const get = (a) => {
    const k = String(a).toLowerCase();
    if (!by.has(k)) by.set(k, { account: ethers.getAddress(a), ...blank() });
    return by.get(k);
  };
  const t = now ?? (await provider.getBlock('latest')).timestamp;
  if (cfg.registryAddress) {
    const r = new ethers.Contract(cfg.registryAddress, REGISTRY_ABI, provider);
    const n = Number(await r.mandateCount().catch(() => 0n));
    const ms = await Promise.all([...Array(Math.min(n, LIMIT)).keys()].map((i) => r.getMandate(n - i).catch(() => null)));
    for (const m of ms.filter(Boolean)) {
      const p = get(m.responsible);
      p.promises++;
      const st = Number(m.status);
      if (st === FULFILLED) {
        p.delivered++;
        if (Number(m.settledAt) <= Number(m.deadline)) p.onTime++;
      } else if (st === REPEALED) p.repealed++;
      else if (Number(m.deadline) < t) p.overdue++;
      else p.open++;
    }
  }
  if (cfg.feedbackAddress) {
    const f = new ethers.Contract(cfg.feedbackAddress, FEEDBACK_ABI, provider);
    const n = Number(await f.petitionCount().catch(() => 0n));
    const ps = await Promise.all([...Array(Math.min(n, LIMIT)).keys()].map((i) => f.getPetition(n - i).catch(() => null)));
    const relays = new Set((cfg.relayerAddresses || []).map((a) => a.toLowerCase()));
    for (const p of ps.filter(Boolean)) {
      if (p.creator === ethers.ZeroAddress || relays.has(p.creator.toLowerCase())) continue; // started anonymously
      const x = get(p.creator);
      x.petitions++;
      if (p.pollId !== 0n) x.reachedVote++;
    }
  }
  if (cfg.officialsAddress) {
    const o = new ethers.Contract(cfg.officialsAddress, OFFICIALS_ABI, provider);
    const n = Number(await o.count().catch(() => 0n));
    const os = await Promise.all([...Array(Math.min(n, LIMIT)).keys()].map((i) => o.getOfficial(i + 1).catch(() => null)));
    for (const x of os.filter((v) => v && v.active)) {
      const p = get(x.account);
      p.name = x.name;
      p.role = x.official ? x.office : x.delegate ? 'Public delegate' : null;
    }
  }
  return {
    of: (account) => by.get(String(account).toLowerCase()) || { account, ...blank() },
    /** People who chose a public role (officials, public delegates) or held a public promise, best record first. */
    people: () =>
      [...by.values()]
        .filter((p) => p.role || p.promises)
        .sort((a, b) => b.delivered - a.delivered || b.onTime - a.onTime || a.overdue - b.overdue || b.reachedVote - a.reachedVote),
  };
}

/** One plain line: "3 of 4 promises delivered (2 on time) · 1 overdue · started 2 petitions, 1 reached a vote". */
function recordLine(p) {
  const bits = [];
  if (p.promises) {
    bits.push(`${p.delivered} of ${p.promises} promise${p.promises === 1 ? '' : 's'} delivered${p.delivered ? ` (${p.onTime} on time)` : ''}`);
    if (p.overdue) bits.push(`${p.overdue} overdue`);
    if (p.repealed) bits.push(`${p.repealed} repealed by vote`);
    if (p.open) bits.push(`${p.open} in progress`);
  }
  if (p.petitions) bits.push(`started ${p.petitions} petition${p.petitions === 1 ? '' : 's'}, ${p.reachedVote} reached a vote`);
  return bits.length ? bits.join(' · ') : 'No public track record yet';
}

module.exports = { recordIndex, recordLine };
