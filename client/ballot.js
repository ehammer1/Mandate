/**
 * client/ballot.js - build anonymous ballots for MandateVote.
 *
 * Runs wherever the voter's secret lives: a phone app, a browser, or a kiosk
 * holding a voter's card. Nothing here needs a wallet: the output is a proof
 * that any relayer can submit.
 *
 *   const { Identity } = require('@semaphore-protocol/identity');
 *   const me = Identity.import(savedSecret);          // or new Identity() at enrollment
 *   const ballot = await buildBallot({ provider, vote, pollId, identity: me, option: 0 });
 *   await fetch(relayerUrl + '/ballot', { method: 'POST', body: JSON.stringify({ pollId, ballot }) });
 *
 * Proving files: by default the Semaphore library downloads them from the
 * Semaphore project's CDN. Set SEMAPHORE_ARTIFACTS_DIR to a local copy (e.g.
 * node_modules/@zk-kit/semaphore-artifacts) for offline kiosks and tests.
 */

'use strict';

const { ethers } = require('ethers');
const { Group } = require('@semaphore-protocol/group');
const { generateProof } = require('@semaphore-protocol/proof');

const REGISTRY_ABI = [
  'function groupId(uint8) view returns (uint256)',
  'function leaves(uint8 tier, uint256 start, uint256 count) view returns (uint256[] commitments, uint64[] removedAt)',
];
const PAGE = 500;

/**
 * Rebuild a poll's frozen voter list from the IdentityRegistry's mirror of its
 * groups (view calls only; no log scanning, which public RPCs limit heavily).
 *
 * The poll recorded how many leaves its group had (`electorate`) and the root.
 * Members added later are beyond `electorate`; members removed later must be put
 * back. Removals record the change counter at which they happened, so we try
 * "removals up to counter s" for each candidate s until the root matches.
 */
const CHECK_ABI = 'function getCheck(uint256) view returns (tuple(uint256 groupId, uint256 root, uint256 electorate, uint32 quorum, bool disputed) ck, uint256[2] counts)';

async function groupAtSnapshot({ registry, groupId, electorate, snapshotRoot }) {
  let tier = -1;
  for (const t of [0, 1, 2]) if ((await registry.groupId(t)) === BigInt(groupId)) tier = t;
  if (tier === -1) throw new Error('poll group is not an IdentityRegistry group');

  const leaves = [];
  const removedAt = [];
  for (let start = 0; start < Number(electorate); start += PAGE) {
    const [c, r] = await registry.leaves(tier, start, Math.min(PAGE, Number(electorate) - start));
    leaves.push(...c);
    removedAt.push(...r.map(Number));
  }
  const candidates = [0, ...[...new Set(removedAt.filter((x) => x > 0))].sort((x, y) => x - y)];
  for (const s of candidates) {
    const group = new Group(leaves);
    removedAt.forEach((r, i) => {
      if (r > 0 && r <= s) group.removeMember(i);
    });
    if (group.root === BigInt(snapshotRoot)) return group;
  }
  throw new Error('could not reconstruct the poll snapshot from the voter list');
}

/** Local proving files: a directory (Node) or a URL prefix (browser), else undefined = download on demand. */
function artifactsAt(base, depth) {
  if (!base) return undefined;
  const root = String(base).replace(/\/+$/, '');
  return { wasm: `${root}/semaphore-${depth}.wasm`, zkey: `${root}/semaphore-${depth}.zkey` };
}
const envArtifacts = () => (typeof process !== 'undefined' && process.env ? process.env.SEMAPHORE_ARTIFACTS_DIR : undefined);

/**
 * @param {object} p
 * @param {ethers.Provider} p.provider
 * @param {ethers.Contract} p.vote      MandateVote contract (read-only is fine)
 * @param {bigint|number} p.pollId
 * @param {import('@semaphore-protocol/identity').Identity} p.identity
 * @param {number} p.option            0 = YES, 1 = NO, or a choice index
 * @param {string} [p.artifactsBase]    directory or URL holding semaphore-<depth>.wasm/.zkey
 * @returns {Promise<object>} Ballot struct ready for castBallot / the relayer
 */
async function buildBallot({ provider, vote, pollId, identity, option, artifactsBase }) {
  const poll = await vote.getPoll(pollId);
  const [identityAddr, scope] = await Promise.all([vote.identity(), vote.scopeOf(pollId)]);
  const registry = new ethers.Contract(identityAddr, REGISTRY_ABI, provider);
  // Cross-checked poll: members of the stricter check group prove membership of it, so their
  // ballot also counts in the separate check tally (still one ballot per person).
  let group = null;
  try {
    const checker = new ethers.Contract(await vote.getAddress(), [CHECK_ABI], provider);
    const [ck] = await checker.getCheck(pollId);
    if (ck.root !== 0n) {
      const g = await groupAtSnapshot({ registry, groupId: ck.groupId, electorate: ck.electorate, snapshotRoot: ck.root });
      if (g.indexOf(identity.commitment) !== -1) group = g;
    }
  } catch {
    /* a deployment without cross-checks */
  }
  group ||= await groupAtSnapshot({
    registry,
    groupId: poll.groupId,
    electorate: poll.electorate,
    snapshotRoot: poll.snapshotRoot,
  });
  if (group.indexOf(identity.commitment) === -1) throw new Error('this identity was not eligible when the poll opened');

  const depth = Math.max(group.depth, 1);
  const proof = await generateProof(identity, group, option, scope, depth, artifactsAt(artifactsBase || envArtifacts(), depth));
  return {
    merkleTreeDepth: proof.merkleTreeDepth,
    merkleTreeRoot: proof.merkleTreeRoot,
    nullifier: proof.nullifier,
    message: proof.message,
    scope: proof.scope,
    points: proof.points,
  };
}

module.exports = { buildBallot, groupAtSnapshot, artifactsAt, envArtifacts, REGISTRY_ABI };
