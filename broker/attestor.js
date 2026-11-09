#!/usr/bin/env node
/**
 * interact.js - Web3 gateway broker (oracle runtime).
 *
 * Watches a DeclassificationEscrow for DocumentSubmitted events and, for each one:
 *   1. checks the CID is still the contract's pendingHash (skips stale/replayed events),
 *   2. fetches the document from an IPFS gateway,
 *   3. runs it through `app.py --mode verify` (layout + safety re-check),
 *   4. calls verifyCompliance() if it passes, or rejectSubmission(reason) if it fails.
 *
 * Events are read with block-range queries from a persisted cursor rather than an
 * RPC filter subscription, so the broker survives restarts, RPC failovers and dropped
 * filters without missing or double-processing an event.
 *
 * Environment:
 *   RPC_URL               JSON-RPC endpoint (required)
 *   ORACLE_PRIVATE_KEY    key of the address set via setOracle() (required)
 *   ESCROW_ADDRESS        DeclassificationEscrow address (required)
 *   START_BLOCK           first block to scan on a fresh cursor (default: deployment-ish = latest - 5000)
 *   CONFIRMATIONS         blocks to wait before acting on an event (default 3)
 *   POLL_INTERVAL_MS      default 15000
 *   IPFS_GATEWAY          default https://gateway.pinata.cloud
 *   IPFS_MAX_BYTES        default 52428800 (50 MiB)
 *   PYTHON_BIN            default python3
 *   ORACLE_TIMEOUT_MS     timeout for one app.py run (default 1800000)
 *   STATE_FILE            cursor file (default ./.broker-state.json)
 *   DRY_RUN=1             evaluate but never send transactions
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const { ethers } = require('ethers');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`[broker] missing required env var ${name}`);
    process.exit(2);
  }
  return v.trim();
}

const CFG = {
  rpcUrl: required('RPC_URL'),
  privateKey: required('ORACLE_PRIVATE_KEY'),
  escrow: required('ESCROW_ADDRESS'),
  startBlock: process.env.START_BLOCK ? Number(process.env.START_BLOCK) : null,
  confirmations: Number(process.env.CONFIRMATIONS || 3),
  pollMs: Number(process.env.POLL_INTERVAL_MS || 15_000),
  gateway: (process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud').replace(/\/+$/, ''),
  ipfsMaxBytes: Number(process.env.IPFS_MAX_BYTES || 50 * 1024 * 1024),
  python: process.env.PYTHON_BIN || 'python3',
  oracleTimeoutMs: Number(process.env.ORACLE_TIMEOUT_MS || 30 * 60 * 1000),
  stateFile: path.resolve(process.env.STATE_FILE || path.join(__dirname, '.broker-state.json')),
  dryRun: process.env.DRY_RUN === '1',
  maxBlockSpan: 2_000,
};

const APP_PY = path.join(__dirname, 'app.py');

const ESCROW_ABI = [
  'event DocumentSubmitted(string _ipfsHash)',
  'event ComplianceVerified(string ipfsHash, uint256 releasedAmount)',
  'event SubmissionRejected(string ipfsHash, string reason)',
  'function oracle() view returns (address)',
  'function complies() view returns (bool)',
  'function pendingHash() view returns (string)',
  'function deadline() view returns (uint256)',
  'function lockedBalance() view returns (uint256)',
  'function verifyCompliance()',
  'function rejectSubmission(string reason)',
  'error NotOracle()',
  'error AlreadyCompliant()',
  'error NoPendingSubmission()',
];

// CIDv0 (base58btc "Qm...") or CIDv1 base32 ("b...").
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString();
const log = (...a) => console.log(`${ts()} [broker]`, ...a);
const warn = (...a) => console.warn(`${ts()} [broker] WARN`, ...a);

/** Error that should be retried on the next poll rather than turned into a rejection. */
class TransientError extends Error {}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
  } catch {
    return { nextBlock: null, processed: {} };
  }
}

function saveState(state) {
  const tmp = `${CFG.stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, CFG.stateFile); // atomic replace
}

function describeError(contract, err) {
  if (err?.revert?.name) return `revert ${err.revert.name}`;
  try {
    const data = err?.data || err?.info?.error?.data;
    if (data) {
      const parsed = contract.interface.parseError(data);
      if (parsed) return `revert ${parsed.name}`;
    }
  } catch {
    /* fall through */
  }
  return err?.shortMessage || err?.message || String(err);
}

// ---------------------------------------------------------------------------
// IPFS
// ---------------------------------------------------------------------------

async function fetchFromIpfs(cid) {
  const url = `${CFG.gateway}/ipfs/${cid}`;
  let res;
  try {
    res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      maxContentLength: CFG.ipfsMaxBytes,
      validateStatus: (s) => s >= 200 && s < 300,
    });
  } catch (e) {
    const status = e.response?.status;
    // 4xx other than 408/429 means the content is not retrievable as a file: permanent.
    if (status && status < 500 && status !== 408 && status !== 429) {
      return { ok: false, reason: `IPFS gateway returned HTTP ${status}` };
    }
    if (e.message?.includes('maxContentLength')) {
      return { ok: false, reason: `document exceeds ${CFG.ipfsMaxBytes} bytes` };
    }
    throw new TransientError(`IPFS fetch failed: ${status || e.code || e.message}`);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(res.data);
    if (!text.trim()) return { ok: false, reason: 'document is empty' };
    return { ok: true, text };
  } catch {
    return { ok: false, reason: 'document is not valid UTF-8 text' };
  }
}

// ---------------------------------------------------------------------------
// Python oracle
// ---------------------------------------------------------------------------

function runOracle(text) {
  return new Promise((resolve, reject) => {
    const child = spawn(CFG.python, [APP_PY, '--mode', 'verify', '--json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new TransientError(`app.py timed out after ${CFG.oracleTimeoutMs}ms`));
    }, CFG.oracleTimeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new TransientError(`cannot start ${CFG.python}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (stderr.trim()) stderr.trim().split('\n').forEach((l) => log(`  app.py: ${l}`));
      // 0 = verified, 1 = failed verification (both print JSON); 2/3 = input/API errors.
      if (code === 0 || code === 1) {
        try {
          const parsed = JSON.parse(stdout);
          return resolve(parsed.verification);
        } catch {
          return reject(new TransientError('app.py produced unparseable JSON'));
        }
      }
      if (code === 2) return resolve({ verified: false, failures: ['document rejected as invalid input'] });
      reject(new TransientError(`app.py exited with code ${code}`));
    });

    child.stdin.on('error', () => {}); // child may exit early; close handler reports it
    child.stdin.end(text);
  });
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

async function sendTx(contract, method, args) {
  if (CFG.dryRun) {
    log(`DRY_RUN: would call ${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
    return;
  }
  try {
    await contract[method].staticCall(...args); // preflight: surface reverts before paying gas
  } catch (e) {
    const reason = describeError(contract, e);
    if (/AlreadyCompliant|NoPendingSubmission/.test(reason)) {
      log(`${method} no longer applicable (${reason}); skipping`);
      return;
    }
    throw new TransientError(`${method} preflight failed: ${reason}`);
  }
  const tx = await contract[method](...args);
  log(`${method} sent: ${tx.hash}`);
  const receipt = await tx.wait(CFG.confirmations);
  if (!receipt || receipt.status !== 1) throw new TransientError(`${method} tx ${tx.hash} failed`);
  log(`${method} confirmed in block ${receipt.blockNumber}`);
}

async function handleSubmission(contract, cid) {
  const [complies, pending] = await Promise.all([contract.complies(), contract.pendingHash()]);
  if (complies) {
    log(`escrow already compliant; ignoring ${cid}`);
    return;
  }
  if (pending !== cid) {
    log(`${cid} is no longer pending (pending="${pending}"); ignoring stale event`);
    return;
  }

  if (!CID_RE.test(cid)) {
    return sendTx(contract, 'rejectSubmission', ['malformed CID']);
  }

  log(`fetching ${cid} from ${CFG.gateway}`);
  const doc = await fetchFromIpfs(cid);
  if (!doc.ok) {
    log(`rejecting ${cid}: ${doc.reason}`);
    return sendTx(contract, 'rejectSubmission', [doc.reason]);
  }

  log(`running AI verification on ${doc.text.length} chars`);
  const v = await runOracle(doc.text);
  if (v.verified) {
    log(`${cid} VERIFIED (sha256=${v.input_sha256}); releasing budget`);
    return sendTx(contract, 'verifyCompliance', []);
  }
  const reason = (v.failures || ['verification failed']).join('; ').slice(0, 280);
  log(`${cid} FAILED: ${reason}`);
  return sendTx(contract, 'rejectSubmission', [reason]);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  const provider = new ethers.JsonRpcProvider(CFG.rpcUrl);
  const wallet = new ethers.Wallet(CFG.privateKey, provider);
  const contract = new ethers.Contract(CFG.escrow, ESCROW_ABI, wallet);

  const [network, onchainOracle] = await Promise.all([provider.getNetwork(), contract.oracle()]);
  log(`chain ${network.chainId}, escrow ${CFG.escrow}, oracle signer ${wallet.address}${CFG.dryRun ? ' (DRY_RUN)' : ''}`);
  if (onchainOracle.toLowerCase() !== wallet.address.toLowerCase()) {
    const msg = `signer is not the escrow oracle (on-chain oracle: ${onchainOracle})`;
    if (!CFG.dryRun) throw new Error(msg);
    warn(msg);
  }

  const state = loadState();
  if (state.nextBlock == null) {
    const head = await provider.getBlockNumber();
    state.nextBlock = CFG.startBlock ?? Math.max(0, head - 5_000);
    saveState(state);
  }

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    log('shutting down after current step (Ctrl-C again to force)');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const filter = contract.filters.DocumentSubmitted();
  let backoff = CFG.pollMs;

  while (!stopping) {
    try {
      const head = await provider.getBlockNumber();
      const safeHead = head - CFG.confirmations;
      while (!stopping && state.nextBlock <= safeHead) {
        const to = Math.min(state.nextBlock + CFG.maxBlockSpan - 1, safeHead);
        const events = await contract.queryFilter(filter, state.nextBlock, to);
        for (const ev of events) {
          const key = `${ev.transactionHash}:${ev.index}`;
          if (state.processed[key]) continue;
          const cid = ev.args?._ipfsHash ?? ev.args?.[0];
          log(`DocumentSubmitted ${cid} (block ${ev.blockNumber}, tx ${ev.transactionHash})`);
          await handleSubmission(contract, cid); // TransientError aborts; cursor not advanced
          state.processed[key] = ts();
          saveState(state);
        }
        state.nextBlock = to + 1;
        state.processed = {}; // keys are only needed within the current range
        saveState(state);
      }
      backoff = CFG.pollMs;
    } catch (e) {
      warn(`${e instanceof TransientError ? 'transient' : 'unexpected'} error: ${describeError(contract, e)}`);
      backoff = Math.min(backoff * 2, 5 * 60_000);
    }
    if (!stopping) await sleep(backoff);
  }
  log('stopped');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`${ts()} [broker] FATAL ${e.message}`);
    process.exit(1);
  });
}
