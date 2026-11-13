#!/usr/bin/env node
/**
 * scripts/serve-app.js - serve the voter web app locally.
 *
 *   node scripts/build-app.js && node scripts/serve-app.js      # http://localhost:8080
 *
 * Serves app/ plus the Semaphore proving files at /artifacts/ (so kiosks and
 * offline demos need no download). Open it at http://localhost, not 127.0.0.1:
 * passkeys need a domain name. Production should serve app/ over HTTPS from any
 * static host.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const ARTIFACTS = path.dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json', { paths: [ROOT] }));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.zkey': 'application/octet-stream', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

/**
 * @param {{ config?: object, ipfs?: Record<string, string | { type: string, body: Buffer }> }} [opts]
 *   config: served as /config.json instead of app/config.json
 *   communities: slug -> config, served as /communities/<slug>.json (tests)
 *   ipfs:   cid -> content, served at /ipfs/<cid> (local demos and tests)
 */
function createAppServer(opts = {}) {
  return http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const community = /^\/communities\/([a-z0-9-]+)\.json$/.exec(url);
    if (community && opts.communities && opts.communities[community[1]]) {
      res.writeHead(200, { 'Content-Type': TYPES['.json'] });
      return res.end(JSON.stringify(opts.communities[community[1]]));
    }
    if (url === '/config.json' && opts.config) {
      res.writeHead(200, { 'Content-Type': TYPES['.json'] });
      return res.end(JSON.stringify(opts.config));
    }
    if (url.startsWith('/ipfs/') && opts.ipfs) {
      const entry = opts.ipfs[url.slice(6)];
      const file = entry && typeof entry === 'object' && entry.body ? entry : null; // { type, body } for photos and PDFs
      res.writeHead(entry ? 200 : 404, { 'Content-Type': file ? file.type : 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(file ? file.body : entry || '{}');
    }
    let base = APP;
    let rel = url === '/' ? 'index.html' : url.slice(1);
    if (url.startsWith('/artifacts/')) {
      base = ARTIFACTS;
      rel = url.slice('/artifacts/'.length);
    }
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base)) {
      res.writeHead(403);
      return res.end();
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size });
      fs.createReadStream(file).pipe(res);
    });
  });
}

module.exports = { createAppServer };

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  createAppServer().listen(port, () => console.log(`voter app on http://localhost:${port}`));
}
