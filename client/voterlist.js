/**
 * client/voterlist.js - the proof the voter list (IdentityRegistry) needs to remove a voter code.
 *
 * revoke(commitment, siblings) takes, for each group the member is in, the Merkle siblings of
 * their place in today's list. They are rebuilt from the registry's own view calls (no log
 * scanning), the same way ballots rebuild a poll's frozen list.
 */
'use strict';

const { Group } = require('@semaphore-protocol/group');

const VOTERLIST_ABI = [
  'function leafCount(uint8 tier) view returns (uint256)',
  'function leaves(uint8 tier, uint256 start, uint256 count) view returns (uint256[] commitments, uint64[] removedAt)',
  'function revoke(uint256 commitment, uint256[][] siblings)',
  'function commitmentOfDoc(bytes32) view returns (uint256)',
];

/** @param registry an ethers Contract with VOTERLIST_ABI; @param tier the member's tier (0..2) */
async function siblingsFor(registry, commitment, tier) {
  const out = [];
  for (let t = 0; t < 3; t++) {
    if (t > Number(tier)) {
      out.push([]);
      continue;
    }
    const n = Number(await registry.leafCount(t));
    const leaves = [];
    const removed = [];
    for (let start = 0; start < n; start += 500) {
      const [c, r] = await registry.leaves(t, start, Math.min(500, n - start));
      leaves.push(...c);
      removed.push(...r.map(Number));
    }
    const group = new Group(leaves);
    removed.forEach((r, i) => r > 0 && group.removeMember(i));
    const i = leaves.findIndex((x) => x === BigInt(commitment));
    if (i < 0) throw new Error('That voter code is not on the voter list.');
    out.push(group.generateMerkleProof(i).siblings);
  }
  return out;
}

module.exports = { siblingsFor, VOTERLIST_ABI };
