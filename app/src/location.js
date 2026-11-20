// Copied from Testimonia web/location.mjs (removeLocation and confirm prompt left out). Keep in step.
export function hasLocation(bytes, type = '') {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const isJpeg = b[0] === 0xff && b[1] === 0xd8;
  if (isJpeg) {
    // A GPS directory with entries in it: removing the location would change something.
    const stripped = stripJpegGps(b);
    for (let i = 0; i < b.length; i++) if (stripped[i] !== b[i]) return true;
    return false;
  }
  if (/^video\//.test(type) || String.fromCharCode(...b.subarray(4, 8)) === 'ftyp') return videoLocations(b).length > 0;
  return false;
}
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function stripJpegGps(src) {
  const b = src.slice();
  for (let i = 2; i + 4 < b.length && b[i] === 0xff; ) {
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(i + 4, i + 10)) === 'Exif\0\0') {
      const t = i + 10; // the TIFF header
      const le = b[t] === 0x49; // "II": little-endian
      const u16 = (o) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
      const u32 = (o) => (le ? (b[t + o] | (b[t + o + 1] << 8) | (b[t + o + 2] << 16)) + b[t + o + 3] * 2 ** 24 : b[t + o] * 2 ** 24 + ((b[t + o + 1] << 16) | (b[t + o + 2] << 8) | b[t + o + 3]));
      const end = i + 2 + len - t;
      const ifd0 = u32(4);
      if (ifd0 + 2 > end) return b;
      for (let e = 0, n = u16(ifd0); e < n; e++) {
        const at = ifd0 + 2 + e * 12;
        if (u16(at) !== 0x8825) continue;
        const gps = u32(at + 8);
        if (gps + 2 > end) return b;
        const count = u16(gps);
        for (let g = 0; g < count; g++) {
          const ent = gps + 2 + g * 12;
          const size = (TYPE_SIZE[u16(ent + 2)] || 1) * u32(ent + 4);
          if (size > 4) {
            const off = u32(ent + 8);
            if (off + size <= end) b.fill(0, t + off, t + off + size);
          }
          b.fill(0, t + ent, t + ent + 12);
        }
        b[t + gps] = 0; // no entries left in the GPS directory
        b[t + gps + 1] = 0;
      }
      return b;
    }
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return b;
}

// ISO 6709 positions as QuickTime and MP4 keep them ("©xyz", "com.apple.quicktime.location.ISO6709").
const ISO6709 = /[+-]\d{2}(?:\.\d+)?[+-]\d{3}(?:\.\d+)?(?:[+-]\d+(?:\.\d+)?)?(?:CRS[A-Za-z0-9_:]*)?\//g;
function* boxes(b, from, to) {
  for (let o = from; o + 8 <= to; ) {
    let size = ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
    const type = String.fromCharCode(...b.subarray(o + 4, o + 8));
    if (size === 1) size = Number(new DataView(b.buffer, b.byteOffset + o + 8, 8).getBigUint64(0));
    if (size === 0) size = to - o;
    if (size < 8) return;
    yield { type, start: o, end: Math.min(to, o + size) };
    o += size;
  }
}
function videoLocations(b) {
  const found = [];
  for (const box of boxes(b, 0, b.length)) {
    if (box.type !== 'moov') continue; // metadata lives here; the video data is left alone
    let text = '';
    for (let k = box.start; k < box.end; k += 65536) text += String.fromCharCode(...b.subarray(k, Math.min(box.end, k + 65536)));
    for (const m of text.matchAll(ISO6709)) found.push([box.start + m.index, m[0].length]);
  }
  return found;
}

