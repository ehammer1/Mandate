// Petitions delivered outside Promissa (PublicPetitions.sol, client/petitions.js), with real
// proofs: named signatures, one per verified person; photographed paper sheets with their
// circulator's statement; each sheet's chain of custody; and the check anyone can run.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Identity } = require('@semaphore-protocol/identity');
const { deployAll } = require('../scripts/deploy');
const P = require('../client/petitions');

process.env.SEMAPHORE_ARTIFACTS_DIR = path.dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json'));
let provider, admin, clerk, c, petitions, board;
const residents = Array.from({ length: 4 }, (_, i) => new Identity(`pp-resident-${i}`));
const outsider = new Identity('pp-outsider');
const send = async (p) => (await p).wait();
const errName = async (p) => {
  try {
    await p;
  } catch (e) {
    return petitions.interface.parseError(e.data)?.name || e.revert?.name || e.shortMessage;
  }
  return 'no revert';
};
/** Post a record on the notice board, as the relayer does; returns its reference. */
const post = async (doc) => {
  const text = JSON.stringify(doc);
  await send(board.post(text));
  return `nb:${ethers.keccak256(ethers.toUtf8Bytes(text))}`;
};
const sha = (s) => '0x' + crypto.createHash('sha256').update(s).digest('hex');
// Statements with names are kept as files in the community's storage (removable on request); here, in memory.
const storage = new Map();
const keep = async (doc) => {
  const bytes = P.statementBytes(doc);
  const hex = sha(bytes).slice(2);
  const cid = `bafy${hex.slice(0, 40)}`;
  storage.set(cid, bytes);
  return P.statementRef({ cid, sha256: hex });
};
const fetchStatement = async (cid) => storage.get(cid) ?? null;

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 4, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  [admin, clerk] = await Promise.all([0, 1].map((i) => provider.getSigner(i)));
  ({ contracts: c } = await deployAll(admin, { rules: { MIN_POLL_MINUTES: 10 } }));
  petitions = new ethers.Contract(await c.petitions.getAddress(), P.PETITIONS_ABI, admin);
  board = c.notices;
  await send(c.identity.setIssuer(clerk.address, 1, true, 'Clerk'));
  const longAgo = (await provider.getBlock('latest')).timestamp - 3 * 365 * 86_400;
  for (const [i, r] of residents.entries()) await send(c.identity.connect(clerk).enroll(r.commitment, 1, ethers.id(`pp-doc-${i}`), longAgo));
});

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('named signatures: one per verified person, exactly the words signed; the check finds them all', async () => {
  const ref = await post(P.petitionText({ title: 'Put a crosswalk at 5th and Main', body: 'Three crashes this year.', recipient: 'City Clerk, Springfield' }));
  await send(petitions.create(1, ref));
  const id = await petitions.petitionCount();
  const sign = async (who, name, place) => {
    const s = await keep(await P.signatureText(petitions, id, { name, place }));
    const proof = await P.signProof({ provider, petitions, identity: who, tier: 1, petitionId: id, ref: s });
    return { s, proof };
  };
  const a = await sign(residents[0], 'Ana López', 'Springfield');
  await send(petitions.signByName(id, a.s, a.proof));
  // The same person can't sign twice, even under another name; a proof can't carry other words.
  const again = await sign(residents[0], 'A. Lopez', 'Springfield');
  assert.equal(await errName(petitions.signByName.staticCall(id, again.s, again.proof)), 'NullifierUsed');
  const b = await sign(residents[1], 'Ben Okafor', 'Springfield');
  assert.equal(await errName(petitions.signByName.staticCall(id, a.s, b.proof)), 'WrongMessage');
  await send(petitions.signByName(id, b.s, b.proof));
  // Someone not on the voter list can't make a proof at all.
  await assert.rejects(P.signProof({ provider, petitions, identity: outsider, tier: 1, petitionId: id, ref: a.s }), /not on this voter list/);
  // Two different people with the same name both count, and the check points it out.
  const c2 = await sign(residents[2], 'ben okafor', 'Shelbyville');
  await send(petitions.signByName(id, c2.s, c2.proof));

  const ck = await P.checkPetition({ petitions, board, fetchStatement, id });
  assert.equal(ck.ok, true, ck.problems.join('; '));
  assert.equal(ck.petition.title, 'Put a crosswalk at 5th and Main');
  assert.equal(ck.petition.recipient, 'City Clerk, Springfield');
  assert.deepEqual(ck.named.map((s) => [s.name, s.place]), [['Ana López', 'Springfield'], ['Ben Okafor', 'Springfield'], ['ben okafor', 'Shelbyville']]);
  assert.deepEqual(ck.totals, { named: 3, removed: 0, sheets: 0, paperSignatures: 0, sameName: 1 });
  assert.match(P.packetCsv(ck), /^"kind","number","name"[\s\S]*"named","1","Ana López","Springfield","1"/);

  // Names are not on the blockchain: only where each statement is and its fingerprint.
  assert.match(a.s, /^st:bafy[0-9a-f]{40}#[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(JSON.stringify(await petitions.namedSignatures(id, 0, 10), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), /Ana|López/);
  // Taken down on request: the signature still counts, its name is gone, and the packet says so.
  storage.delete(/^st:([^#]+)#/.exec(a.s)[1]);
  const after = await P.checkPetition({ petitions, board, fetchStatement, id });
  assert.equal(after.ok, true, after.problems.join('; '));
  assert.deepEqual([after.totals.named, after.totals.removed, after.named[0].removed, after.named[0].name], [3, 1, true, '']);
  assert.match(P.packetCsv(after), /"named \(name removed on request\)","1",""/);
  // A stored statement changed after signing no longer matches its fingerprint.
  const cidB = /^st:([^#]+)#/.exec(b.s)[1];
  storage.set(cidB, P.statementBytes({ ...JSON.parse(Buffer.from(storage.get(cidB)).toString()), name: 'Someone Else' }));
  assert.match((await P.checkPetition({ petitions, board, fetchStatement, id })).problems.join(), /signature 2: .* doesn’t match its fingerprint/);

  // A statement for another petition (or without the consent) is caught by the check.
  await send(petitions.create(1, ref));
  const other = await petitions.petitionCount();
  const wrong = await keep({ ...(await P.signatureText(petitions, id, { name: 'Dee' })), consent: 'ok' });
  await send(petitions.signByName(other, wrong, await P.signProof({ provider, petitions, identity: residents[3], tier: 1, petitionId: other, ref: wrong })));
  assert.match((await P.checkPetition({ petitions, board, fetchStatement, id: other })).problems.join(), /signature 1 isn’t a signature of this petition/);
});

test('paper sheets: a photo filed once, the circulator’s statement, custody in order; the totals add up', async () => {
  const ref = await post(P.petitionText({ title: 'Recall ballot question', recipient: 'County Registrar', paper: true }));
  await send(petitions.create(1, ref));
  const id = await petitions.petitionCount();
  const photo = sha('photo of sheet 1');
  const file = async (who, photoHash, n, name, extra = {}) => {
    const s = await keep({ ...(await P.sheetText(petitions, id, { photo: photoHash, file: 'ipfs://bafy-sheet', signatures: n, name, testimonia: { keyId: 'ab'.repeat(32), sealDigest: null } })), ...extra });
    return { s, proof: await P.sheetProof({ provider, petitions, identity: who, tier: 1, petitionId: id, photo: photoHash, signatures: n, ref: s }) };
  };
  const one = await file(residents[0], photo, 18, 'Carla Ruiz');
  // A proof for 18 signatures doesn't file 20.
  assert.equal(await errName(petitions.fileSheet.staticCall(id, photo, 20, one.s, 1, one.proof)), 'WrongMessage');
  await send(petitions.fileSheet(id, photo, 18, one.s, 1, one.proof));
  const dup = await file(residents[1], photo, 18, 'Someone Else');
  assert.equal(await errName(petitions.fileSheet.staticCall(id, photo, 18, dup.s, 1, dup.proof)), 'PhotoAlreadyFiled');
  const two = await file(residents[0], sha('photo of sheet 2'), 7, 'Carla Ruiz');
  await send(petitions.fileSheet(id, sha('photo of sheet 2'), 7, two.s, 1, two.proof));
  assert.equal(await errName(petitions.fileSheet.staticCall(id, sha('photo of sheet 3'), 0, two.s, 1, two.proof)), 'BadCount');

  // Custody of sheet 1: the organizer, then the registrar's clerk.
  const receive = async (who, sheet, name, role) => {
    const s = await keep(await P.custodyText(petitions, id, { sheet, photo: (await petitions.sheets(id, sheet, 1))[0].photo, name, role }));
    await send(petitions.receiveSheet(id, sheet, s, 1, await P.custodyProof({ provider, petitions, identity: who, tier: 1, petitionId: id, sheet, ref: s })));
  };
  await receive(residents[1], 0, 'Dana Wu', 'organizer');
  await receive(residents[2], 0, 'Eli Park', 'registrar’s clerk');
  assert.equal(await errName(petitions.receiveSheet.staticCall(id, 5, one.s, 1, one.proof)), 'UnknownSheet');

  const ck = await P.checkPetition({ petitions, board, fetchStatement, id });
  assert.equal(ck.ok, true, ck.problems.join('; '));
  assert.deepEqual(ck.totals, { named: 0, removed: 0, sheets: 2, paperSignatures: 25, sameName: 0 });
  assert.equal(ck.sheets[0].circulator, 'Carla Ruiz');
  assert.deepEqual(ck.sheets[0].testimonia, { keyId: 'ab'.repeat(32), sealDigest: null }, 'the Testimonia seal’s identifiers are kept');
  assert.deepEqual(ck.sheets[0].custody.map((h) => `${h.name} (${h.role})`), ['Dana Wu (organizer)', 'Eli Park (registrar’s clerk)']);
  assert.deepEqual(ck.sheets[1].custody, []);
  assert.match(P.packetCsv(ck), /"paper sheet","1","","","18","0x[0-9a-f]{64}","Carla Ruiz","Dana Wu \(organizer\) [^;]+; Eli Park/);

  // A record whose own count differs from what was filed, or a reworded statement, is caught.
  const photo4 = sha('photo of sheet 4');
  const lie = await file(residents[3], photo4, 9, 'Fay Moss', { signatures: 90 });
  await send(petitions.fileSheet(id, photo4, 9, lie.s, 1, lie.proof));
  const photo5 = sha('photo of sheet 5');
  const reword = await file(residents[3], photo5, 3, 'Fay Moss', { statement: 'Trust me.' });
  await send(petitions.fileSheet(id, photo5, 3, reword.s, 1, reword.proof));
  const bad = await P.checkPetition({ petitions, board, fetchStatement, id });
  assert.match(bad.problems.join(), /sheet 3: its record gives another count/);
  assert.match(bad.problems.join(), /sheet 4: the circulator’s statement isn’t the standard one/);
});

test('the statements refuse what isn’t there', async () => {
  assert.throws(() => P.petitionText({ title: '', recipient: 'x' }), /what the petition asks/);
  assert.throws(() => P.petitionText({ title: 'x', recipient: '' }), /who it will be delivered to/);
  await assert.rejects(P.signatureText(petitions, 1, { name: ' ' }), /full name/);
  await assert.rejects(P.sheetText(petitions, 1, { photo: '0x12', signatures: 3, name: 'A' }), /64 hex digits/);
  await assert.rejects(P.sheetText(petitions, 1, { photo: sha('x'), signatures: 0, name: 'A' }), /how many signatures/);
  assert.equal(P.circulatorStatement({ name: 'Carla Ruiz', signatures: 1 }), 'I, Carla Ruiz, circulated this sheet. I saw each of its 1 signature made, and to the best of my knowledge each person signed their own name. The photo is of the sheet as signed.');
  assert.equal(await errName(petitions.create.staticCall(3, 'nb:0x' + '0'.repeat(64))), 'BadTier');
});

test('through the relayer: no wallet needed to start, sign, file or receive', async () => {
  const { createRelayer } = require('../broker/relayer');
  const relaySigner = await provider.getSigner(2);
  const server = createRelayer({ provider, signer: relaySigner, voteAddress: await c.vote.getAddress(), noticeBoardAddress: await c.notices.getAddress(), petitionsAddress: await c.petitions.getAddress(), log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, body) => {
    const res = await fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const ref = (await call('/notice', { text: JSON.stringify(P.petitionText({ title: 'Library open Sundays', recipient: 'Library Board' })) })).body.ref;
    const made = await call('/petitions', { method: 'create', args: [1, ref] });
    assert.equal(made.status, 200);
    const id = BigInt(made.body.id);
    const s = await keep(await P.signatureText(petitions, id, { name: 'Grace Hopper', place: 'Arlington' }));
    const proof = await P.signProof({ provider, petitions, identity: residents[3], tier: 1, petitionId: id, ref: s });
    assert.equal((await call('/petitions', { method: 'sign', args: [String(id), s], proof })).status, 200);
    const twice = await call('/petitions', { method: 'sign', args: [String(id), s], proof });
    assert.deepEqual([twice.status, twice.body.error], [409, 'NullifierUsed']);
    assert.equal((await call('/petitions', { method: 'sign', args: [String(id), s] })).status, 400, 'a signature needs its proof');
    assert.equal((await call('/petitions', { method: 'delete', args: [] })).status, 400);
    const ck = await P.checkPetition({ petitions, board, fetchStatement, id });
    assert.equal(ck.ok, true, ck.problems.join('; '));
    assert.deepEqual(ck.named.map((x) => x.name), ['Grace Hopper']);
  } finally {
    server.close();
  }
});
