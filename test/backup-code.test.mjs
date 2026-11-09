// Written backup codes: round trips, typo detection, and legacy MV1 codes containing "-".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encodeBackupCode, decodeBackupCode } from '../app/src/backup-code.mjs';

const legacyMv1 = (secret) => 'MV1-' + Buffer.from(secret).toString('base64url').match(/.{1,6}/g).join('-');

test('MV2 round-trips for many random secrets, case- and spacing-insensitive', () => {
  for (let i = 0; i < 2000; i++) {
    const secret = randomBytes(32);
    const code = encodeBackupCode(secret);
    assert.match(code, /^MV2(-[0-9A-HJKMNP-TV-Z]{4}){14}$/);
    assert.deepEqual(Buffer.from(decodeBackupCode(code)), secret);
    assert.deepEqual(Buffer.from(decodeBackupCode(code.toLowerCase().replace(/-/g, ' '))), secret);
  }
});

test('MV2 reads O/I/L as 0/1/1 and catches typos', () => {
  const secret = randomBytes(32);
  const code = encodeBackupCode(secret);
  const sloppy = code.replace(/0/g, 'o').replace(/1/g, 'l');
  assert.deepEqual(Buffer.from(decodeBackupCode(sloppy)), secret);
  let caught = 0;
  for (let i = 0; i < 300; i++) {
    const chars = [...code.slice(4).replace(/-/g, '')];
    const pos = i % chars.length;
    chars[pos] = chars[pos] === 'A' ? 'B' : 'A';
    try {
      decodeBackupCode('MV2-' + chars.join(''));
    } catch {
      caught++;
    }
  }
  assert.ok(caught >= 295, `caught ${caught}/300 single-character typos`);
  assert.throws(() => decodeBackupCode('MV2-1234'), /wrong length/);
});

test('legacy MV1 codes restore even when the secret itself contains "-" or "_"', () => {
  let withDash = 0;
  for (let i = 0; i < 2000; i++) {
    const secret = randomBytes(32);
    const code = legacyMv1(secret);
    if (/[-_]/.test(Buffer.from(secret).toString('base64url'))) withDash++;
    assert.deepEqual(Buffer.from(decodeBackupCode(code)), secret);
  }
  assert.ok(withDash > 500); // the case that used to fail is well covered
});
