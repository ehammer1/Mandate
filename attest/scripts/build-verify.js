// Builds verify/index.html (one self-contained page) and its two example videos.
// node scripts/build-verify.js
'use strict';
const fs = require('fs');
const path = require('path');
const capture = require('../src/capture');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'verify');
let page = fs.readFileSync(path.join(dir, 'page.src.html'), 'utf8');

// The verifier module, inlined (a module script can't import from another origin).
const mod = fs.readFileSync(path.join(root, 'src', 'capture-web.mjs'), 'utf8').replace(/^export /gm, '');
page = page.replace('/*CAPTURE_WEB*/', () => mod);

// The lockup, themed through CSS: navy follows the text colour, white halos follow the page.
let lockup = fs.readFileSync(path.join(root, 'brand', 'final', 'testimonia-lockup.svg'), 'utf8')
  .replace(/<title>[^<]*<\/title>/, '<title>Testimonia</title>')
  .replace(/#262a6e/g, 'currentColor')
  .replace(/stroke="#ffffff"/g, 'style="stroke:var(--surface)"')
  .replace('<svg ', '<svg class="lockup" role="img" aria-label="Testimonia" ');
page = page.replace('<!--LOCKUP-->', () => lockup.trim());
fs.writeFileSync(path.join(dir, 'index.html'), page);

// Examples: the sealed test recording, and a copy with one byte changed in second 7.
const sealed = fs.readFileSync(path.join(root, 'capture', 'vectors', 'sealed.mp4'));
fs.mkdirSync(path.join(dir, 'samples'), { recursive: true });
fs.writeFileSync(path.join(dir, 'samples', 'sealed.mp4'), sealed);
const { init, fragments } = capture.splitFile(sealed);
const edited = Buffer.from(sealed);
edited[init.length + fragments.slice(0, 7).reduce((a, f) => a + f.length, 0) + 300] ^= 0xff;
fs.writeFileSync(path.join(dir, 'samples', 'edited.mp4'), edited);
console.log(`verify/index.html ${(page.length / 1024).toFixed(0)} KB; samples: sealed, edited`);
