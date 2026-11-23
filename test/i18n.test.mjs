// Languages: each community offers its government's languages; extra languages are dictionary
// files, machine drafts are marked until a fluent speaker reviews them, and no translation may
// drop a {0} (a number, date or name would vanish from the sentence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { LANG_NAMES, closestLang } from '../app/src/i18n-names.js';
import ES from '../app/src/i18n-es.js';

const require = createRequire(import.meta.url);
const { keepGood, slots } = require('../scripts/translate-app.js');
const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'app', 'i18n');

test("a phone's language finds the closest one the app has", () => {
  const av = ['en', 'es', 'zh-Hans', 'zh-Hant', 'vi', 'tl'];
  assert.equal(closestLang('es-MX', av), 'es');
  assert.equal(closestLang('zh-TW', av), 'zh-Hant');
  assert.equal(closestLang('zh-HK', av), 'zh-Hant');
  assert.equal(closestLang('zh-CN', av), 'zh-Hans');
  assert.equal(closestLang('fil-PH', av), 'tl');
  assert.equal(closestLang('vi', av), 'vi');
  assert.equal(closestLang('ko-KR', av), null);
  assert.equal(closestLang('zh-TW', ['en', 'zh-Hans']), 'zh-Hans'); // the other script beats none
});

test('drafted translations that drop or add a {0} are left out (shown in English)', () => {
  const keys = ['Poll {0} closes {1}', 'Vote', 'In {0} days'];
  const { good, bad } = keepGood(keys, ['Bỏ phiếu {0} đóng {1}', 'Bỏ phiếu', 'Trong vài ngày']);
  assert.deepEqual(Object.keys(good), ['Poll {0} closes {1}', 'Vote']);
  assert.deepEqual(bad, ['In {0} days']);
  assert.equal(slots('{1} and {0}'), '{0},{1}');
});

test('every language file: known language, listed in the index, placeholders kept, reviewed status honest', () => {
  const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'index.json');
  assert.deepEqual(Object.keys(index).sort(), files.map((f) => f.replace(/\.json$/, '')).sort());
  for (const f of files) {
    const lang = f.replace(/\.json$/, '');
    const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    assert.ok(LANG_NAMES[lang], `${lang}: not a language the app knows`);
    assert.ok(['draft', 'reviewed'].includes(d.meta?.status), `${lang}: status must be draft or reviewed`);
    if (d.meta.status === 'reviewed') assert.ok(d.meta.reviewedBy, `${lang}: reviewed by whom?`);
    assert.equal(index[lang].status, d.meta.status);
    for (const [k, v] of Object.entries(d.entries || {})) {
      if (k.startsWith('__')) continue; // countdown words
      const forms = typeof v === 'object' ? Object.values(v) : [v];
      for (const x of forms) assert.equal(slots(x), slots(k), `${lang}: "${k}" loses or adds a placeholder`);
    }
  }
});

test('Spanish keeps every placeholder too', () => {
  const bad = Object.entries(ES).filter(([k, v]) => typeof v === 'string' && slots(v) !== slots(k)).map(([k]) => k);
  assert.deepEqual(bad.slice(0, 5), []);
});
