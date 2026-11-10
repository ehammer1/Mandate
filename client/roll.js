/**
 * client/roll.js - matching people to the official voter roll without keeping a readable
 * copy of it. Shared by the importer (scripts/roll-import.js) and the identity service.
 *
 * Each roll record and each person checked at a desk becomes a few "match variants"
 * (normalised text), and each variant a keyed fingerprint HMAC(ROLL_KEY, variant). The
 * published roll file holds only fingerprints -> registration numbers, so without the key
 * nobody can tell whose record is whose. Several variants tolerate the usual differences:
 *   v1  surname + first name + date of birth + ZIP          (moved house within the ZIP)
 *   v2  surname + date of birth + house number + ZIP        (nickname, initial, typo in first name)
 * and every part of a hyphenated or double surname counts on its own.
 */

'use strict';

const crypto = require('crypto');

const letters = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/** Surname spellings to try: the whole name and each of its parts ("Garcia-Lopez", "de la Cruz"). */
function surnames(last) {
  const parts = String(last || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z]+/).filter((p) => p.length >= 2);
  return [...new Set([letters(last), ...parts.filter((p) => !['de', 'la', 'del', 'van', 'von', 'der', 'da', 'di', 'le'].includes(p))])].filter(Boolean);
}

/** YYYY-MM-DD from YYYY-MM-DD, YYYY/MM/DD, MM/DD/YYYY or MM-DD-YYYY; '' if not a date. */
function dob(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return '';
}

const zip = (s) => (String(s || '').match(/\d{5}/) || [''])[0];
/** House number from a house-number field or a street line: "123B Main St" -> "123B". */
const house = (s) => (String(s || '').trim().toUpperCase().match(/^\d+[A-Z]?/) || [''])[0];

/**
 * @param {{ first: string, last: string, dob: string, house: string, zip: string }} p
 * @returns {string[]} match variants (empty if the details are too incomplete to match safely)
 */
function variants(p) {
  const f = letters(p.first);
  const d = dob(p.dob);
  const z = zip(p.zip);
  const h = house(p.house);
  if (!d || !z) return [];
  const out = [];
  for (const l of surnames(p.last)) {
    if (f) out.push(`v1|${l}|${f}|${d}|${z}`);
    if (h) out.push(`v2|${l}|${d}|${h}|${z}`);
  }
  return out;
}

const fingerprint = (key, variant) => crypto.createHmac('sha256', String(key)).update(variant).digest('hex').slice(0, 32);

/**
 * Look a person up in a roll file ({ entries: { fingerprint: registrationNumber | null } }).
 * @returns {{ matched: boolean, ambiguous?: boolean, registration?: string, matchedOn?: string }}
 */
function lookUp(roll, key, person) {
  const vs = variants(person);
  if (!vs.length) return { matched: false, incomplete: true };
  const found = new Set();
  let shared = false;
  let on = '';
  for (const v of vs) {
    const hit = roll.entries[fingerprint(key, v)];
    if (hit === undefined) continue;
    if (hit === null) {
      shared = true; // this combination fits more than one registration (e.g. twins at one address)
      continue;
    }
    found.add(hit);
    on ||= v.startsWith('v1') ? 'name, date of birth and ZIP' : 'surname, date of birth, house number and ZIP';
  }
  // Exactly one registration fits: a match, even if a looser combination was shared.
  if (found.size > 1 || (!found.size && shared)) return { matched: false, ambiguous: true };
  if (!found.size) return { matched: false };
  return { matched: true, registration: [...found][0], matchedOn: on };
}

module.exports = { variants, fingerprint, lookUp, normalize: { letters, surnames, dob, zip, house } };
