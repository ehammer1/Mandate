/**
 * client/districts.js - results by district (Districts contract), anonymously.
 *
 * After voting or signing, a resident on a district's voter list may add their district to their
 * own ballot or signature: a proof of membership of the district with the same scope, so the
 * same one-time code. Results are then counted from the public records:
 *   - a poll: each tagged ballot's final choice (its latest BallotCast);
 *   - a petition: each tagged signature (its one-time code used on the petition contract).
 * Districts with fewer than 5 tagged ballots are not shown separately: they are counted with the
 * ballots that carry no district, so no small group's choices can be read off.
 */
'use strict';

const { ethers } = require('ethers');
const { generateProof } = require('@semaphore-protocol/proof');
const { groupAtSnapshot, artifactsAt, envArtifacts, REGISTRY_ABI, VOTER_GROUPS_ABI } = require('./ballot');

const PROOF = 'tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points)';
const DISTRICTS_ABI = [
  'function groups() view returns (address)',
  'function minMembers() view returns (uint256)',
  'function districts() view returns (uint256[])',
  'function isDistrict(uint256) view returns (bool)',
  'function districtOf(uint256 scope, uint256 nullifier) view returns (bool tagged, uint256 groupId)',
  'function addDistrict(uint256 groupId)',
  `function tag(uint256 groupId, ${PROOF} proof)`,
  'event Tagged(uint256 indexed scope, uint256 indexed nullifier, uint256 indexed groupId)',
  'error NotAllowed()', 'error NotADistrict()', 'error TooFewMembers(uint256 members, uint256 needed)', 'error AlreadyTagged()', 'error WrongMessage()', 'error InvalidProof()',
];
const GROUPS_ABI = [
  ...VOTER_GROUPS_ABI,
  'function voterList() view returns (address)',
  'function semaphore() view returns (address)',
  'function leafCount(uint256) view returns (uint256)',
  'function isMember(uint256, uint256) view returns (bool)',
  'function getGroup(uint256) view returns (tuple(string name, address manager, uint8 baseTier, uint64 createdAt) g, uint256 size)',
];
const SEMAPHORE_ABI = ['function getMerkleTreeRoot(uint256) view returns (uint256)'];
const VOTE_EVENTS = ['event BallotCast(uint256 indexed id, uint256 option, uint256 nullifier)'];

/** Districts below this many tagged ballots are not shown on their own. */
const MIN_SHOWN = 5;
const BLOCKS = 9000; // per log query (public nodes limit the range)

const groupsOf = async (districts, runner) => new ethers.Contract(await districts.groups(), GROUPS_ABI, runner);

/** The districts, with their names and how many people are on each list. */
async function listDistricts(districts) {
  const runner = districts.runner;
  const groups = await groupsOf(districts, runner);
  const ids = await districts.districts();
  return Promise.all(ids.map(async (id) => {
    const [g, size] = await groups.getGroup(id);
    return { groupId: id, name: g.name, size: Number(size) };
  }));
}

/** The district this voter is on the list of (the first, if several), or null. */
async function myDistrict(districts, commitment) {
  const groups = await groupsOf(districts, districts.runner);
  for (const id of await districts.districts()) if (await groups.isMember(id, commitment)) return id;
  return null;
}

/** The proof that adds a district to one's own ballot or signature (same scope, same one-time code). */
async function districtProof({ provider, districts, identity, groupId, scope, artifactsBase }) {
  const groups = await groupsOf(districts, provider);
  const registry = new ethers.Contract(await groups.voterList(), REGISTRY_ABI, provider);
  const sem = new ethers.Contract(await groups.semaphore(), SEMAPHORE_ABI, provider);
  const [root, size] = await Promise.all([sem.getMerkleTreeRoot(groupId), groups.leafCount(groupId)]);
  const group = await groupAtSnapshot({ registry, voterGroups: groups, groupId, electorate: size, snapshotRoot: root });
  if (group.indexOf(identity.commitment) === -1) throw new Error('you are not on this district’s voter list');
  const depth = Math.max(group.depth, 1);
  const p = await generateProof(identity, group, BigInt(groupId), BigInt(scope), depth, artifactsAt(artifactsBase || envArtifacts(), depth));
  return { merkleTreeDepth: p.merkleTreeDepth, merkleTreeRoot: p.merkleTreeRoot, nullifier: p.nullifier, message: p.message, scope: p.scope, points: p.points };
}

/** Logs in ranges a public node accepts. */
async function logsInRange(contract, filter, fromBlock, toBlock) {
  const out = [];
  for (let a = fromBlock; a <= toBlock; a += BLOCKS) out.push(...(await contract.queryFilter(filter, a, Math.min(toBlock, a + BLOCKS - 1))));
  return out;
}

/** Every district tag on a scope: nullifier → district. */
async function tagsFor(districts, scope, fromBlock, toBlock) {
  const logs = await logsInRange(districts, districts.filters.Tagged(BigInt(scope)), fromBlock, toBlock);
  const m = new Map();
  for (const l of logs) m.set(String(l.args.nullifier), l.args.groupId);
  return m;
}

/**
 * Hide districts with fewer than MIN_SHOWN tagged ballots: they join the ballots with no district
 * ("other"). The totals are public, so "other" could be worked out by subtraction: if it hides a
 * small district among fewer than MIN_SHOWN ballots, the smallest shown district joins it too.
 * Returns { shown: [{ groupId, n, counts }], other: { n, counts } }.
 */
function suppress(byDistrict, untagged, options) {
  const all = [...byDistrict].map(([groupId, d]) => ({ groupId, n: d.n, counts: d.counts }));
  const other = { n: untagged.n, counts: [...untagged.counts] };
  const join = (d) => {
    other.n += d.n;
    for (let i = 0; i < options; i++) other.counts[i] += d.counts[i];
  };
  let hidden = 0; // ballots of small districts in "other"
  let shown = all.filter((d) => (d.n >= MIN_SHOWN ? true : ((hidden += d.n), join(d), false)));
  shown.sort((a, b) => a.n - b.n);
  // Ballots with no district are no identifiable group; a small district hidden among too few is.
  while (hidden > 0 && other.n < MIN_SHOWN && shown.length) join(shown.shift());
  shown = shown.sort((a, b) => b.n - a.n);
  return { shown, other };
}

/** A poll's results by district (plain choices; ranked and handed-to-a-delegate ballots stay in "other"). */
async function pollByDistrict({ vote, districts, pollId, options, fromBlock, toBlock }) {
  const v = new ethers.Contract(await vote.getAddress(), VOTE_EVENTS, vote.runner);
  const head = toBlock ?? (await vote.runner.provider.getBlockNumber());
  const [scope, logs] = await Promise.all([vote.scopeOf(pollId), logsInRange(v, v.filters.BallotCast(pollId), fromBlock, head)]);
  const final = new Map();
  for (const l of logs) final.set(String(l.args.nullifier), Number(l.args.option)); // the latest counts
  const tags = await tagsFor(districts, scope, fromBlock, head);
  const by = new Map();
  const untagged = { n: 0, counts: Array(options).fill(0) };
  for (const [nullifier, option] of final) {
    const plain = option < options;
    const g = tags.get(nullifier);
    const d = g === undefined || !plain ? untagged : by.get(String(g)) || by.set(String(g), { n: 0, counts: Array(options).fill(0) }).get(String(g));
    d.n += 1;
    if (plain) d.counts[option] += 1;
  }
  return suppress(by, untagged, options);
}

/**
 * A petition's signatures by district: tags on the petition's scope whose one-time code was
 * used on the petition contract (so the signature exists). [total]: the petition's own count.
 */
async function signaturesByDistrict({ target, districts, scope, total, fromBlock, toBlock }) {
  const head = toBlock ?? (await districts.runner.provider.getBlockNumber());
  const tags = await tagsFor(districts, scope, fromBlock, head);
  const by = new Map();
  let tagged = 0;
  for (const [nullifier, g] of tags) {
    if (!(await target.nullifierUsed(BigInt(nullifier)))) continue;
    const d = by.get(String(g)) || by.set(String(g), { n: 0, counts: [0] }).get(String(g));
    d.n += 1;
    d.counts[0] += 1;
    tagged += 1;
  }
  const untagged = Math.max(0, Number(total) - tagged);
  return suppress(by, { n: untagged, counts: [untagged] }, 1);
}

module.exports = { DISTRICTS_ABI, GROUPS_ABI, MIN_SHOWN, listDistricts, myDistrict, districtProof, tagsFor, pollByDistrict, signaturesByDistrict, suppress };
