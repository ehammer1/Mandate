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

const PROOF = 'tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points)';
const FEEDBACK_ABI = [
  `function comment(bytes32 topic, uint8 tier, string ref, ${PROOF} proof)`,
  `function rate(bytes32 topic, uint8 tier, uint8 score, ${PROOF} proof)`,
  `function sign(uint256 id, ${PROOF} proof)`,
  'function createPetition(uint8 tier, uint8 action, bytes actionData, string ref) returns (uint256)',
  'error BadRef()', 'error BadTier()', 'error BadScore()', 'error WrongScope()', 'error WrongMessage()', 'error NullifierUsed()',
  'error InvalidProof()', 'error UnknownPetition()', 'error AlreadyOpened()', 'error BindingNeedsIdChecked()',
];
const BUDGET_ABI = [
  'function allocate(uint256 id, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 scope, uint256[8] points, uint32[] votes) a)',
  'function nullifierUsed(uint256, uint256) view returns (bool)',
  'error NotOpen()', 'error WrongRoot()', 'error WrongScope()', 'error BadDepth()', 'error WrongLength()',
  'error OverBudget(uint256 cost, uint32 credits)', 'error NullifierUsed()', 'error InvalidProof()', 'error UnknownRound()',
];
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
  'error ChangesClosed()',
  'error OnlineClosed()',
  'error BadRanking()',
];

const MAX_BODY = 16 * 1024;

function createRelayer({ provider, signer, voteAddress, budgetAddress, feedbackAddress, noticeBoardAddress, talliesAddress, rateLimitPerMin = 30, corsOrigin = '*', confirmations = 1, log = console.log }) {
  const vote = new ethers.Contract(voteAddress, VOTE_ABI, signer);
  const budget = budgetAddress ? new ethers.Contract(budgetAddress, BUDGET_ABI, signer) : null;
  const feedback = feedbackAddress ? new ethers.Contract(feedbackAddress, FEEDBACK_ABI, signer) : null;
  const tallies = talliesAddress ? new ethers.Contract(talliesAddress, ['function checkIn(uint256 pollId, uint32 place, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof)', 'error NotOpen()', 'error AlreadyCheckedIn()', 'error BadProof()', 'error BadInput()'], signer) : null;
  const board = noticeBoardAddress ? new ethers.Contract(noticeBoardAddress, ['function post(string) returns (bytes32)', 'function read(bytes32) view returns (string)'], signer) : null;
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
    // A second ballot from the same voter changes their vote (the contract refuses the same
    // choice twice, and polls on contracts without vote-changing refuse it outright).
    if (inFlight.has(key)) {
      return send(res, 409, { error: 'NullifierUsed', message: 'a ballot from this voter is being recorded' });
    }
    // Validate fully (proof included) before spending gas.
    try {
      await vote.castBallot.staticCall(pollId, ballot);
    } catch (e) {
      const name = revertName(e);
      if (name === 'NullifierUsed') return send(res, 409, { error: name, message: 'this voter already cast this choice' });
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

  // POST /allocation { roundId, allocation: { ..., points[8], votes[] } }: civic-credit allocations.
  async function handleAllocation(req, res) {
    if (!budget) return send(res, 404, { error: 'no civic budget on this relayer' });
    const body = await readJson(req);
    const a = body?.allocation;
    let roundId;
    let alloc;
    try {
      if (!a || !Array.isArray(a.points) || a.points.length !== 8 || !Array.isArray(a.votes) || a.votes.length > 20) throw new Error();
      roundId = BigInt(body.roundId);
      alloc = {
        merkleTreeDepth: BigInt(a.merkleTreeDepth),
        merkleTreeRoot: BigInt(a.merkleTreeRoot),
        nullifier: BigInt(a.nullifier),
        scope: BigInt(a.scope),
        points: a.points.map((p) => BigInt(p)),
        votes: a.votes.map((v) => Number(v)),
      };
    } catch {
      return send(res, 400, { error: 'expected { roundId, allocation: { ..., points[8], votes[] } }' });
    }
    const key = `budget:${roundId}:${alloc.nullifier}`;
    if (inFlight.has(key) || (await budget.nullifierUsed(roundId, alloc.nullifier))) {
      return send(res, 409, { error: 'NullifierUsed', message: 'an allocation from this person is already recorded' });
    }
    const why = (e) => {
      try {
        return e?.revert?.name || budget.interface.parseError(e?.data || e?.info?.error?.data)?.name || null;
      } catch {
        return null;
      }
    };
    try {
      await budget.allocate.staticCall(roundId, alloc);
    } catch (e) {
      const name = why(e);
      return send(res, name ? 422 : 502, { error: name || 'RPCError', message: name ? 'allocation rejected by contract' : 'chain unavailable' });
    }
    inFlight.add(key);
    try {
      const run = queue.then(async () => {
        const gas = await budget.allocate.estimateGas(roundId, alloc);
        return (await budget.allocate(roundId, alloc, { gasLimit: (gas * 12n) / 10n })).wait(confirmations);
      });
      queue = run.catch(() => {});
      const receipt = await run;
      if (!receipt || receipt.status !== 1) throw new Error('transaction failed');
      log(`allocation recorded round=${roundId} tx=${receipt.hash}`);
      send(res, 200, { txHash: receipt.hash });
    } catch (e) {
      const name = why(e);
      send(res, name ? 422 : 502, { error: name || 'SubmitFailed', message: e.shortMessage || e.message });
    } finally {
      inFlight.delete(key);
    }
  }

  // POST /feedback { method: 'comment' | 'rate' | 'sign' | 'petition', args: [...], proof? }
  // Residents' comments, ratings, petition signatures (anonymous proofs) and new petitions.
  async function handleFeedback(req, res) {
    if (!feedback) return send(res, 404, { error: 'no feedback contract on this relayer' });
    const body = await readJson(req);
    const method = { comment: 'comment', rate: 'rate', sign: 'sign', petition: 'createPetition' }[body?.method];
    if (!method || !Array.isArray(body.args) || body.args.length > 4) return send(res, 400, { error: 'expected { method, args[], proof }' });
    let args;
    try {
      const p = body.proof;
      const proof = p && { merkleTreeDepth: BigInt(p.merkleTreeDepth), merkleTreeRoot: BigInt(p.merkleTreeRoot), nullifier: BigInt(p.nullifier), message: BigInt(p.message), scope: BigInt(p.scope), points: p.points.map((x) => BigInt(x)) };
      if (method !== 'createPetition' && (!proof || proof.points.length !== 8)) throw new Error();
      args = method === 'createPetition' ? body.args : [...body.args, proof];
    } catch {
      return send(res, 400, { error: 'bad proof' });
    }
    const why = (e) => {
      try {
        return e?.revert?.name || feedback.interface.parseError(e?.data || e?.info?.error?.data)?.name || null;
      } catch {
        return null;
      }
    };
    try {
      await feedback[method].staticCall(...args);
    } catch (e) {
      const name = why(e);
      return send(res, name ? (name === 'NullifierUsed' ? 409 : 422) : 502, { error: name || 'RPCError' });
    }
    try {
      const run = queue.then(async () => {
        const gas = await feedback[method].estimateGas(...args);
        return (await feedback[method](...args, { gasLimit: (gas * 13n) / 10n })).wait(confirmations);
      });
      queue = run.catch(() => {});
      const receipt = await run;
      log(`feedback ${body.method} recorded tx=${receipt.hash}`);
      send(res, 200, { txHash: receipt.hash });
    } catch (e) {
      const name = why(e);
      send(res, name ? 422 : 502, { error: name || 'SubmitFailed', message: e.shortMessage || e.message });
    }
  }

  // POST /checkin { pollId, place, proof }: check in at a polling place to vote on paper.
  async function handleCheckIn(req, res) {
    if (!tallies) return send(res, 404, { error: 'no tallies contract on this relayer' });
    const body = await readJson(req);
    let args;
    try {
      const p = body.proof;
      args = [BigInt(body.pollId), Number(body.place), { merkleTreeDepth: BigInt(p.merkleTreeDepth), merkleTreeRoot: BigInt(p.merkleTreeRoot), nullifier: BigInt(p.nullifier), message: BigInt(p.message), scope: BigInt(p.scope), points: p.points.map((x) => BigInt(x)) }];
      if (args[2].points.length !== 8 || !(args[1] >= 0)) throw new Error();
    } catch {
      return send(res, 400, { error: 'expected { pollId, place, proof }' });
    }
    const why = (e) => {
      try {
        return e?.revert?.name || tallies.interface.parseError(e?.data || e?.info?.error?.data)?.name || null;
      } catch {
        return null;
      }
    };
    try {
      await tallies.checkIn.staticCall(...args);
    } catch (e) {
      const name = why(e);
      return send(res, name ? (name === 'AlreadyCheckedIn' ? 409 : 422) : 502, { error: name || 'RPCError' });
    }
    try {
      const run = queue.then(async () => {
        const gas = await tallies.checkIn.estimateGas(...args);
        return (await tallies.checkIn(...args, { gasLimit: (gas * 13n) / 10n })).wait(confirmations);
      });
      queue = run.catch(() => {});
      const receipt = await run;
      log(`check-in recorded tx=${receipt.hash}`);
      send(res, 200, { txHash: receipt.hash, code: String(args[2].nullifier).slice(-6) });
    } catch (e) {
      const name = why(e);
      send(res, name ? 422 : 502, { error: name || 'SubmitFailed', message: e.shortMessage || e.message });
    }
  }

  // POST /notice { text }: publish a resident's text (a comment, a petition) on the notice
  // board, so speaking needs no wallet. Short texts only; returns its reference.
  async function handleNotice(req, res) {
    if (!board) return send(res, 404, { error: 'no notice board on this relayer' });
    const body = await readJson(req);
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!text || Buffer.byteLength(text) > 4000) return send(res, 400, { error: 'text must be 1 to 4000 bytes' });
    const id = ethers.keccak256(ethers.toUtf8Bytes(text));
    try {
      if (!(await board.read(id))) {
        const run = queue.then(async () => (await board.post(text)).wait(confirmations));
        queue = run.catch(() => {});
        await run;
      }
      send(res, 200, { ref: `nb:${id}` });
    } catch (e) {
      send(res, 502, { error: 'SubmitFailed', message: e.shortMessage || e.message });
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
      if (req.method === 'POST' && req.url === '/allocation') return await handleAllocation(req, res);
      if (req.method === 'POST' && req.url === '/feedback') return await handleFeedback(req, res);
      if (req.method === 'POST' && req.url === '/notice') return await handleNotice(req, res);
      if (req.method === 'POST' && req.url === '/checkin') return await handleCheckIn(req, res);
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
  const clean = (n) => String(process.env[n] || '').trim().replace(/^['"]|['"]$/g, '').replace(new RegExp(`^${n}\\s*=\\s*`), '').trim();
  const fail = (m) => {
    console.error(`[relayer] ${m}`);
    process.exit(2);
  };
  (async () => {
    // CONFIG_URL (the voter app's published config.json) is preferred: after a redeploy the
    // relayer picks up the new contract address by itself. VOTE_ADDRESS/RPC_URL also work.
    const configUrl = clean('CONFIG_URL');
    let voteAddress = clean('VOTE_ADDRESS');
    let budgetAddress = clean('BUDGET_ADDRESS');
    let feedbackAddress = clean('FEEDBACK_ADDRESS');
    let noticeBoardAddress = clean('NOTICE_BOARD_ADDRESS');
    let talliesAddress = clean('TALLIES_ADDRESS');
    let rpcUrl = clean('RPC_URL');
    const loadConfig = async () => (await fetch(`${configUrl}${configUrl.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' })).json();
    if (configUrl) {
      const cfg = await loadConfig();
      voteAddress = cfg.voteAddress;
      budgetAddress = budgetAddress || cfg.budgetAddress || '';
      feedbackAddress = feedbackAddress || cfg.feedbackAddress || '';
      noticeBoardAddress = noticeBoardAddress || cfg.noticeBoardAddress || '';
      talliesAddress = talliesAddress || cfg.talliesAddress || '';
      rpcUrl = rpcUrl || cfg.rpcUrl;
    }
    if (!rpcUrl) fail('missing RPC_URL (or CONFIG_URL)');
    if (!ethers.isAddress(voteAddress)) fail(`VOTE_ADDRESS is not a valid address (got ${JSON.stringify(String(voteAddress).slice(0, 60))}). Expected 0x followed by 40 hex characters.`);
    const key = clean('RELAYER_PRIVATE_KEY');
    if (!key) fail('missing RELAYER_PRIVATE_KEY');
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    let signer;
    try {
      signer = new ethers.Wallet(key, provider);
    } catch {
      fail('RELAYER_PRIVATE_KEY is not a valid private key (expected 0x followed by 64 hex characters).');
    }
    voteAddress = ethers.getAddress(voteAddress);
    console.log(`[relayer] paying fees from ${signer.address}`);
    const addr = (a) => (ethers.isAddress(a || '') ? ethers.getAddress(a) : undefined);
    const build = (vote, budget, fb, tal = talliesAddress, nb = noticeBoardAddress) =>
      createRelayer({
        provider,
        signer,
        voteAddress: vote,
        budgetAddress: addr(budget),
        feedbackAddress: addr(fb),
        noticeBoardAddress: addr(nb),
        talliesAddress: addr(tal),
        rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN || 30),
        corsOrigin: process.env.CORS_ORIGIN || '*',
        confirmations: Number(process.env.CONFIRMATIONS || 1),
        log: (m) => console.log(`${new Date().toISOString()} [relayer] ${m}`),
      });
    const { createRouter, syncCommunities, indexUrlFrom } = require('../services/lib/communities');
    const server = build(voteAddress, budgetAddress, feedbackAddress);
    // Other communities are served under /c/<slug>/, each with its own contracts.
    const router = createRouter(server.listeners('request')[0]);
    server.removeAllListeners('request');
    server.on('request', router);
    const indexUrl = indexUrlFrom(configUrl, clean('COMMUNITIES_URL'));
    if (indexUrl) {
      const sync = () =>
        syncCommunities(router, indexUrl, (c) => build(ethers.getAddress(c.voteAddress), addr(c.budgetAddress) || '', addr(c.feedbackAddress) || '', addr(c.talliesAddress) || '', addr(c.noticeBoardAddress) || '').listeners('request')[0], {
          log: (m) => console.log(`[relayer] ${m}`),
        }).catch((e) => console.log(`[relayer] community list unavailable: ${e.message}`));
      await sync();
      setInterval(sync, 5 * 60 * 1000).unref();
    }
    const port = Number(process.env.PORT || 8787);
    server.listen(port, () => console.log(`[relayer] listening on :${port} for ${voteAddress}`));

    if (configUrl) {
      // Follow the published contract addresses without restarting (a restart looks like a
      // crash to the host): swap in a relayer for the new addresses on the same server.
      setInterval(async () => {
        try {
          const cfg = await loadConfig();
          const v = ethers.isAddress(cfg.voteAddress) ? ethers.getAddress(cfg.voteAddress) : voteAddress;
          const b = ethers.isAddress(cfg.budgetAddress || '') ? ethers.getAddress(cfg.budgetAddress) : '';
          const f = addr(cfg.feedbackAddress) || '';
          const t = addr(cfg.talliesAddress) || '';
          const current = ethers.isAddress(budgetAddress || '') ? ethers.getAddress(budgetAddress) : '';
          if (v === voteAddress && b === current && f === (addr(feedbackAddress) || '') && t === (addr(talliesAddress) || '')) return;
          const next = build(v, b, f, t).listeners('request')[0];
          router.setDefault(next);
          console.log(`[relayer] now serving voting ${v}${b ? ` and civic budget ${b}` : ''}`);
          voteAddress = v;
          budgetAddress = b;
          feedbackAddress = f;
          talliesAddress = t;
        } catch {
          /* keep serving the current addresses */
        }
      }, 5 * 60 * 1000).unref();
    }
  })().catch((e) => fail(e.message));
}
