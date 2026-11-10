#!/usr/bin/env node
/**
 * scripts/roll-import.js - turn a voter-roll export into a roll file the identity service
 * can match against, holding only keyed fingerprints (no names, dates or addresses).
 *
 *   ROLL_KEY=<secret> node scripts/roll-import.js roll.csv --state OR --out roll.json
 *
 * The CSV needs a header row. Columns (names are matched loosely, override with --cols):
 *   registration number, first name, last name, date of birth, house number (or street
 *   address), ZIP. Example: --cols id=VOTER_ID,first=FIRST_NAME,last=LAST_NAME,dob=BIRTH_DATE,house=RES_ADDRESS,zip=ZIP_CODE
 *
 * The same ROLL_KEY must be set on the identity service. Keep the CSV off any server.
 * A fingerprint shared by two different registrations (e.g. twins at one address) is
 * stored as ambiguous, so the desk falls back to a manual check for them.
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { variants, fingerprint } = require('../client/roll');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const GUESS = {
  id: /^(voter_?id|registration|reg(_?no|_?num(ber)?)?|id)$/i,
  first: /^first(_?name)?$/i,
  last: /^(last|sur)(_?name)?$/i,
  dob: /^(dob|birth_?date|date_?of_?birth)$/i,
  house: /^(house(_?(no|num(ber)?))?|res(idence)?_?address|street(_?address)?|address)$/i,
  zip: /^(zip(_?code)?|postal(_?code)?)$/i,
};

function buildRoll(csvText, { key, state, cols = {} }) {
  if (!key || String(key).length < 32) throw new Error('ROLL_KEY must be at least 32 characters of random data');
  const [header, ...rows] = parseCsv(csvText);
  const idx = {};
  for (const f of Object.keys(GUESS)) {
    const want = cols[f];
    idx[f] = header.findIndex((h) => (want ? h.trim() === want : GUESS[f].test(h.trim().replace(/\s+/g, '_'))));
    if (idx[f] === -1) throw new Error(`no column for ${f} (header: ${header.join(', ')}); use --cols`);
  }
  const entries = {};
  let skipped = 0;
  for (const r of rows) {
    const reg = String(r[idx.id] || '').trim();
    const vs = variants({ first: r[idx.first], last: r[idx.last], dob: r[idx.dob], house: r[idx.house], zip: r[idx.zip] });
    if (!reg || !vs.length) {
      skipped++;
      continue;
    }
    for (const v of vs) {
      const fp = fingerprint(key, v);
      if (fp in entries && entries[fp] !== reg) entries[fp] = null; // two registrations look alike: ambiguous
      else entries[fp] = reg;
    }
  }
  const body = { version: 1, state: String(state || '').toUpperCase(), createdAt: new Date().toISOString(), records: rows.length - skipped, skipped, entries };
  body.digest = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return body;
}

module.exports = { buildRoll, parseCsv };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(`--${n}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const file = args[0];
  if (!file || !opt('state')) {
    console.error('usage: ROLL_KEY=... node scripts/roll-import.js roll.csv --state OR [--out roll.json] [--cols id=..,first=..,last=..,dob=..,house=..,zip=..]');
    process.exit(2);
  }
  const cols = Object.fromEntries((opt('cols') || '').split(',').filter(Boolean).map((kv) => kv.split('=')));
  const roll = buildRoll(fs.readFileSync(file, 'utf8'), { key: process.env.ROLL_KEY, state: opt('state'), cols });
  fs.writeFileSync(opt('out') || 'roll.json', JSON.stringify(roll) + '\n');
  console.log(`${roll.records} records (${roll.skipped} skipped), ${Object.keys(roll.entries).length} fingerprints, digest ${roll.digest}`);
}
