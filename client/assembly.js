/**
 * client/assembly.js - citizens' assemblies (Assemblies contract): redo a draw from its public
 * seed, find whether this voter was drawn, and make or check the signed code a drawn resident
 * gives the organizer to accept a seat.
 */
'use strict';

const { ethers } = require('ethers');
const { Identity } = require('@semaphore-protocol/identity');

const ASSEMBLIES_ABI = [
  'function assemblyCount() view returns (uint256)',
  'function getAssembly(uint256) view returns (tuple(uint8 tier, uint16 seats, uint16 filled, uint64 announcedAt, uint64 changeAt, uint256 size, uint256 drawBlock, bytes32 seed, address organizer, string ref, string reportRef, uint64 drawnAt, uint16 reschedules, uint32 nextAlternate))',
  'function skipAlternate(uint256 id)',
  'function ACCEPT_PERIOD() view returns (uint64)',
  'function candidate(uint256, uint256) view returns (uint256)',
  'function seated(uint256, uint256) view returns (bool)',
  'function identity() view returns (address)',
  'function ORGANIZER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32, address) view returns (bool)',
  'function announce(uint8 tier, uint16 seats, uint256 waitBlocks, string ref) returns (uint256)',
  'function draw(uint256 id)',
  'function reschedule(uint256 id)',
  'function acceptSeat(uint256 id, uint256 position)',
  'function report(uint256 id, string ref)',
  'event Announced(uint256 indexed id, uint8 tier, uint16 seats, uint256 size, uint256 drawBlock, string ref)',
  'error BadParams()', 'error UnknownAssembly()', 'error TooEarly()', 'error Missed()', 'error AlreadyDrawn()', 'error NotDrawn()', 'error NotOrganizer()', 'error SeatsFull()', 'error AlreadySeated()', 'error OutOfOrder()',
];
const LIST_ABI = ['function leaves(uint8, uint256, uint256) view returns (uint256[] commitments, uint64[] removedAt)'];

const coder = ethers.AbiCoder.defaultAbiCoder();

/** Step k of the draw: a list entry (leaf index), as the contract's candidate(id, k). */
const candidateAt = (seed, k, size) => BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint256'], [seed, k]))) % BigInt(size);

/**
 * The draw order: the first `count` people drawn, skipping repeats and voters removed before
 * the announcement. Anyone can run this; the result is the same for everyone.
 * @returns {Promise<{ position: number, leafIndex: number, commitment: bigint }[]>}
 */
async function drawOrder({ assemblies, provider, id, count }) {
  const a = await assemblies.getAssembly(id);
  if (a.seed === ethers.ZeroHash) return [];
  const list = new ethers.Contract(await assemblies.identity(), LIST_ABI, provider || assemblies.runner);
  const size = Number(a.size);
  const commitments = [];
  const removedAt = [];
  for (let start = 0; start < size; start += 1000) {
    const [c, r] = await list.leaves(a.tier, start, Math.min(1000, size - start));
    commitments.push(...c);
    removedAt.push(...r);
  }
  const eligible = (i) => removedAt[i] === 0n || removedAt[i] > a.changeAt;
  const want = Math.min(count ?? Number(a.seats) * 5, commitments.filter((_, i) => eligible(i)).length);
  const seen = new Set();
  const order = [];
  for (let k = 0; order.length < want && k < want * 60 + 1000; k++) {
    const i = Number(candidateAt(a.seed, k, size));
    if (seen.has(i) || !eligible(i)) continue;
    seen.add(i);
    order.push({ position: order.length, leafIndex: i, commitment: BigInt(commitments[i]) });
  }
  return order;
}

/** What a drawn resident signs to accept seat `position`. */
const acceptMessage = ({ chainId, address, id, position }) =>
  BigInt(ethers.keccak256(coder.encode(['string', 'uint256', 'address', 'uint256', 'uint256'], ['promissa-assembly-seat', chainId, address, id, position]))) >> 8n;

/** The code a drawn resident gives the organizer: signed with their voter key. */
function acceptCode(identity, { chainId, address, id, position }) {
  const sig = identity.signMessage(acceptMessage({ chainId, address, id, position }));
  const s = (x) => x.toString();
  const body = { v: 1, id: s(id), position: Number(position), pk: identity.publicKey.map(s), sig: { R8: sig.R8.map(s), S: s(sig.S) } };
  return `PA1.${ethers.encodeBase64(ethers.toUtf8Bytes(JSON.stringify(body)))}`;
}

/**
 * Check a seat code against the draw order: signed by the voter key whose code is at that
 * position. Returns { ok, id, position, reason }.
 */
function checkAcceptCode(code, { chainId, address, order }) {
  try {
    const m = String(code).replace(/\s+/g, '').match(/^PA1\.([A-Za-z0-9+/=]+)$/);
    if (!m) return { ok: false, reason: 'That is not a seat code.' };
    const b = JSON.parse(ethers.toUtf8String(ethers.decodeBase64(m[1])));
    const pk = b.pk.map(BigInt);
    const sig = { R8: b.sig.R8.map(BigInt), S: BigInt(b.sig.S) };
    const at = order.find((o) => o.position === Number(b.position));
    if (!at) return { ok: false, reason: 'Nobody was drawn at that position.' };
    if (Identity.generateCommitment(pk) !== at.commitment) return { ok: false, reason: 'This code is not from the voter drawn at that position.' };
    if (!Identity.verifySignature(acceptMessage({ chainId, address, id: BigInt(b.id), position: at.position }), sig, pk)) return { ok: false, reason: 'The signature does not match.' };
    return { ok: true, id: BigInt(b.id), position: at.position };
  } catch {
    return { ok: false, reason: 'That code could not be read.' };
  }
}

/**
 * A seated member's endorsement of the assembly's statement (a review panel's for-and-against,
 * a recommendation): signed with their voter key over the draft's notice-board reference, which
 * is a fingerprint of its exact text. Endorsements are collected by the organizer and published
 * with the final statement, so anyone can check how many seated members agreed to it.
 */
const endorseMessage = ({ chainId, address, id, position, ref }) =>
  BigInt(ethers.keccak256(coder.encode(['string', 'uint256', 'address', 'uint256', 'uint256', 'string'], ['promissa-assembly-endorse', chainId, address, id, position, ref]))) >> 8n;

function endorseCode(identity, { chainId, address, id, position, ref }) {
  const sig = identity.signMessage(endorseMessage({ chainId, address, id, position, ref }));
  const s = (x) => x.toString();
  const body = { v: 1, id: s(id), position: Number(position), ref, pk: identity.publicKey.map(s), sig: { R8: sig.R8.map(s), S: s(sig.S) } };
  return `PE1.${ethers.encodeBase64(ethers.toUtf8Bytes(JSON.stringify(body)))}`;
}

/**
 * Check endorsements of draft `ref`: each must be signed by the voter drawn at a seated
 * position. Returns the distinct seated positions that endorsed it, and the reasons others failed.
 */
function checkEndorsements(codes, { chainId, address, id, ref, order, seated }) {
  const ok = new Set();
  const bad = [];
  for (const code of codes || []) {
    try {
      const m = String(code).replace(/\s+/g, '').match(/^PE1\.([A-Za-z0-9+/=]+)$/);
      if (!m) throw new Error('not an endorsement code');
      const b = JSON.parse(ethers.toUtf8String(ethers.decodeBase64(m[1])));
      if (BigInt(b.id) !== BigInt(id) || b.ref !== ref) throw new Error('for a different assembly or text');
      const at = order.find((o) => o.position === Number(b.position));
      if (!at || !seated.has(at.position)) throw new Error('not from a seated member');
      const pk = b.pk.map(BigInt);
      if (Identity.generateCommitment(pk) !== at.commitment) throw new Error('not from the member at that seat');
      const sig = { R8: b.sig.R8.map(BigInt), S: BigInt(b.sig.S) };
      if (!Identity.verifySignature(endorseMessage({ chainId, address, id: BigInt(id), position: at.position, ref }), sig, pk)) throw new Error('signature does not match');
      ok.add(at.position);
    } catch (e) {
      bad.push(e.message);
    }
  }
  return { positions: [...ok].sort((a, b) => a - b), bad };
}

module.exports = { ASSEMBLIES_ABI, candidateAt, drawOrder, acceptMessage, acceptCode, checkAcceptCode, endorseMessage, endorseCode, checkEndorsements };
