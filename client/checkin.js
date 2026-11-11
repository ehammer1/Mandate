/**
 * client/checkin.js - check in at a polling place to vote on paper for a Mandate poll. The
 * proof is the one an online ballot would use (same poll, same one-time code), bound to the
 * place instead of a choice, so the voter list and the paper register match anonymously.
 */
'use strict';

const { ethers } = require('ethers');
const { generateProof } = require('@semaphore-protocol/proof');
const { groupAtSnapshot, artifactsAt, envArtifacts, REGISTRY_ABI } = require('./ballot');

const IDENTITY_ABI = [...REGISTRY_ABI, 'function semaphore() view returns (address)', 'function leafCount(uint8) view returns (uint256)'];
const VOTE_ABI = [
  'function scopeOf(uint256) view returns (uint256)',
  'function getPoll(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 quorum, uint8 options, uint8 action, bool finalized, bool passed, address proposer, uint256 bond, string questionCID, bytes actionData))',
];

/** The proof, ready for Tallies.checkIn(pollId, place, proof). */
async function checkInProof({ provider, identityAddress, voteAddress, identity, pollId, place, artifactsBase }) {
  const reg = new ethers.Contract(identityAddress, IDENTITY_ABI, provider);
  const vote = new ethers.Contract(voteAddress, VOTE_ABI, provider);
  const [poll, scope] = await Promise.all([vote.getPoll(pollId), vote.scopeOf(pollId)]);
  let tier = -1;
  for (let t = 0; t <= 2; t++) if ((await reg.groupId(t)) === poll.groupId) tier = t;
  if (tier < 0) throw new Error('This poll uses a voter list this app does not know.');
  const sem = new ethers.Contract(await reg.semaphore(), ['function getMerkleTreeRoot(uint256) view returns (uint256)'], provider);
  const [root, size] = await Promise.all([sem.getMerkleTreeRoot(poll.groupId), reg.leafCount(tier)]);
  const group = await groupAtSnapshot({ registry: reg, groupId: poll.groupId, electorate: size, snapshotRoot: root });
  if (group.indexOf(identity.commitment) === -1) throw new Error('You are not on the voter list for this poll.');
  const depth = Math.max(group.depth, 1);
  const p = await generateProof(identity, group, BigInt(place), scope, depth, artifactsAt(artifactsBase || envArtifacts(), depth));
  return { merkleTreeDepth: String(p.merkleTreeDepth), merkleTreeRoot: String(p.merkleTreeRoot), nullifier: String(p.nullifier), message: String(p.message), scope: String(p.scope), points: p.points.map(String) };
}

module.exports = { checkInProof };
