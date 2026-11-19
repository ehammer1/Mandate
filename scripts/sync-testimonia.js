#!/usr/bin/env node
// Copies Testimonia's checking code (seals, photo and edit records, timelines on Base) into
// vendor/testimonia/, so verifier nodes can check Testimonia media in mandate evidence
// without installing Testimonia. Testimonia is its own repository; this is a pinned copy.
//
//   TESTIMONIA_DIR=../testimonia node scripts/sync-testimonia.js
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const from = path.resolve(process.env.TESTIMONIA_DIR || path.join(__dirname, '..', '..', 'testimonia'));
const to = path.join(__dirname, '..', 'vendor', 'testimonia');
const FILES = ['capture.js', 'anchor.js', 'derive.js', 'register.js', 'timeline.js'];

if (!fs.existsSync(path.join(from, 'src', 'timeline.js'))) {
  console.error(`no Testimonia checkout at ${from} (set TESTIMONIA_DIR)`);
  process.exit(1);
}
fs.mkdirSync(to, { recursive: true });
for (const f of FILES) {
  const text = fs.readFileSync(path.join(from, 'src', f), 'utf8');
  fs.writeFileSync(path.join(to, f), `// Copied from Testimonia src/${f} by scripts/sync-testimonia.js. Do not edit here.\n${text}`);
}
let commit = 'unknown';
try { commit = execFileSync('git', ['-C', from, 'rev-parse', 'HEAD']).toString().trim(); } catch {}
fs.writeFileSync(path.join(to, 'VERSION'), `testimonia ${commit}\n${FILES.join('\n')}\n`);
console.log(`vendor/testimonia <- ${from} @ ${commit.slice(0, 7)} (${FILES.length} files)`);
