/**
 * client/uploads.js - add a photo or document: an anonymous proof that the uploader is on
 * the voter list, bound to this exact file and to one of today's upload slots.
 */
'use strict';

const { ethers } = require('ethers');
const { generateProof } = require('@semaphore-protocol/proof');
const { groupAtSnapshot, artifactsAt, envArtifacts, REGISTRY_ABI } = require('./ballot');

const IDENTITY_ABI = [...REGISTRY_ABI, 'function semaphore() view returns (address)', 'function leafCount(uint8) view returns (uint256)', 'function members(uint256) view returns (address issuer, uint8 tier, bool active)'];
const SEMAPHORE_ABI = ['function getMerkleTreeRoot(uint256) view returns (uint256)'];

const uploadScope = (day, slot) => BigInt(ethers.id(`mandate-upload:${day}:${slot}`)) >> 8n;
const fileMessage = (sha256Hex) => BigInt(`0x${sha256Hex}`) >> 8n;

/** SHA-256 of the bytes, as hex (Web Crypto in browsers, node:crypto in Node). */
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
async function sha256Hex(bytes) {
  return hex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}
/** Base64 of UTF-8 text (browsers and Node). */
const b64 = (text) => {
  const bin = Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join('');
  return btoa(bin);
};

/**
 * @param {object} o
 * @param {ethers.Provider} o.provider
 * @param {string} o.identityAddress
 * @param {object} o.identity         the Semaphore identity (voter key)
 * @param {Uint8Array} o.bytes
 * @param {number} o.slot            0..perDay-1 (the app tries the next slot when one is used)
 * @param {string} [o.day]           YYYY-MM-DD (UTC), default today
 * @returns {Promise<string>} the proof, base64 JSON, for the X-Upload-Proof header
 */
async function uploadProof({ provider, identityAddress, identity, bytes, slot, day = new Date().toISOString().slice(0, 10), artifactsBase }) {
  const reg = new ethers.Contract(identityAddress, IDENTITY_ABI, provider);
  const m = await reg.members(identity.commitment);
  if (!m.active) throw new Error('Join the voter list to add photos or documents.');
  const tier = Number(m.tier);
  const groupId = await reg.groupId(tier);
  const sem = new ethers.Contract(await reg.semaphore(), SEMAPHORE_ABI, provider);
  const [root, size] = await Promise.all([sem.getMerkleTreeRoot(groupId), reg.leafCount(tier)]);
  const group = await groupAtSnapshot({ registry: reg, groupId, electorate: size, snapshotRoot: root });
  const depth = Math.max(group.depth, 1);
  const p = await generateProof(identity, group, fileMessage(await sha256Hex(bytes)), uploadScope(day, slot), depth, artifactsAt(artifactsBase || envArtifacts(), depth));
  const body = { tier, merkleTreeDepth: String(p.merkleTreeDepth), merkleTreeRoot: String(p.merkleTreeRoot), nullifier: String(p.nullifier), message: String(p.message), scope: String(p.scope), points: p.points.map(String) };
  return b64(JSON.stringify(body));
}

module.exports = { uploadProof, uploadScope, fileMessage, sha256Hex };
