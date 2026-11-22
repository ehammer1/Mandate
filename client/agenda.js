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
  'function candidatesOf(uint256) view returns (uint256[])',
  'function getCandidate(uint256) view returns (tuple(uint256 season, address account, string name, string race, string party, uint32 version, uint64 statedAt, string ref))',
  'function positionsOf(uint256) view returns (bool[] answered, int8[] stances, uint8[] importance)',
  'function addCandidate(uint256 season, address account, string name, string race, string party) returns (uint256)',
  'function statePositions(uint256 id, uint16[] issueIdx, int8[] stances, uint8[] importance, string ref)',
  'error NotCandidate()', 'error BadPositions()', 'error InvalidParams()',
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

/**
 * How well a candidate matches a resident, from the resident's own answers (never sent
 * anywhere): for each issue the resident cares about (importance 1-3), agreement is 1 when
 * their stances (-2..+2) are the same and 0 when opposite, weighted by the resident's
 * importance. An issue the candidate didn't answer counts as half agreement and is reported.
 * @param mine   [{ stance, importance }] per issue (null or importance 0 = skip)
 * @param theirs { answered[], stances[] } from positionsOf
 * @returns { percent, compared, unanswered } or null when the resident answered nothing
 */
function matchScore(mine, theirs) {
  let sum = 0;
  let weight = 0;
  let compared = 0;
  let unanswered = 0;
  mine.forEach((m, i) => {
    if (!m || !m.importance) return;
    const w = Number(m.importance);
    weight += w;
    if (!theirs.answered[i]) {
      unanswered++;
      sum += w * 0.5;
      return;
    }
    compared++;
    sum += w * (1 - Math.abs(Number(m.stance) - Number(theirs.stances[i])) / 4);
  });
  return weight ? { percent: Math.round((100 * sum) / weight), compared, unanswered } : null;
}

module.exports = { AGENDA_ABI, issueProof, rankProof, rankMessage, issueMessage, cost, matchScore };
