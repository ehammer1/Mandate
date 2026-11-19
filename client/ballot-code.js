/**
 * client/ballot-code.js - a sealed ballot as a short text code, for a QR code.
 *
 * With no internet, a voter's phone shows its sealed ballot as a QR code and anyone (a clerk, an
 * admin, a neighbor: an "anchor") scans it and sends it on once they are online. The ballot is a
 * zero-knowledge proof: a carrier cannot change it, add to it or vote with it, and the blockchain
 * refuses a second ballot from the same voter whenever it arrives.
 *
 * Format: "PB1:" + base64url of 418 bytes: version(1) chainId(4) voteAddress(20) pollId(8)
 * depth(1) root, nullifier, message, scope (32 each) and the 8 proof points (32 each).
 */
'use strict';

const { ethers } = require('ethers');

const PREFIX = 'PB1:';
const SIZE = 1 + 4 + 20 + 8 + 1 + 32 * 12;

const b64url = (bytes) => ethers.encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => ethers.getBytes(ethers.decodeBase64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)));

/** @returns {string} the code to put in a QR code */
function encodeBallotCode({ chainId, voteAddress, pollId, ballot }) {
  if (!Array.isArray(ballot.points) || ballot.points.length !== 8) throw new Error('not a ballot');
  const word = (x) => ethers.toBeHex(BigInt(x), 32);
  const bytes = ethers.getBytes(
    ethers.concat([
      ethers.toBeHex(1, 1),
      ethers.toBeHex(BigInt(chainId), 4),
      ethers.getAddress(voteAddress),
      ethers.toBeHex(BigInt(pollId), 8),
      ethers.toBeHex(Number(ballot.merkleTreeDepth), 1),
      word(ballot.merkleTreeRoot),
      word(ballot.nullifier),
      word(ballot.message),
      word(ballot.scope),
      ...ballot.points.map(word),
    ]),
  );
  return PREFIX + b64url(bytes);
}

/** @returns {{ chainId: number, voteAddress: string, pollId: string, ballot: object }} or throws */
function decodeBallotCode(text) {
  const t = String(text || '').trim();
  if (!t.startsWith(PREFIX)) throw new Error('This is not a Promissa ballot code.');
  let b;
  try {
    b = fromB64url(t.slice(PREFIX.length));
  } catch {
    throw new Error('This ballot code is damaged. Ask the person to show it again.');
  }
  if (b.length !== SIZE || b[0] !== 1) throw new Error('This ballot code is damaged or from a newer version of the app.');
  let at = 1;
  const take = (n) => b.slice(at, (at += n));
  const num = (n) => BigInt(ethers.hexlify(take(n)));
  const chainId = Number(num(4));
  const voteAddress = ethers.getAddress(ethers.hexlify(take(20)));
  const pollId = num(8).toString();
  const depth = Number(num(1));
  const [root, nullifier, message, scope] = [0, 1, 2, 3].map(() => num(32).toString());
  const points = Array.from({ length: 8 }, () => num(32).toString());
  return { chainId, voteAddress, pollId, ballot: { merkleTreeDepth: depth, merkleTreeRoot: root, nullifier, message, scope, points } };
}

module.exports = { encodeBallotCode, decodeBallotCode, BALLOT_CODE_PREFIX: PREFIX };
