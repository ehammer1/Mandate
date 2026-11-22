/**
 * client/agenda.js - the People's Agenda (Agenda contract): anonymous proofs to add an issue
 * and to rank issues with priority credits (quadratic: n credits on one issue cost n*n).
 */
'use strict';

const { ethers } = require('ethers');
const { generateProof } = require('@semaphore-protocol/proof');
const { groupAtSnapshot, artifactsAt, envArtifacts, REGISTRY_ABI } = require('./ballot');

const AGENDA_ABI = [
  'function seasonCount() view returns (uint256)',
  'function getSeason(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 proposeEnd, uint64 end, uint32 credits, uint32 participants, string ref))',
  'function issues(uint256) view returns (string[] refs, uint256[] credits)',
  'function identity() view returns (address)',
  'function issueScope(uint256) view returns (uint256)',
  'function rankScope(uint256) view returns (uint256)',
  'function proposed(uint256, uint256) view returns (bool)',
  'function hasRole(bytes32, address) view returns (bool)',
  'function openSeason(uint8 tier, uint64 proposeSeconds, uint64 rankSeconds, uint32 credits, string ref) returns (uint256)',
  'function addIssue(uint256 id, string ref)',
  'event SeasonOpened(uint256 indexed id, uint8 tier, uint64 proposeEnd, uint64 end, uint32 credits, string ref)',
];

const cost = (credits) => credits.reduce((a, v) => a + Number(v) * Number(v), 0);

/** Same as Agenda.rankMessage. */
const rankMessage = (seasonId, picks, credits) =>
  BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint16[]', 'uint32[]'], [seasonId, picks, credits]))) >> 8n;
const issueMessage = (ref) => BigInt(ethers.keccak256(ethers.toUtf8Bytes(ref))) >> 8n;

async function prove({ provider, agenda, seasonId, identity, scope, message, artifactsBase }) {
  const s = await agenda.getSeason(seasonId);
  const registry = new ethers.Contract(await agenda.identity(), REGISTRY_ABI, provider);
  const group = await groupAtSnapshot({ registry, groupId: s.groupId, electorate: s.electorate, snapshotRoot: s.snapshotRoot });
  if (group.indexOf(identity.commitment) === -1) throw new Error('you were not on the voter list when this season opened');
  const depth = Math.max(group.depth, 1);
  const p = await generateProof(identity, group, message, scope, depth, artifactsAt(artifactsBase || envArtifacts(), depth));
  return { merkleTreeDepth: p.merkleTreeDepth, merkleTreeRoot: p.merkleTreeRoot, nullifier: p.nullifier, message: p.message, scope: p.scope, points: p.points };
}

/** Proof to add issue `ref` (one per person per season). */
async function issueProof(o) {
  return prove({ ...o, scope: await o.agenda.issueScope(o.seasonId), message: issueMessage(o.ref) });
}

/**
 * Proof for a ranking: `credits[i]` on issue `picks[i]`. A later ranking by the same person
 * replaces the earlier one.
 */
async function rankProof(o) {
  const { picks, credits } = o;
  if (!picks.length || picks.length !== credits.length || new Set(picks).size !== picks.length) throw new Error('choose each issue at most once');
  if (credits.some((v) => !Number.isInteger(v) || v <= 0)) throw new Error('credits must be whole numbers above zero');
  const s = await o.agenda.getSeason(o.seasonId);
  if (cost(credits) > Number(s.credits)) throw new Error(`this ranking costs ${cost(credits)} credits; the allowance is ${s.credits}`);
  return prove({ ...o, scope: await o.agenda.rankScope(o.seasonId), message: rankMessage(o.seasonId, picks, credits) });
}

module.exports = { AGENDA_ABI, issueProof, rankProof, rankMessage, issueMessage, cost };
