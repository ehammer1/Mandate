// Testimonia seals on Promissa files: the identifiers are read from any form a person has, kept
// next to Promissa's own fingerprint, and checked with Testimonia's own checker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSeal, recordFrom, sealMatches, checkSealUrl, sealHtml } from '../app/src/testimonia.js';

const h = (c) => c.repeat(64);
const photo = { format: 'attest-file/1', file: { sha256: h('a'), bytes: 10, name: 'IMG.jpg', mediaType: 'image/jpeg' }, kind: 'photo', signer: { keyId: h('b'), publicKey: 'MFk' }, sig: 'MEU', anchor: { format: 'attest-anchor/1', chainId: 84532, keyId: '0x' + h('b'), sealDigest: '0x' + h('c'), root: '0x' + h('d'), proof: [] } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

test('a photo record from a link, base64url text or JSON gives the same identifiers', () => {
  for (const input of [`https://example.org/testimonia/#proof=${b64(photo)}`, b64(photo), JSON.stringify(photo)]) {
    const s = readSeal(input);
    assert.deepEqual([s.kind, s.keyId, s.sealDigest, s.fileHash], ['file', h('b'), '0x' + h('c'), h('a')]);
    assert.deepEqual(recordFrom(`x#proof=${s.proof}`), photo); // the record travels with the post
  }
});

test('not anchored yet: no seal digest, never derived', () => {
  const { anchor, ...unanchored } = photo;
  assert.equal(readSeal(unanchored).sealDigest, null);
  assert.match(sealHtml({}, readSeal(unanchored), esc, { sha256: h('a') }), /not yet anchored on Base/);
});

test('recordings, shared recordings and edited copies', () => {
  const manifest = { meta: { keyId: h('e') }, seal: { fileHash: h('f') }, anchor: { sealDigest: '0x' + h('1') } };
  assert.deepEqual([readSeal(manifest).kind, readSeal(manifest).fileHash, readSeal(manifest).sealDigest], ['recording', h('f'), '0x' + h('1')]);
  const shared = { format: 'attest-record/1', sealDigest: '0x' + h('2'), manifest: { meta: { keyId: h('e') }, seal: { fileHash: h('f') } } };
  assert.equal(readSeal(shared).sealDigest, '0x' + h('2'));
  const copy = { format: 'attest-derive/1', output: { sha256: h('3') }, original: '0x' + h('a'), signer: { keyId: h('b') } };
  assert.deepEqual([readSeal(copy).kind, readSeal(copy).original, readSeal(copy).fileHash], ['copy', '0x' + h('a'), h('3')]);
});

test("a seal for another file is flagged; recordings can't be compared by fingerprint", () => {
  const s = readSeal(photo);
  assert.equal(sealMatches(s, h('a').toUpperCase()), true);
  assert.equal(sealMatches(s, h('9')), false);
  assert.match(sealHtml({}, s, esc, { sha256: h('9') }), /for a different file/);
  assert.equal(sealMatches({ ...s, kind: 'recording' }, h('9')), null);
});

test('the check link goes to Testimonia with the record; no check mark before Testimonia launches', () => {
  const s = readSeal(photo);
  assert.equal(checkSealUrl({ testimoniaUrl: 'https://t.example/' }, s), `https://t.example/#proof=${s.proof}`);
  const html = sealHtml({}, s, esc, { sha256: h('a') });
  assert.match(html, /Sealed by Testimonia: <a href="https:\/\/ehammer1\.github\.io\/testimonia\/#proof=/);
  assert.doesNotMatch(html, /✓/);
});

test('plain messages for things that are not seals', () => {
  assert.throws(() => readSeal('hello'), /not a Testimonia seal/);
  assert.throws(() => readSeal({ format: 'other/1' }), /kind Promissa does not know/);
  assert.throws(() => readSeal({ format: 'attest-file/1', file: {} }), /incomplete/);
});
