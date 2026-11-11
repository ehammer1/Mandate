// Photos and documents: only members on the voter list can add them (anonymously), a few a
// day, only the file the proof was made for, only safe file types; AI reading; takedowns.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Identity } = require('@semaphore-protocol/identity');
const { deployAll } = require('../scripts/deploy');
const { uploadProof } = require('../client/uploads');
const { createUploads, today } = require('../services/identity/uploads');
const { readUpload } = require('../services/explainer/explain');

process.env.SEMAPHORE_ARTIFACTS_DIR = path.dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json'));
let provider, c, cfg;
const member = new Identity('uploader');
const stranger = new Identity('not-enrolled');
const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, n)]);
const stored = new Map();
const store = { pin: async (bytes) => { const cid = `bafy${stored.size.toString().padStart(30, '0')}`; stored.set(cid, bytes); return cid; }, unpin: async (cid) => stored.delete(cid) };

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  const admin = await provider.getSigner(0);
  ({ contracts: c } = await deployAll(admin, {}));
  await (await c.identity.setIssuer(admin.address, 1, true, 'Clerk')).wait();
  await (await c.identity.enroll(member.commitment, 1, ethers.id('upload-doc'), 0)).wait();
  cfg = { identityAddress: await c.identity.getAddress() };
});
after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('a member adds files anonymously, within the daily limit; the proof fits only that file', async () => {
  let reads = 0;
  const up = createUploads({ store, appConfig: () => cfg, provider, perDay: 2, read: async () => (reads++, { kind: 'photo', alt: 'a sign', text: '', summary: 's', personal_info: false, personal_info_note: '' }), adminToken: 't0ken' });
  const send = async (bytes, slot, extra = {}) => up.upload(bytes, { 'content-type': 'image/jpeg', 'x-upload-proof': await uploadProof({ provider, identityAddress: cfg.identityAddress, identity: member, bytes, slot }), 'x-file-name': 'a.jpg', ...extra }, new URLSearchParams('read=1'));

  const [s1, out] = await send(jpeg(1), 0);
  assert.equal(s1, 200, JSON.stringify(out));
  assert.match(out.sha256, /^[0-9a-f]{64}$/);
  assert.equal(out.ai.alt, 'a sign');
  assert.equal(reads, 1);
  assert.match((await send(jpeg(2), 0))[1].error, /slot was already used/); // one file per slot
  assert.equal((await send(jpeg(3), 1))[0], 200);
  assert.match((await send(jpeg(4), 2))[1].error, /Daily upload limit/); // 2 a day here

  // A proof made for one file cannot carry another.
  const proof = await uploadProof({ provider, identityAddress: cfg.identityAddress, identity: member, bytes: jpeg(5), slot: 1, day: today() });
  assert.match((await up.upload(jpeg(6), { 'content-type': 'image/jpeg', 'x-upload-proof': proof }, new URLSearchParams()))[1].error, /not for this file/);
  // Only real photos and PDFs.
  assert.equal((await up.upload(Buffer.from('<script>alert(1)</script>'), { 'content-type': 'image/jpeg', 'x-upload-proof': proof }, new URLSearchParams()))[0], 415);
  assert.equal((await up.upload(Buffer.from('MZ...'), { 'content-type': 'application/x-msdownload', 'x-upload-proof': proof }, new URLSearchParams()))[0], 415);
  // Someone not on the voter list cannot even make a proof.
  await assert.rejects(uploadProof({ provider, identityAddress: cfg.identityAddress, identity: stranger, bytes: jpeg(7), slot: 0 }), /Join the voter list/);
  // A made-up proof is refused by the chain's verifier.
  const fake = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(proof, 'base64').toString()), nullifier: '123', message: String(BigInt(`0x${require('crypto').createHash('sha256').update(jpeg(8)).digest('hex')}`) >> 8n) })).toString('base64');
  assert.match((await up.upload(jpeg(8), { 'content-type': 'image/jpeg', 'x-upload-proof': fake }, new URLSearchParams()))[1].error, /Could not confirm/);

  // Takedowns need the admin token; they unpin and block the file.
  assert.equal((await up.remove({ cid: out.cid }, 'Bearer wrong'))[0], 401);
  assert.equal((await up.remove({ cid: out.cid, reason: 'private details' }, 'Bearer t0ken'))[0], 200);
  assert.deepEqual(up.blocked(), [out.cid]);
  assert.equal(stored.has(out.cid), false);
});

test('AI reading sends the file to Claude and returns text, summary, description and a privacy flag', async () => {
  let req;
  const client = { beta: { messages: { create: async (r) => {
    req = r;
    return { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify({ kind: 'document', alt: 'A letter', text: 'Dear resident', summary: 'A letter about parking.', personal_info: true, personal_info_note: 'a home address' }) }] };
  } } } };
  const out = await readUpload(Buffer.from('%PDF-1.4 test'), 'application/pdf', { client });
  assert.equal(req.messages[0].content[0].type, 'document');
  assert.equal(req.messages[0].content[0].source.media_type, 'application/pdf');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.deepEqual([out.alt, out.personal_info, out.personal_info_note, out.model], ['A letter', true, 'a home address', 'claude-opus-5-5']);
  await readUpload(jpeg(9), 'image/jpeg', { client });
  assert.equal(req.messages[0].content[0].type, 'image');
});
