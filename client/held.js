/**
 * client/held.js - a carrier's fingerprint of the ballots it holds (MandateVote.commitHeld).
 * Published before a poll closes (signed by the carrier, so anyone can post it, even from a
 * text message), it proves those exact ballots existed before the close; after the close each
 * is delivered with its path to the fingerprint (deliverHeld). Matches OpenZeppelin's
 * MerkleProof: leaves are keccak(keccak(abi.encode(nullifier, message))), pairs hashed sorted.
 */
'use strict';

const { ethers } = require('ethers');

const coder = ethers.AbiCoder.defaultAbiCoder();
const leafOf = (b) => ethers.keccak256(ethers.keccak256(coder.encode(['uint256', 'uint256'], [BigInt(b.nullifier), BigInt(b.message)])));
const pair = (a, b) => ethers.keccak256(ethers.concat(BigInt(a) < BigInt(b) ? [a, b] : [b, a]));

/** Fingerprint of a set of ballots: { root, paths } (paths[i] for ballots[i]). */
function heldTree(ballots) {
  if (!ballots.length) throw new Error('no ballots');
  const leaves = ballots.map(leafOf);
  const paths = leaves.map(() => []);
  let level = leaves.map((h, i) => ({ h, who: [i] }));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1];
      if (!b) {
        next.push(a); // odd one out goes up unchanged
        continue;
      }
      for (const w of a.who) paths[w].push(b.h);
      for (const w of b.who) paths[w].push(a.h);
      next.push({ h: pair(a.h, b.h), who: [...a.who, ...b.who] });
    }
    level = next;
  }
  return { root: level[0].h, paths };
}

/** What the carrier signs (with its Ethereum key) for commitHeld. */
const heldDigest = ({ chainId, voteAddress, pollId, root }) =>
  ethers.getBytes(ethers.keccak256(coder.encode(['string', 'uint256', 'address', 'uint256', 'bytes32'], ['promissa-held', chainId, voteAddress, pollId, root])));

const signHeld = (signer, where) => signer.signMessage(heldDigest(where));

/** A short code a carrier can text to anyone with a connection: PH1:<chain>:<vote>:<poll>:<root>:<sig>. */
const heldCode = ({ chainId, voteAddress, pollId, root }, sig) => `PH1:${chainId}:${voteAddress}:${pollId}:${root}:${sig}`;
function readHeldCode(text) {
  const m = String(text).trim().match(/^PH1:(\d+):(0x[0-9a-fA-F]{40}):(\d+):(0x[0-9a-fA-F]{64}):(0x[0-9a-fA-F]{130})$/);
  if (!m) throw new Error('That is not a carrier fingerprint code.');
  return { chainId: Number(m[1]), voteAddress: m[2], pollId: BigInt(m[3]), root: m[4], sig: m[5] };
}

/** commitHeld's arguments from a signature: [v, r, s]; [0, 0, 0] when the carrier sends it itself. */
function sigParts(sig) {
  if (!sig || sig === '0x') return [0, ethers.ZeroHash, ethers.ZeroHash];
  const x = ethers.Signature.from(sig);
  return [x.v, x.r, x.s];
}

module.exports = { sigParts, leafOf, heldTree, heldDigest, signHeld, heldCode, readHeldCode };
