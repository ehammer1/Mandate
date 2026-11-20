/**
 * app/src/look.js - how a photo looks, as a short fingerprint, so a copy of an evidence photo
 * seen elsewhere (re-compressed or resized by a site or a messaging app) can be matched to the
 * one on the public record, even though its bytes differ.
 *
 * The fingerprint: the photo shrunk to a 16 x 16 grid of grey levels, then one bit for each
 * pair of neighbouring cells (left/right and above/below: 480 bits) saying which is lighter,
 * and a second set saying which of those differences are clear (at least 2 grey levels).
 * Re-compressing or resizing changes almost none of the clear bits; another photo, a crop or
 * a real change (something moved, added or removed) changes many. Smooth areas (sky, walls)
 * are left out of the comparison, since compression flips them at random.
 *
 * It is a visual match, not proof that two files are the same: small edits can slip under it.
 * The SHA-256 on the record is what proves a file is exactly the original.
 */

const N = 16;
const CLEAR = 2;

/** The fingerprint of RGBA pixels (`data`, `width`, `height`): { v, bits, sure, aspect }. */
export function lookOf(data, width, height) {
  const sum = new Float64Array(N * N);
  const cnt = new Float64Array(N * N);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(N - 1, Math.floor((y * N) / height));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(N - 1, Math.floor((x * N) / width));
      const i = 4 * (y * width + x);
      sum[gy * N + gx] += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      cnt[gy * N + gx] += 1;
    }
  }
  const grey = (r, c) => sum[r * N + c] / (cnt[r * N + c] || 1);
  const bits = [];
  const sure = [];
  const pair = (a, b) => {
    bits.push(a > b ? 1 : 0);
    sure.push(Math.abs(a - b) >= CLEAR ? 1 : 0);
  };
  for (let r = 0; r < N; r++) for (let c = 0; c + 1 < N; c++) pair(grey(r, c), grey(r, c + 1));
  for (let r = 0; r + 1 < N; r++) for (let c = 0; c < N; c++) pair(grey(r, c), grey(r + 1, c));
  const hex = (list) => {
    let s = '';
    for (let i = 0; i < list.length; i += 4) s += ((list[i] << 3) | (list[i + 1] << 2) | (list[i + 2] << 1) | list[i + 3]).toString(16);
    return s;
  };
  return { v: 1, bits: hex(bits), sure: hex(sure), aspect: Math.round((width / height) * 1000) / 1000 };
}

const unhex = (s) => [...s].flatMap((ch) => {
  const n = parseInt(ch, 16);
  return [(n >> 3) & 1, (n >> 2) & 1, (n >> 1) & 1, n & 1];
});
const okLook = (l) => l?.v === 1 && /^[0-9a-f]{120}$/.test(l.bits || '') && /^[0-9a-f]{120}$/.test(l.sure || '') && Number.isFinite(l.aspect) && l.aspect > 0.01 && l.aspect < 100;

/**
 * Does `copy` look like `original`? { match, reason }. A match needs the same shape (within
 * 3%), enough clear detail, and at most 8% of the original's clear bits differing.
 */
export function sameLook(original, copy) {
  if (!okLook(original) || !okLook(copy)) return { match: false, reason: 'no fingerprint to compare' };
  if (Math.abs(copy.aspect / original.aspect - 1) > 0.03) return { match: false, reason: 'its shape is different (cropped or stretched)' };
  const a = unhex(original.bits);
  const b = unhex(copy.bits);
  const s = unhex(original.sure);
  const clear = s.reduce((n, x) => n + x, 0);
  if (clear < 60) return { match: false, reason: 'the photo is too plain to recognise by its look' };
  let differ = 0;
  for (let i = 0; i < s.length; i++) if (s[i] && a[i] !== b[i]) differ++;
  return differ / clear <= 0.08 ? { match: true } : { match: false, reason: 'it looks different' };
}

/** The fingerprint of an image file (a Blob), drawn at most 512 pixels wide; null if it can't be read. */
export async function lookOfFile(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 512 / bmp.width);
    const w = Math.max(N, Math.round(bmp.width * k));
    const h = Math.max(N, Math.round(bmp.height * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, w, h);
    return { ...lookOf(g.getImageData(0, 0, w, h).data, w, h), aspect: Math.round((bmp.width / bmp.height) * 1000) / 1000 };
  } catch {
    return null;
  }
}
