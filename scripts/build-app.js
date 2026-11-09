// Bundles the voter web app (app/src) into app/dist/app.js for browsers.
'use strict';
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
esbuild
  .build({
    entryPoints: [path.join(root, 'app', 'src', 'main.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    sourcemap: true,
    outfile: path.join(root, 'app', 'dist', 'app.js'),
    define: { 'process.env.NODE_DEBUG': 'false', global: 'globalThis' },
    logLevel: 'warning',
  })
  .then((r) => console.log(`built app/dist/app.js${r.warnings.length ? ` (${r.warnings.length} warnings)` : ''}`))
  .catch(() => process.exit(1));
