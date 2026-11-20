// Evidence handed over from Testimonia (#evidence=…): kept until the mandate is opened,
// filled into an empty evidence box only, and refused when it isn't Testimonia evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
let cleared = false;
globalThis.history = { replaceState: () => (cleared = true) };
globalThis.location = { pathname: '/Mandate/', search: '' };
const { takeEvidenceLink, pendingEvidence, clearPendingEvidence, fillEvidence, acceptHandOff, handedFiles } = await import('../app/src/from-testimonia.js');
const b64url = (s) => Buffer.from(s).toString('base64url');

test('a Testimonia evidence link is kept, cleared from the address, and fills only an empty box', () => {
  const text = 'Photo of the repaired bridge.\n\n```testimonia\n[{"file":"bafyfile","record":"bafyrec"}]\n```\n';
  assert.equal(takeEvidenceLink(`#evidence=${b64url(text)}`), true);
  assert.equal(cleared, true);
  assert.equal(pendingEvidence(), text);
  const boxes = [{ id: 'evidence-1', value: '', after(n) { this.note = n; }, nextElementSibling: null }, { id: 'evidence-2', value: 'already written', after() {}, nextElementSibling: null }];
  globalThis.document = { createElement: () => ({ classList: { contains: () => false } }) };
  fillEvidence({ querySelectorAll: () => boxes });
  assert.equal(boxes[0].value, text);
  assert.match(boxes[0].note.textContent, /Filled in from Testimonia/);
  assert.equal(boxes[1].value, 'already written');
  clearPendingEvidence();
  assert.equal(pendingEvidence(), null);
});

test('links without a Testimonia block, or damaged, are ignored', () => {
  assert.equal(takeEvidenceLink(`#evidence=${b64url('just text, no media block')}`), false);
  assert.equal(takeEvidenceLink('#evidence=%%%'), false);
  assert.equal(takeEvidenceLink('#poll-3'), false);
  assert.equal(pendingEvidence(), null);
});

test('sealed files handed over: only from Testimonia, only photos, videos and its records', () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff]).buffer;
  const msg = (origin, files) => ({ origin, data: { type: 'testimonia-evidence/1', files } });
  assert.equal(acceptHandOff(msg('https://evil.example', [{ name: 'a.jpg', type: 'image/jpeg', bytes }])), 0, 'another site');
  assert.equal(acceptHandOff(msg('https://ehammer1.github.io', [{ name: 'a.exe', type: 'application/x-msdownload', bytes }])), 0, 'not a photo, video or record');
  assert.equal(acceptHandOff(msg('https://ehammer1.github.io', [{ name: 'IMG_1.jpg', type: 'image/jpeg', bytes }, { name: 'IMG_1.jpg.registration.json', type: 'application/json', bytes: new TextEncoder().encode('{}').buffer }])), 2);
  assert.deepEqual(handedFiles().map((f) => [f.name, f.type, f.size]), [['IMG_1.jpg', 'image/jpeg', 3], ['IMG_1.jpg.registration.json', 'application/json', 2]]);
});
