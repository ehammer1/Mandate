/**
 * client/ballot.js - build anonymous ballots for MandateVote.
 *
 * Runs wherever the voter's secret lives: a phone app, a browser, or a kiosk
 * holding a voter's card. Nothing here needs a wallet: the output is a proof
 * that any relayer can submit.
 *
 *   const { Identity } = require('@semaphore-protocol/identity');
 *   const me = Identity.import(savedSecret);          // or new Identity() at enrolment
 *   const ballot = await buildBallot({ provider, vote, pollId, identity: me, option: 0 });
 *   await fetch(relayerUrl + '/ballot', { method: 'POST', body: JSON.stringify({ pollId, ballot }) });
 *
 * Proving files: by default the Semaphore library downloads them from the
 * Semaphore project's CDN. Set SEMAPHORE_ARTIFACTS_DIR to a local copy (e.g.
 * node_modules/@zk-kit/semaphore-artifacts) for offline kiosks and tests.
 */

'use strict';

const path = require('path');
const { ethers } = require('ethers');
const { Group } = require('@semaphore-protocol/group');
const { generateProof } = require('@semaphore-protocol/proof');

const SEMAPHORE_EVENTS = [
  'event MemberAdded(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 merkleTreeRoot)',
  'event MembersAdded(uint256 indexed groupId, uint256 startIndex, uint256[] identityCommitments, uint256 merkleTreeRoot)',
  'event MemberUpdated(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 newIdentityCommitment, uint256 merkleTreeRoot)',
  'event MemberRemoved(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 merkleTreeRoot)',
];

/**
 * Rebuild a group exactly as it was when the poll froze its electorate, by
 * replaying the group's membership events until the on-chain snapshot root.
 */
async function groupAtSnapshot({ provider, semaphoreAddress, groupId, snapshotRoot, toBlock = 'latest', fromBlock = 0 }) {
  const semaphore = new ethers.Contract(semaphoreAddress, SEMAPHORE_EVENTS, provider);
  const filters = ['MemberAdded', 'MembersAdded', 'MemberUpdated', 'MemberRemoved'].map((n) => semaphore.filters[n](groupId));
  const logs = (await Promise.all(filters.map((f) => semaphore.queryFilter(f, fromBlock, toBlock))))
    .flat()
    .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

  const group = new Group();
  let match = null;
  for (const ev of logs) {
    const a = ev.args;
    switch (ev.fragment.name) {
      case 'MemberAdded': group.addMember(a.identityCommitment); break;
      case 'MembersAdded': group.addMembers([...a.identityCommitments]); break;
      case 'MemberUpdated': group.updateMember(Number(a.index), a.newIdentityCommitment); break;
      case 'MemberRemoved': group.removeMember(Number(a.index)); break;
      default: break;
    }
    if (BigInt(a.merkleTreeRoot) === BigInt(snapshotRoot)) match = Group.import(group.export());
  }
  if (!match) throw new Error('could not reconstruct the poll snapshot from membership events');
  return match;
}

function localArtifacts(depth) {
  const dir = process.env.SEMAPHORE_ARTIFACTS_DIR;
  if (!dir) return undefined;
  return { wasm: path.join(dir, `semaphore-${depth}.wasm`), zkey: path.join(dir, `semaphore-${depth}.zkey`) };
}

/**
 * @param {object} p
 * @param {ethers.Provider} p.provider
 * @param {ethers.Contract} p.vote      MandateVote contract (read-only is fine)
 * @param {bigint|number} p.pollId
 * @param {import('@semaphore-protocol/identity').Identity} p.identity
 * @param {number} p.option            0 = YES, 1 = NO, or a choice index
 * @returns {Promise<object>} Ballot struct ready for castBallot / the relayer
 */
async function buildBallot({ provider, vote, pollId, identity, option }) {
  const poll = await vote.getPoll(pollId);
  const [identityAddr, scope] = await Promise.all([vote.identity(), vote.scopeOf(pollId)]);
  const registry = new ethers.Contract(identityAddr, ['function semaphore() view returns (address)'], provider);
  const created = await vote.queryFilter(vote.filters.PollCreated(pollId));
  if (!created.length) throw new Error(`poll ${pollId} not found`);

  const group = await groupAtSnapshot({
    provider,
    semaphoreAddress: await registry.semaphore(),
    groupId: poll.groupId,
    snapshotRoot: poll.snapshotRoot,
    toBlock: created[0].blockNumber,
  });
  if (group.indexOf(identity.commitment) === -1) throw new Error('this identity was not eligible when the poll opened');

  const depth = Math.max(group.depth, 1);
  const proof = await generateProof(identity, group, option, scope, depth, localArtifacts(depth));
  return {
    merkleTreeDepth: proof.merkleTreeDepth,
    merkleTreeRoot: proof.merkleTreeRoot,
    nullifier: proof.nullifier,
    message: proof.message,
    scope: proof.scope,
    points: proof.points,
  };
}

module.exports = { buildBallot, groupAtSnapshot };
