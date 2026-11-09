#!/usr/bin/env node
/**
 * broker/relayer.js - submits anonymous ballots so voters never need a wallet.
 *
 * A ballot is a zero-knowledge proof; the proof itself authorises the vote, so
 * whoever submits it (this relayer) learns nothing about who the voter is and
 * cannot change the choice without invalidating the proof. The relayer pays
 * gas from its own key. Run several independent relayers (city, library,
 * civic groups) so no single operator can censor ballots: if one refuses, the
 * voter's app retries another.
 *
 * Endpoints
 *   POST /ballot      { "pollId": "1", "ballot": { merkleTreeDepth, merkleTreeRoot,
 *                       nullifier, message, scope, points[8] } }  -> { txHash }
 *   GET  /poll/:id    poll summary for client apps (snapshot, options, tally, end)
 *   GET  /health
 *
 * Environment
 *   RPC_URL, RELAYER_PRIVATE_KEY, VOTE_ADDRESS   (required)
 *   PORT                  default 8787
 *   RATE_LIMIT_PER_MIN    per client IP, default 30
 *   CORS_ORIGIN           default * (ballots carry no secrets)
 *   CONFIRMATIONS         default 1
 *
 * Privacy: logs never include client IPs, and the relayer stores nothing.
 * Operators should still front it with a privacy-preserving proxy (or Tor)
 * because the network layer is outside what the proof protects.
 */

'use strict';

require('dotenv').config();

const http = require('http');
const { ethers } = require('ethers');

const VOTE_ABI = [
  'function castBallot(uint256 id, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) b)',
  'function getPoll(uint256 id) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 quorum, uint8 options, uint8 action, bool finalized, bool passed, address proposer, uint256 bond, string questionCID, bytes actionData))',
  'function tally(uint256 id) view returns (uint256[])',
  'function nullifierUsed(uint256 id, uint256 nullifier) view returns (bool)',
  'function scopeOf(uint256 id) view returns (uint256)',
  'error NotOpen()',
  'error WrongRoot()',
  'error WrongScope()',
  'error BadOption()',
  'error BadDepth()',
  'error NullifierUsed()',
  'error InvalidProof()',
  'error UnknownPoll()',
];

const MAX_BODY = 16 * 1024;

function createRelayer({ provider, signer, voteAddress, rateLimitPerMin = 30, corsOrigin = '*', confirmations = 1, log = console.log }) {
  const vote = new ethers.Contract(voteAddress, VOTE_ABI, signer);
  const hits = new Map(); // ip -> [timestamps]; in memory only, never logged
  const inFlight = new Set(); // pollId:nullifier being submitted
  let queue = Promise.resolve(); // serialise sends to keep nonces simple

  function limited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > rateLimitPerMin;
  }

  function send(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('body too large'), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  function parseBallot(body) {
    const b = body?.ballot;
    if (body?.pollId === undefined || !b || !Array.isArray(b.points) || b.points.length !== 8) {
      throw Object.assign(new Error('expected { pollId, ballot: { ..., points[8] } }'), { status: 400 });
    }
    try {
      return {
        pollId: BigInt(body.pollId),
        ballot: {
          merkleTreeDepth: BigInt(b.merkleTreeDepth),
          merkleTreeRoot: BigInt(b.merkleTreeRoot),
          nullifier: BigInt(b.nullifier),
          message: BigInt(b.message),
          scope: BigInt(b.scope),
          points: b.points.map((p) => BigInt(p)),
        },
      };
    } catch {
      throw Object.assign(new Error('ballot fields must be integers'), { status: 400 });
    }
  }

  function revertName(e) {
    if (e?.revert?.name) return e.revert.name;
    try {
      const data = e?.data || e?.info?.error?.data;
      return (data && vote.interface.parseError(data)?.name) || null;
    } catch {
      return null;
    }
  }

  async function handleBallot(req, res) {
    const { pollId, ballot } = parseBallot(await readJson(req));
    const key = `${pollId}:${ballot.nullifier}`;
    if (inFlight.has(key) || (await vote.nullifierUsed(pollId, ballot.nullifier))) {
      return send(res, 409, { error: 'NullifierUsed', message: 'a ballot from this voter is already recorded' });
    }
    // Validate fully (proof included) before spending gas.
    try {
      await vote.castBallot.staticCall(pollId, ballot);
    } catch (e) {
      const name = revertName(e);
      return send(res, name ? 422 : 502, { error: name || 'RPCError', message: name ? 'ballot rejected by contract' : 'chain unavailable' });
    }
    inFlight.add(key);
    try {
      const run = queue.then(async () => {
        const gas = await vote.castBallot.estimateGas(pollId, ballot);
        const tx = await vote.castBallot(pollId, ballot, { gasLimit: (gas * 12n) / 10n });
        return tx.wait(confirmations);
      });
      queue = run.catch(() => {}); // a failed send must not block the next one
      const receipt = await run;
      if (!receipt || receipt.status !== 1) throw new Error('transaction failed');
      log(`ballot recorded poll=${pollId} tx=${receipt.hash}`);
      send(res, 200, { txHash: receipt.hash });
    } catch (e) {
      const name = revertName(e);
      send(res, name ? 422 : 502, { error: name || 'SubmitFailed', message: e.shortMessage || e.message });
    } finally {
      inFlight.delete(key);
    }
  }

  async function handlePoll(res, idText) {
    let id;
    try {
      id = BigInt(idText);
    } catch {
      return send(res, 400, { error: 'bad poll id' });
    }
    try {
      const [p, counts, scope] = await Promise.all([vote.getPoll(id), vote.tally(id), vote.scopeOf(id)]);
      send(res, 200, {
        id, groupId: p.groupId, snapshotRoot: p.snapshotRoot, electorate: p.electorate, options: p.options,
        end: p.end, quorum: p.quorum, finalized: p.finalized, passed: p.passed, questionCID: p.questionCID, tally: counts, scope,
      });
    } catch (e) {
      send(res, revertName(e) === 'UnknownPoll' ? 404 : 502, { error: revertName(e) || 'RPCError' });
    }
  }

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return send(res, 204, {});
      const ip = req.socket.remoteAddress || 'unknown';
      if (limited(ip)) return send(res, 429, { error: 'rate limited' });
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
      const poll = req.method === 'GET' && req.url.match(/^\/poll\/(\d+)$/);
      if (poll) return await handlePoll(res, poll[1]);
      if (req.method === 'POST' && req.url === '/ballot') return await handleBallot(req, res);
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
      if (!e.status) log(`error: ${e.message}`);
    }
  });
}

module.exports = { createRelayer };

if (require.main === module) {
  // Values pasted into hosting dashboards often carry spaces, quotes or their own
  // "NAME=" label; clean those up, then fail loudly instead of crashing later.
  const need = (n) => {
    const v = String(process.env[n] || '').trim().replace(/^['"]|['"]$/g, '').replace(new RegExp(`^${n}\\s*=\\s*`), '').trim();
    if (!v) {
      console.error(`[relayer] missing env ${n}`);
      process.exit(2);
    }
    return v;
  };
  const voteAddress = need('VOTE_ADDRESS');
  if (!ethers.isAddress(voteAddress)) {
    console.error(`[relayer] VOTE_ADDRESS is not a valid address (got ${JSON.stringify(voteAddress.slice(0, 60))}). Expected 0x followed by 40 hex characters.`);
    process.exit(2);
  }
  let signer;
  const rpcUrl = need('RPC_URL');
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  try {
    signer = new ethers.Wallet(need('RELAYER_PRIVATE_KEY'), provider);
  } catch {
    console.error('[relayer] RELAYER_PRIVATE_KEY is not a valid private key (expected 0x followed by 64 hex characters).');
    process.exit(2);
  }
  console.log(`[relayer] paying fees from ${signer.address}`);
  const server = createRelayer({
    provider,
    signer,
    voteAddress: ethers.getAddress(voteAddress),
    rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN || 30),
    corsOrigin: process.env.CORS_ORIGIN || '*',
    confirmations: Number(process.env.CONFIRMATIONS || 1),
    log: (m) => console.log(`${new Date().toISOString()} [relayer] ${m}`),
  });
  const port = Number(process.env.PORT || 8787);
  server.listen(port, () => console.log(`[relayer] listening on :${port} for ${ethers.getAddress(voteAddress)}`));
}
