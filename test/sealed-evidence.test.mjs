// Testimonia-sealed media added to Promissa evidence untouched (app/src/sealed-evidence.js):
// files paired with their records, copies with their originals, locations noticed, and the
// evidence block written or extended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasLocation, pairEvidence, withEvidenceBlock } from '../app/src/sealed-evidence.js';

const reg = (sha) => ({ format: 'attest-file/1', file: { sha256: sha } });
const derive = (orig, out) => ({ format: 'attest-derive/1', original: `0x${orig}`, output: { sha256: out } });

test('files pair with their records, and a redacted copy goes in under its sealed original', () => {
  const files = [{ name: 'bridge.jpg', sha256: 'aa', cid: 'Qorig' }, { name: 'bridge-redacted.jpg', sha256: 'bb', cid: 'Qcopy' }, { name: 'clip.mp4', sha256: 'cc', cid: 'Qvid' }];
  const records = [{ name: 'bridge.jpg.registration.json', json: reg('aa'), cid: 'Rorig' }, { name: 'bridge-redacted.derive.json', json: derive('aa', 'bb'), cid: 'Rcopy' }];
  const { refs, problems } = pairEvidence(files, records);
  assert.deepEqual(problems, []);
  assert.deepEqual(refs, [{ file: 'Qorig', record: 'Rorig', edits: [{ file: 'Qcopy', record: 'Rcopy' }] }, { file: 'Qvid' }]);
});

test('what can’t be checked is said plainly', () => {
  const { problems } = pairEvidence([{ name: 'photo.jpg', sha256: 'aa', cid: 'Q1' }, { name: 'copy.jpg', sha256: 'bb', cid: 'Q2' }], [{ name: 'copy.derive.json', json: derive('zz', 'bb'), cid: 'R' }]);
  assert.match(problems.join('\n'), /copy\.jpg: add its sealed original too/);
  assert.match(problems.join('\n'), /photo\.jpg: add its Testimonia record too/);
});

test('a photo or video carrying where it was taken is noticed; one Testimonia already cleaned isn’t', () => {
  const le = (n, w) => Array.from({ length: w }, (_, i) => (n >> (8 * i)) & 0xff);
  const entry = (tag, type, count, value) => [...le(tag, 2), ...le(type, 2), ...le(count, 4), ...le(value, 4)];
  const jpeg = (gpsEntries) => {
    const tiff = [0x49, 0x49, 0x2a, 0, ...le(8, 4), ...le(1, 2), ...entry(0x8825, 4, 1, 26), ...le(0, 4), ...le(gpsEntries, 2), ...(gpsEntries ? entry(0x0001, 2, 2, 0x4e) : []), ...le(0, 4)];
    const app1 = [...Buffer.from('Exif\0\0'), ...tiff];
    return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 0xff, ...app1, 0xff, 0xda, 0, 2]);
  };
  assert.equal(hasLocation(jpeg(1), 'image/jpeg'), true);
  assert.equal(hasLocation(jpeg(0), 'image/jpeg'), false, 'an emptied GPS directory: location already removed');
  const box = (type, body) => { const n = 8 + body.length; return [0, 0, n >> 8, n & 255, ...Buffer.from(type, 'latin1'), ...body]; };
  const video = (loc) => new Uint8Array([...box('ftyp', [...Buffer.from('qt  ')]), ...box('moov', [...Buffer.from(loc)])]);
  assert.equal(hasLocation(video('©xyz+37.3349-122.0090/'), 'video/quicktime'), true);
  assert.equal(hasLocation(video('©xyz                  '), 'video/quicktime'), false);
});

test('the evidence block is written, or extended when there is one', () => {
  const one = withEvidenceBlock('The bridge was repaired.', [{ file: 'Q1' }]);
  assert.equal(one, 'The bridge was repaired.\n\n```testimonia\n[{"file":"Q1"}]\n```\n');
  const two = withEvidenceBlock(one, [{ file: 'Q2', record: 'R2' }]);
  assert.match(two, /\[\{"file":"Q1"\},\{"file":"Q2","record":"R2"\}\]/);
  assert.equal((two.match(/```testimonia/g) || []).length, 1);
});
