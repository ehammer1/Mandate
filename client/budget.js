/**
 * client/budget.js - anonymous civic-credit allocations for CivicBudget rounds.
 *
 *   const a = await buildAllocation({ provider, budget, roundId, identity, votes: [3, 0, 1] });
 *   await fetch(relayerUrl + '/allocation', { method: 'POST', body: JSON.stringify({ roundId, allocation: a }) });
 *
 * Quadratic cost: n votes on one proposal cost n*n credits; the total must fit the round's
 * allowance. The proof's message is a hash of the votes, so nobody can change them in transit.
 */

'use strict';

const { ethers } = require('ethers');
const { generateProof } = require('@semaphore-protocol/proof');
const { groupAtSnapshot, artifactsAt, envArtifacts, REGISTRY_ABI } = require('./ballot');

const cost = (votes) => votes.reduce((a, v) => a + Number(v) * Number(v), 0);

/** Same as CivicBudget.allocationMessage. */
function allocationMessage(roundId, votes) {
  return BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint32[]'], [roundId, votes]))) >> 8n;
}

async function buildAllocation({ provider, budget, roundId, identity, votes, artifactsBase }) {
  const r = await budget.getRound(roundId);
  if (votes.some((v) => !Number.isInteger(v) || v < 0)) throw new Error('votes must be whole numbers, zero or more');
  if (cost(votes) > Number(r.credits)) throw new Error(`these votes cost ${cost(votes)} credits; the allowance is ${r.credits}`);
  const [identityAddr, scope] = await Promise.all([budget.identity(), budget.scopeOf(roundId)]);
  const registry = new ethers.Contract(identityAddr, REGISTRY_ABI, provider);
  const group = await groupAtSnapshot({ registry, groupId: r.groupId, electorate: r.electorate, snapshotRoot: r.snapshotRoot });
  if (group.indexOf(identity.commitment) === -1) throw new Error('this identity was not eligible when the round opened');
  const depth = Math.max(group.depth, 1);
  const proof = await generateProof(identity, group, allocationMessage(roundId, votes), scope, depth, artifactsAt(artifactsBase || envArtifacts(), depth));
  return {
    merkleTreeDepth: proof.merkleTreeDepth,
    merkleTreeRoot: proof.merkleTreeRoot,
    nullifier: proof.nullifier,
    scope: proof.scope,
    points: proof.points,
    votes,
  };
}

module.exports = { buildAllocation, allocationMessage, cost };
