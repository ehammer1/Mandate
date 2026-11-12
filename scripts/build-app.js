// Bundles the voter web app (app/src) into app/dist/app.js for browsers.
'use strict';
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
esbuild
  .build({
    entryPoints: [path.join(root, 'app', 'src', 'main.js'), path.join(root, 'app', 'src', 'dashboard.js'), path.join(root, 'app', 'src', 'notice.js'), path.join(root, 'app', 'src', 'proposal.js'), path.join(root, 'app', 'src', 'one-pager.js')],
    bundle: true,
    format: 'esm',
    splitting: true, // wallet libraries load only when someone opens "Use a wallet"
    chunkNames: 'chunks/[name]-[hash]',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    sourcemap: true,
    outdir: path.join(root, 'app', 'dist'),
    define: { 'process.env.NODE_DEBUG': 'false', global: 'globalThis' },
    logLevel: 'warning',
  })
  .then((r) => console.log(`built app/dist/${r.warnings.length ? ` (${r.warnings.length} warnings)` : ''}`))
  .catch(() => process.exit(1));
