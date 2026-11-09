/**
 * app/src/backup-code.mjs - written backup codes for voter keys.
 *
 * MV2 (current): "MV2-" + Crockford base32 of the 32-byte secret, plus a 4-character
 * check, in groups of 4. Only digits and unambiguous capitals (no I, L, O, U), not
 * case-sensitive, and O/I/L typed by mistake are read as 0/1/1. A typo fails the check
 * instead of silently restoring a different voter.
 *
 * MV1 (legacy): "MV1-" + base64url in groups of 6 joined with "-". base64url itself can
 * contain "-", so MV1 codes are decoded by position (every 7th character is a separator),
 * never by stripping all dashes.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function toBase32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text, byteLength) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v === -1) throw new Error('bad character');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  if (out.length < byteLength) throw new Error('too short');
  return Uint8Array.from(out.slice(0, byteLength));
}

/** 20-bit check over the secret (position-weighted, so swapped characters are caught too). */
function check(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i] * (i + 7)) % 65521;
    b = (b + a) % 65521;
  }
  const v = (b * 31 + a) % (1 << 20);
  return ALPHABET[(v >> 15) & 31] + ALPHABET[(v >> 10) & 31] + ALPHABET[(v >> 5) & 31] + ALPHABET[v & 31];
}

export function encodeBackupCode(secret) {
  const body = toBase32(secret) + check(secret);
  return 'MV2-' + body.match(/.{1,4}/g).join('-');
}

const b64urlDecode = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/**
 * @returns {Uint8Array} the 32-byte secret
 * @throws Error with a message fit to show the person
 */
export function decodeBackupCode(code) {
  const text = String(code || '').trim();
  if (/^MV1-/i.test(text)) {
    const body = text.slice(4).replace(/\s+/g, '');
    // Remove only the grouping separators: positions 6, 13, 20, ... of the body.
    const raw = [...body].filter((_c, i) => i % 7 !== 6).join('');
    let secret;
    try {
      secret = b64urlDecode(raw);
    } catch {
      throw new Error('That backup code is not valid. Please check it and try again.');
    }
    if (secret.length !== 32) throw new Error('That backup code is not valid. Please check it and try again.');
    return secret;
  }
  const body = text.replace(/^MV2-?/i, '').replace(/[\s-]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
  if (body.length !== 56) throw new Error('That backup code is the wrong length. Please check it and try again.');
  let secret;
  try {
    secret = fromBase32(body.slice(0, 52), 32);
  } catch {
    throw new Error('That backup code has a character that isn\'t used in codes. Please check it and try again.');
  }
  if (check(secret) !== body.slice(52)) throw new Error('That backup code has a typo somewhere. Please check it and try again.');
  return secret;
}
