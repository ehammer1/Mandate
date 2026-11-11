// Downloads: spreadsheets open cleanly and can't smuggle formulas into Excel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, DATASETS } from '../app/src/downloads.js';

test('CSV quotes commas, quotes and line breaks, and neutralises formulas', () => {
  const csv = toCsv([{ id: 1, title: 'Fix "Main", now', note: 'line\nbreak', f: '=HYPERLINK("x")', n: -5, at: '@me' }]);
  assert.equal(csv, 'id,title,note,f,n,at\r\n1,"Fix ""Main"", now","line\nbreak","\'=HYPERLINK(""x"")",-5,\'@me\r\n');
  assert.equal(toCsv([]), '');
});

test('every list says what it holds', () => {
  for (const d of Object.values(DATASETS)) assert.ok(d.label && d.what && typeof d.load === 'function');
});
