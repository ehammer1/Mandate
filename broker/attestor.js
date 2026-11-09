#!/usr/bin/env node
/**
 * broker/attestor.js - AI verifier node for the MandateRegistry.
 *
 * Watches for EvidenceSubmitted events and, for each one:
 *   1. checks the mandate is still under review in that round and this verifier
 *      has not attested yet (skips stale or replayed events),
 *   2. fetches the mandate spec (JSON) and the evidence (text) from IPFS,
 *   3. runs oracle/review.py against the spec's success criteria, plus any extra
 *      checks the spec asks for (e.g. "redaction" -> oracle/redact.py --mode verify),
 *   4. pins a report of its reasoning to IPFS (if Pinata is configured), and
 *   5. calls attest(id, approve, reportCID).
 *
 * This node is ONE verifier. The registry only settles a review once
 * `threshold` independent verifiers agree, so run it alongside human auditors
 * or other verifier implementations, never as the sole verifier.
 *
 * Events are read by block range from a persisted cursor, so the node survives
 * restarts and RPC hiccups without missing or double-processing events.
 *
 * Environment:
 *   RPC_URL, VERIFIER_PRIVATE_KEY, REGISTRY_ADDRESS     (required)
 *   START_BLOCK            first block on a fresh cursor (default latest - 5000)
 *   CONFIRMATIONS          default 3
 *   POLL_INTERVAL_MS       default 15000
 *   IPFS_GATEWAY           default https://gateway.pinata.cloud
 *   IPFS_MAX_BYTES         default 52428800
 *   PYTHON_BIN             default python3
 *   ORACLE_TIMEOUT_MS      per check, default 1800000
 *   STATE_FILE             default ./.attestor-state.json
 *   LOG_BLOCK_SPAN         blocks per log query, default 200 (public RPC limit)
 *   DRY_RUN=1              evaluate but never send transactions
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const { ethers } = require('ethers');
const { pinJSON, hasPinataCredentials } = require('./upload');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function required(name, ...fallbacks) {
  for (const n of [name, ...fallbacks]) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  console.error(`[attestor] missing required env var ${name}`);
  process.exit(2);
}

const CFG = {
  rpcUrl: required('RPC_URL'),
  privateKey: required('VERIFIER_PRIVATE_KEY', 'ORACLE_PRIVATE_KEY'),
  registry: required('REGISTRY_ADDRESS'),
  startBlock: process.env.START_BLOCK ? Number(process.env.START_BLOCK) : null,
  confirmations: Number(process.env.CONFIRMATIONS || 3),
  pollMs: Number(process.env.POLL_INTERVAL_MS || 15_000),
  gateway: (process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud').replace(/\/+$/, ''),
  ipfsMaxBytes: Number(process.env.IPFS_MAX_BYTES || 50 * 1024 * 1024),
  python: process.env.PYTHON_BIN || 'python3',
  oracleTimeoutMs: Number(process.env.ORACLE_TIMEOUT_MS || 30 * 60 * 1000),
  stateFile: path.resolve(process.env.STATE_FILE || '.attestor-state.json'),
  dryRun: process.env.DRY_RUN === '1',
  maxBlockSpan: Number(process.env.LOG_BLOCK_SPAN || 200), // public RPCs cap log ranges (Base Sepolia: 200)
};

const ORACLE_DIR = path.join(__dirname, '..', 'oracle');
const STATUS_UNDER_REVIEW = 2n;

const REGISTRY_ABI = [
  'event EvidenceSubmitted(uint256 indexed id, uint32 indexed round, string evidenceCID)',
  'function VERIFIER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function hasAttested(uint256 id, uint32 round, address verifier) view returns (bool)',
  'function getMandate(uint256 id) view returns (tuple(address responsible, uint64 createdAt, uint64 deadline, uint64 settledAt, uint16 threshold, uint8 status, uint32 round, uint32 approvals, uint32 rejections, bytes32 category, string specCID, string evidenceCID))',
  'function attest(uint256 id, bool approve, string reasonCID)',
  'error WrongStatus(uint256 id, uint8 status)',
  'error AlreadyAttested()',
  'error ResponsibleCannotVerify()',
];

const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString();
const log = (...a) => console.log(`${ts()} [attestor]`, ...a);
const warn = (...a) => console.warn(`${ts()} [attestor] WARN`, ...a);

/** Retry on the next poll; never turned into a verdict against the submitter. */
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
  fs.renameSync(tmp, CFG.stateFile);
}

function describeError(contract, err) {
  if (err?.revert?.name) return `revert ${err.revert.name}`;
  try {
    const data = err?.data || err?.info?.error?.data;
    const parsed = data && contract.interface.parseError(data);
    if (parsed) return `revert ${parsed.name}`;
  } catch {
    /* fall through */
  }
  return err?.shortMessage || err?.message || String(err);
}

// ---------------------------------------------------------------------------
// IPFS
// ---------------------------------------------------------------------------

/** @returns {Promise<{ok: true, text: string} | {ok: false, reason: string}>} */
async function fetchText(cid) {
  if (!CID_RE.test(cid)) return { ok: false, reason: `malformed CID ${cid}` };
  let res;
  try {
    res = await axios.get(`${CFG.gateway}/ipfs/${cid}`, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      maxContentLength: CFG.ipfsMaxBytes,
    });
  } catch (e) {
    const status = e.response?.status;
    if (status && status < 500 && status !== 408 && status !== 429) return { ok: false, reason: `IPFS HTTP ${status}` };
    if (String(e.message).includes('maxContentLength')) return { ok: false, reason: `exceeds ${CFG.ipfsMaxBytes} bytes` };
    throw new TransientError(`IPFS fetch ${cid} failed: ${status || e.code || e.message}`);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(res.data);
    return text.trim() ? { ok: true, text } : { ok: false, reason: 'empty document' };
  } catch {
    return { ok: false, reason: 'not valid UTF-8 text' };
  }
}

// ---------------------------------------------------------------------------
// Python checks
// ---------------------------------------------------------------------------

/**
 * Run an oracle script. Exit 0/1 = verdict with JSON on stdout, 2 = bad input,
 * 3 = model/API failure (transient).
 */
function runPython(script, args, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(CFG.python, [path.join(ORACLE_DIR, script), ...args, '--json'], { env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new TransientError(`${script} timed out`));
    }, CFG.oracleTimeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new TransientError(`cannot start ${CFG.python}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      stderr.trim() && stderr.trim().split('\n').forEach((l) => log(`  ${script}: ${l}`));
      if (code === 0 || code === 1) {
        try {
          return resolve({ code, result: JSON.parse(stdout) });
        } catch {
          return reject(new TransientError(`${script} produced unparseable JSON`));
        }
      }
      if (code === 2) return resolve({ code, result: null });
      reject(new TransientError(`${script} exited with code ${code}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdinText);
  });
}

async function reviewEvidence(spec, evidenceText) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mandate-'));
  const specPath = path.join(tmp, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  try {
    const review = await runPython('review.py', ['--spec', specPath], evidenceText);
    const checks = {};
    if (review.code === 2) {
      return { approve: false, failures: ['evidence or spec rejected as invalid input'], review: null, checks };
    }
    const failures = [...(review.result.failures || [])];

    if ((spec.checks || []).includes('redaction')) {
      const r = await runPython('redact.py', ['--mode', 'verify'], evidenceText);
      checks.redaction = r.result?.verification ?? null;
      if (r.code !== 0) failures.push(...(checks.redaction?.failures || ['redaction check rejected the evidence']));
    }
    return { approve: review.result.approve && failures.length === 0, failures, review: review.result, checks };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

async function attest(contract, id, approve, reasonCID) {
  if (CFG.dryRun) {
    log(`DRY_RUN: would attest(${id}, ${approve}, "${reasonCID}")`);
    return;
  }
  let gas;
  try {
    gas = await contract.attest.estimateGas(id, approve, reasonCID);
  } catch (e) {
    const reason = describeError(contract, e);
    if (/WrongStatus|AlreadyAttested|ResponsibleCannotVerify/.test(reason)) {
      log(`attest(${id}) no longer applicable (${reason}); skipping`);
      return;
    }
    throw new TransientError(`attest preflight failed: ${reason}`);
  }
  // Estimation runs a block early; the settling attestation writes more state. Add headroom.
  const tx = await contract.attest(id, approve, reasonCID, { gasLimit: (gas * 13n) / 10n });
  log(`attest(${id}, ${approve}) sent: ${tx.hash}`);
  const receipt = await tx.wait(CFG.confirmations);
  if (!receipt || receipt.status !== 1) throw new TransientError(`attest tx ${tx.hash} failed`);
  log(`attest(${id}) confirmed in block ${receipt.blockNumber}`);
}

async function handleEvidence(contract, me, id, round, evidenceCID) {
  const [m, already] = await Promise.all([contract.getMandate(id), contract.hasAttested(id, round, me)]);
  if (m.status !== STATUS_UNDER_REVIEW || m.round !== round || m.evidenceCID !== evidenceCID) {
    log(`mandate ${id} round ${round} no longer under review; skipping`);
    return;
  }
  if (already) return log(`already attested mandate ${id} round ${round}; skipping`);

  const specDoc = await fetchText(m.specCID);
  let spec;
  try {
    if (!specDoc.ok) throw new Error(specDoc.reason);
    spec = JSON.parse(specDoc.text);
  } catch (e) {
    // A broken spec is a governance error, not the responsible party's fault: do not reject.
    warn(`mandate ${id}: cannot read spec ${m.specCID} (${e.message}); not attesting, needs operator attention`);
    return;
  }

  const evidence = await fetchText(evidenceCID);
  let outcome;
  if (!evidence.ok) {
    outcome = { approve: false, failures: [`evidence unavailable: ${evidence.reason}`], review: null, checks: {} };
  } else {
    log(`mandate ${id} round ${round}: reviewing ${evidence.text.length} chars against "${spec.title}"`);
    outcome = await reviewEvidence(spec, evidence.text);
  }
  log(`mandate ${id} round ${round}: ${outcome.approve ? 'APPROVE' : 'REJECT'}${outcome.failures.length ? ' - ' + outcome.failures.join('; ') : ''}`);

  let reasonCID = '';
  if (hasPinataCredentials()) {
    try {
      const report = { mandateId: id.toString(), round: Number(round), evidenceCID, specCID: m.specCID, verifier: me, ...outcome };
      reasonCID = (await pinJSON(report, { name: `review-${id}-r${round}` })).cid;
    } catch (e) {
      warn(`could not pin review report (${e.message}); attesting without it`);
    }
  }
  await attest(contract, id, outcome.approve, reasonCID);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  const provider = new ethers.JsonRpcProvider(CFG.rpcUrl);
  const wallet = new ethers.Wallet(CFG.privateKey, provider);
  const contract = new ethers.Contract(CFG.registry, REGISTRY_ABI, wallet);

  const [network, role] = await Promise.all([provider.getNetwork(), contract.VERIFIER_ROLE()]);
  log(`chain ${network.chainId}, registry ${CFG.registry}, verifier ${wallet.address}${CFG.dryRun ? ' (DRY_RUN)' : ''}`);
  if (!(await contract.hasRole(role, wallet.address))) {
    const msg = 'signer does not hold VERIFIER_ROLE';
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

  const filter = contract.filters.EvidenceSubmitted();
  let backoff = CFG.pollMs;
  while (!stopping) {
    try {
      const safeHead = (await provider.getBlockNumber()) - CFG.confirmations;
      while (!stopping && state.nextBlock <= safeHead) {
        const to = Math.min(state.nextBlock + CFG.maxBlockSpan - 1, safeHead);
        for (const ev of await contract.queryFilter(filter, state.nextBlock, to)) {
          const key = `${ev.transactionHash}:${ev.index}`;
          if (state.processed[key]) continue;
          const { id, round, evidenceCID } = ev.args;
          log(`EvidenceSubmitted mandate ${id} round ${round} cid ${evidenceCID} (block ${ev.blockNumber})`);
          await handleEvidence(contract, wallet.address, id, round, evidenceCID); // TransientError aborts the range
          state.processed[key] = ts();
          saveState(state);
        }
        state.nextBlock = to + 1;
        state.processed = {};
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

main().catch((e) => {
  console.error(`${ts()} [attestor] FATAL ${e.message}`);
  process.exit(1);
});
