// Anchoring relayer: phones send their seals here; every few minutes the relayer posts one
// Merkle root for all of them to AnchorRegistry and keeps each recording's proof.
//
//   POST /seals            body: the recording's manifest JSON   -> { sealDigest }
//   GET  /proofs/<digest>  -> the anchor proof, or 404 while it waits for the next batch
//   GET  /health           -> { pending, anchored }
//
// Run: RPC_URL=... RELAYER_KEY=... DEPLOYMENT=deployments/base-sepolia.json node services/anchor-relayer.js
'use strict';

const http = require('http');
const fs = require('fs');
const { ethers } = require('ethers');
const { AnchorBatcher } = require('../src/anchor');

const MAX_BODY = 512 * 1024; // a manifest for an hour of video is well under this

function createServer({ batcher, intervalMs = 120_000, log = () => {} }) {
  const flush = async () => {
    try {
      const root = await batcher.flush();
      if (root) log(`anchored ${root}`);
    } catch (e) {
      log(`anchor failed: ${e.shortMessage || e.message}`);
    }
  };
  const timer = intervalMs > 0 ? setInterval(flush, intervalMs) : null;

  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST' });
        return res.end();
      }
      if (req.method === 'POST' && req.url === '/seals') {
        let size = 0;
        const chunks = [];
        for await (const c of req) {
          size += c.length;
          if (size > MAX_BODY) return send(res, 413, { error: 'manifest too large' });
          chunks.push(c);
        }
        let manifest;
        try {
          manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(res, 400, { error: 'body is not JSON' });
        }
        try {
          return send(res, 202, { sealDigest: await batcher.add(manifest) });
        } catch (e) {
          return send(res, 422, { error: e.message });
        }
      }
      const m = req.method === 'GET' && req.url.match(/^\/proofs\/(0x[0-9a-f]{64})$/i);
      if (m) {
        const proof = batcher.proofFor(m[1].toLowerCase());
        return proof ? send(res, 200, proof) : send(res, 404, { error: 'not anchored yet' });
      }
      if (req.method === 'GET' && req.url === '/health') {
        return send(res, 200, { pending: batcher.pending.size, anchored: batcher.proofs.size });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: 'internal error' });
      log(e.stack);
    }
  });
  server.on('close', () => timer && clearInterval(timer));
  return { server, flush };
}

module.exports = { createServer };

if (require.main === module) {
  const { RPC_URL, RELAYER_KEY, DEPLOYMENT = 'deployments/base-sepolia.json', PORT = 8790, ANCHOR_EVERY_SECONDS = 120 } = process.env;
  if (!RPC_URL || !RELAYER_KEY) throw new Error('set RPC_URL and RELAYER_KEY');
  const addresses = JSON.parse(fs.readFileSync(DEPLOYMENT, 'utf8'));
  const signer = new ethers.Wallet(RELAYER_KEY, new ethers.JsonRpcProvider(RPC_URL));
  const batcher = new AnchorBatcher({ addresses, signer });
  const { server } = createServer({ batcher, intervalMs: Number(ANCHOR_EVERY_SECONDS) * 1000, log: console.log });
  server.listen(Number(PORT), () => console.log(`anchor relayer on :${PORT}, anchoring every ${ANCHOR_EVERY_SECONDS}s from ${signer.address}`));
}
