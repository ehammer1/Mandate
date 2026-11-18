// The browser verifier must agree with the Node verifier on every case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { verifyCapture } from '../src/capture-web.mjs';

const require = createRequire(import.meta.url);
const node = require('../src/capture.js');
const V = path.join(import.meta.dirname, '..', 'capture', 'vectors');
const sealed = fs.readFileSync(path.join(V, 'sealed.mp4'));
const sample = fs.readFileSync(path.join(V, 'sample.mp4'));

function cases() {
  const out = { sealed, sample };
  const frag7 = Buffer.from(sealed);
  const { init, fragments, body, manifestJSON } = node.splitFile(sealed);
  frag7[init.length + fragments.slice(0, 7).reduce((a, f) => a + f.length, 0) + 200] ^= 0xff;
  out.fragmentChanged = frag7;
  const header = Buffer.from(sealed); header[40] ^= 1; out.headerChanged = header;
  const idx = Buffer.from(sealed); idx[body.length - 20] ^= 1; out.indexChanged = idx;
  const m = JSON.parse(manifestJSON);
  out.metaEdited = Buffer.concat([body, node.manifestBox({ ...m, meta: { ...m.meta, device: 'someone else' } })]);
  out.truncated = sealed.subarray(0, sealed.length - 7);
  out.garbage = Buffer.from('not a video at all');
  const s = new node.CaptureSession({ signer: node.softwareSigner(), startMs: 1 });
  const parts = node.splitFile(sample);
  s.init(parts.init);
  parts.fragments.slice(0, 12).forEach((f, i) => { s.addFragment(f); if (i === 9) s.checkpoint(11); });
  out.crashed = Buffer.concat([parts.init, ...parts.fragments.slice(0, 12), node.manifestBox(s.unsealed())]);
  return out;
}

for (const [name, file] of Object.entries(cases())) {
  test(`same result as the Node verifier: ${name}`, async () => {
    const a = node.verifyCapture(file);
    const b = await verifyCapture(new Uint8Array(file));
    assert.equal(b.status, a.status);
    assert.equal(b.alteredAt ?? null, a.alteredAt ?? null);
    assert.equal(b.verifiedFragments ?? null, a.verifiedFragments ?? null);
    assert.equal(b.fragments ?? null, a.fragments ?? null);
  });
}

test('a separate manifest file works', async () => {
  const { body, manifestJSON } = node.splitFile(sealed);
  const r = await verifyCapture(new Uint8Array(body), { manifest: JSON.parse(manifestJSON) });
  assert.equal(r.status, 'sealed');
  assert.deepEqual(r.checks, { format: true, signer: true, seal: true, fragments: true, wholeFile: true });
});
