// app/src/look.js: a photo's look survives being shrunk and re-compressed (simulated here by
// resizing and adding noise), and doesn't match a different, edited or cropped picture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookOf, sameLook } from '../app/src/look.js';

/** RGBA pixels of a scene: a sky gradient, a hill, a red box (moved: elsewhere), dark specks. */
function scene(w, h, { moved = false, noise = 0, seed = 1 } = {}) {
  const px = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5) * 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = [100 + (y * 120) / h, 160 + (y * 60) / h, 230 - (y * 80) / h];
    if (y > h * (0.62 - 0.15 * Math.sin((x / w) * 3))) c = [47, 93, 58];
    const bx = moved ? 0.62 : 0.25;
    if (x > w * bx && x < w * (bx + 0.18) && y > h * 0.42 && y < h * 0.71) c = [192, 57, 43];
    if (((Math.floor((x / w) * 480) * 7 + Math.floor((y / h) * 360) * 13) % 97) < 3) c = c.map((v) => v * 0.6);
    px.set([...c.map((v) => v + noise * rnd()), 255], 4 * (y * w + x));
  }
  return px;
}

test('a smaller, noisier copy looks the same; an edit, a crop or another picture doesn’t', () => {
  const original = lookOf(scene(480, 360), 480, 360);
  assert.match(original.bits, /^[0-9a-f]{120}$/);
  assert.equal(sameLook(original, lookOf(scene(240, 180, { noise: 6 }), 240, 180)).match, true);
  assert.equal(sameLook(original, lookOf(scene(480, 360, { moved: true }), 480, 360)).match, false);
  assert.match(sameLook(original, lookOf(scene(360, 360), 360, 360)).reason, /shape/);
  // Another picture of the same size: a different scene.
  const other = new Uint8ClampedArray(480 * 360 * 4);
  for (let i = 0; i < 480 * 360; i++) other.set([(i * 37) % 256, (i * 11) % 256, ((i / 480) | 0) % 256, 255], 4 * i);
  assert.equal(sameLook(original, lookOf(other, 480, 360)).match, false);
});

test('a plain picture, or a malformed fingerprint, never matches', () => {
  const flat = new Uint8ClampedArray(64 * 64 * 4).fill(128);
  const plain = lookOf(flat, 64, 64);
  assert.match(sameLook(plain, plain).reason, /too plain/);
  const ok = lookOf(scene(480, 360), 480, 360);
  assert.equal(sameLook({ ...ok, aspect: undefined }, ok).match, false);
  assert.equal(sameLook({ ...ok, bits: 'zz' }, ok).match, false);
});
