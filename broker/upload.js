#!/usr/bin/env node
/**
 * upload.js - IPFS pinning engine (Pinata).
 *
 * Pins a redacted text file to IPFS through Pinata's pinFileToIPFS endpoint and
 * prints the immutable Content Identifier (CID) to the terminal.
 *
 * Usage:
 *   node upload.js <path/to/redacted.txt> [--name "JFK batch 07"] [--json]
 *
 * Auth (environment, first match wins):
 *   PINATA_JWT                                  - scoped JWT (recommended)
 *   PINATA_API_KEY + PINATA_SECRET_API_KEY      - legacy key pair
 * Optional:
 *   PINATA_API_URL   default https://api.pinata.cloud
 *   PINATA_GATEWAY   default https://gateway.pinata.cloud
 *   UPLOAD_MAX_BYTES default 104857600 (100 MiB)
 *
 * Exit codes: 0 pinned, 1 pin failed, 2 usage / config / input error.
 *
 * Also importable: const { pinFile } = require('./upload');
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');

const API_URL = (process.env.PINATA_API_URL || 'https://api.pinata.cloud').replace(/\/+$/, '');
const GATEWAY = (process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud').replace(/\/+$/, '');
const MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 100 * 1024 * 1024);
const MAX_ATTEMPTS = 5;

class UploadError extends Error {
  constructor(message, { status, retryable = false, cause } = {}) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

function authHeaders() {
  if (process.env.PINATA_JWT) {
    return { Authorization: `Bearer ${process.env.PINATA_JWT.trim()}` };
  }
  if (process.env.PINATA_API_KEY && process.env.PINATA_SECRET_API_KEY) {
    return {
      pinata_api_key: process.env.PINATA_API_KEY.trim(),
      pinata_secret_api_key: process.env.PINATA_SECRET_API_KEY.trim(),
    };
  }
  throw new UploadError('Missing Pinata credentials: set PINATA_JWT or PINATA_API_KEY + PINATA_SECRET_API_KEY');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function classify(err) {
  if (err instanceof UploadError) return err;
  if (err.response) {
    const { status, data } = err.response;
    const detail = typeof data === 'string' ? data : JSON.stringify(data);
    return new UploadError(`Pinata HTTP ${status}: ${detail?.slice(0, 500)}`, {
      status,
      retryable: status === 429 || status >= 500,
      cause: err,
    });
  }
  // No response: network error or timeout.
  return new UploadError(`Network error contacting Pinata: ${err.code || err.message}`, {
    retryable: true,
    cause: err,
  });
}

/**
 * Pin a file to IPFS.
 * @param {string} filePath
 * @param {{ name?: string, keyvalues?: Record<string,string> }} [opts]
 * @returns {Promise<{ cid: string, size: number, sha256: string, timestamp: string, gatewayUrl: string, duplicate: boolean }>}
 */
async function pinFile(filePath, opts = {}) {
  const resolved = path.resolve(filePath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (e) {
    throw new UploadError(`Cannot read ${resolved}: ${e.code || e.message}`);
  }
  if (!stat.isFile()) throw new UploadError(`${resolved} is not a regular file`);
  if (stat.size === 0) throw new UploadError(`${resolved} is empty`);
  if (stat.size > MAX_BYTES) throw new UploadError(`${resolved} is ${stat.size} bytes (limit ${MAX_BYTES})`);

  const body = fs.readFileSync(resolved);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const headers = authHeaders();

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // A FormData stream can only be consumed once, so rebuild it per attempt.
    const form = new FormData();
    form.append('file', body, { filename: path.basename(resolved), contentType: 'text/plain; charset=utf-8' });
    form.append(
      'pinataMetadata',
      JSON.stringify({
        name: opts.name || path.basename(resolved),
        keyvalues: { sha256, pipeline: 'declassification-oracle', ...(opts.keyvalues || {}) },
      }),
    );
    form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

    try {
      const res = await axios.post(`${API_URL}/pinning/pinFileToIPFS`, form, {
        headers: { ...form.getHeaders(), ...headers },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120_000,
      });
      const { IpfsHash, PinSize, Timestamp, isDuplicate } = res.data || {};
      if (!IpfsHash || typeof IpfsHash !== 'string') {
        throw new UploadError(`Unexpected Pinata response: ${JSON.stringify(res.data).slice(0, 300)}`);
      }
      return {
        cid: IpfsHash,
        size: PinSize,
        sha256,
        timestamp: Timestamp,
        gatewayUrl: `${GATEWAY}/ipfs/${IpfsHash}`,
        duplicate: Boolean(isDuplicate),
      };
    } catch (raw) {
      lastErr = classify(raw);
      if (!lastErr.retryable || attempt === MAX_ATTEMPTS) break;
      const retryAfter = Number(raw?.response?.headers?.['retry-after']);
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
      console.error(`[upload] attempt ${attempt}/${MAX_ATTEMPTS} failed (${lastErr.message}); retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function parseArgs(argv) {
  const args = { file: null, name: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--name') args.name = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else if (!args.file) args.file = a;
    else throw new UploadError(`Unexpected argument: ${a}`);
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 2;
  }
  if (args.help || !args.file) {
    console.error('usage: node upload.js <file> [--name <label>] [--json]');
    return args.help ? 0 : 2;
  }

  try {
    const result = await pinFile(args.file, { name: args.name });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      console.log('IPFS pin complete');
      console.log(`  CID       : ${result.cid}`);
      console.log(`  SHA-256   : ${result.sha256}`);
      console.log(`  Size      : ${result.size} bytes${result.duplicate ? ' (already pinned)' : ''}`);
      console.log(`  Gateway   : ${result.gatewayUrl}`);
      console.log(`\nSubmit on-chain with: submitDataHash("${result.cid}")`);
    }
    return 0;
  } catch (e) {
    console.error(`error: ${e.message}`);
    return e.status || e.retryable ? 1 : 2;
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = { pinFile, UploadError };
