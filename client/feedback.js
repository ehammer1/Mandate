/**
 * client/feedback.js - anonymous but verified comments, ratings and petition signatures
 * (Feedback contract). Proofs are made against the voter list as it is now.
 */
'use strict';

const { ethers } = require('ethers');
const { generateProof } = require('@semaphore-protocol/proof');
const { groupAtSnapshot, artifactsAt, envArtifacts, REGISTRY_ABI } = require('./ballot');

const SEMAPHORE_ABI = ['function getMerkleTreeRoot(uint256) view returns (uint256)'];
const IDENTITY_ABI = [...REGISTRY_ABI, 'function semaphore() view returns (address)', 'function leafCount(uint8) view returns (uint256)'];

/** Highest voter list this person is on (0 basic, 1 ID-checked, 2 full rights), or -1. */
async function myTier(registry, commitment) {
  const m = await new ethers.Contract(await registry.getAddress(), ['function members(uint256) view returns (address issuer, uint8 tier, bool active)'], registry.runner).members(commitment);
  return m.active ? Number(m.tier) : -1;
}

async function prove({ provider, feedback, identity, tier, scope, message, artifactsBase }) {
  const reg = new ethers.Contract(await feedback.identity(), IDENTITY_ABI, provider);
  const groupId = await reg.groupId(tier);
  const sem = new ethers.Contract(await reg.semaphore(), SEMAPHORE_ABI, provider);
  const [root, size] = await Promise.all([sem.getMerkleTreeRoot(groupId), reg.leafCount(tier)]);
  const group = await groupAtSnapshot({ registry: reg, groupId, electorate: size, snapshotRoot: root });
  if (group.indexOf(identity.commitment) === -1) throw new Error('you are not on this voter list');
  const depth = Math.max(group.depth, 1);
  const p = await generateProof(identity, group, message, scope, depth, artifactsAt(artifactsBase || envArtifacts(), depth));
  return { merkleTreeDepth: p.merkleTreeDepth, merkleTreeRoot: p.merkleTreeRoot, nullifier: p.nullifier, message: p.message, scope: p.scope, points: p.points };
}

const hashText = (text) => BigInt(ethers.keccak256(ethers.toUtf8Bytes(text))) >> 8n;

async function commentProof(o) {
  return prove({ ...o, scope: await o.feedback.commentScope(o.topic, o.ref), message: hashText(o.ref) });
}
async function ratingProof(o) {
  return prove({ ...o, scope: await o.feedback.rateScope(o.topic), message: BigInt(o.score) });
}
async function markProof(o) {
  return prove({ ...o, scope: await o.feedback.markScope(o.topic, o.index), message: BigInt(o.lean * 2 + (o.helpful ? 1 : 0)) });
}
async function signatureProof(o) {
  return prove({ ...o, scope: await o.feedback.petitionScope(o.petitionId), message: BigInt(o.petitionId) });
}

/** Topic ids: what a comment, rating or petition is about. */
const topicOf = (kind, id) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['string', 'uint256'], [kind, id]));

/**
 * Bridging rank for a comment from its marks ([lean*2 + helpful] counts: undecided, for,
 * against): the lower of how helpful people leaning for and people leaning against found it
 * (a cautious estimate, so a few marks count less than many). An argument only one side
 * likes ranks low; one both sides find helpful ranks high.
 */
function bridgeScore(m) {
  const c = Array.from(m || [], Number);
  const lb = (yes, n) => {
    if (!n) return 0;
    const z = 1.28;
    const p = yes / n;
    return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  };
  const side = (l) => ({ yes: c[l * 2 + 1] || 0, n: (c[l * 2] || 0) + (c[l * 2 + 1] || 0) });
  const f = side(1);
  const a = side(2);
  const all = { yes: (c[1] || 0) + f.yes + a.yes, n: (c[0] || 0) + (c[1] || 0) + f.n + a.n };
  const rate = (s) => (s.n ? s.yes / s.n : 0);
  return {
    score: Math.min(lb(f.yes, f.n), lb(a.yes, a.n)),
    overall: lb(all.yes, all.n),
    bothSides: f.n >= 2 && a.n >= 2 && rate(f) >= 0.6 && rate(a) >= 0.6,
    marks: all.n,
    helpful: all.yes,
  };
}

module.exports = { commentProof, ratingProof, markProof, signatureProof, topicOf, myTier, hashText, bridgeScore };
