// Regenerates capture/vectors/: a real fragmented MP4 (via ffmpeg), a test key, the
// expected hashes and messages, and a sealed copy. Every implementation tests against
// these. Run: node capture/make-vectors.js  (only when the format changes)
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const c = require('../src/capture');

const dir = path.join(__dirname, 'vectors');
fs.mkdirSync(dir, { recursive: true });
const sample = path.join(dir, 'sample.mp4');

// 12 one-second fragments of a test pattern with a tone.
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15',
  '-f', 'lavfi', '-i', 'sine=frequency=440',
  '-t', '12', '-c:v', 'libx264', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '24k',
  '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1',
  '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000',
  sample,
]);

// TEST KEY ONLY. Published on purpose so every implementation can reproduce the vectors.
const keyFile = path.join(dir, 'test-key.pk8.b64');
if (!fs.existsSync(keyFile)) {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') + '\n');
}
const privateKey = crypto.createPrivateKey({ key: Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64'), format: 'der', type: 'pkcs8' });
const signer = c.softwareSigner(privateKey);

const buf = fs.readFileSync(sample);
const { init, fragments, body } = c.splitFile(buf);
const startMs = 1794979200000;
const meta = { app: 'attest-capture/0.1.0', platform: 'reference', device: 'test vectors', location: { commitment: null, mode: 'none' } };
const { file, manifest } = c.simulateCapture(buf, { signer, meta, startMs });
fs.writeFileSync(path.join(dir, 'sealed.mp4'), file);

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const heads = [c.chainStart(Buffer.from(manifest.initHash, 'hex'))];
manifest.fragments.forEach((f, i) => heads.push(c.chainNext(heads[i], Buffer.from(f.hash, 'hex'), null)));
const cp = manifest.checkpoints[0];
const metaJSON = c.canonicalJSON(manifest.meta);

const vectors = {
  note: 'Expected values for sample.mp4 sealed with test-key.pk8.b64. See FORMAT.md.',
  keyId: manifest.meta.keyId,
  publicKey: manifest.meta.publicKey,
  initLength: init.length,
  initHash: manifest.initHash,
  fragmentLengths: fragments.map((f) => f.length),
  fragmentHashes: manifest.fragments.map((f) => f.hash),
  heads: heads.map((h) => h.toString('hex')),
  bodyHash: sha(body),
  canonicalMeta: metaJSON,
  metaHash: sha(Buffer.from(metaJSON, 'utf8')),
  checkpointMessage: c.checkpointMessage(manifest.meta.keyId, cp.n, cp.head, cp.timeMs),
  sealMessage: c.sealMessage(manifest.meta.keyId, manifest.seal.n, manifest.seal.head, manifest.seal.fileHash, manifest.startMs, manifest.endMs, sha(Buffer.from(metaJSON, 'utf8'))),
  sealSignature: manifest.seal.sig,
};
fs.writeFileSync(path.join(dir, 'vectors.json'), JSON.stringify(vectors, null, 2) + '\n');
console.log(`${fragments.length} fragments, sealed.mp4 ${file.length} bytes, keyId ${vectors.keyId.slice(0, 16)}…`);
