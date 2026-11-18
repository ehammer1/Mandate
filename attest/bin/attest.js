#!/usr/bin/env node
// Command-line tool for agent builders. Run `attest help`.
'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const sdk = require('../src');
const capture = require('../src/capture');

const HELP = `attest: sign and verify content from registered agents

  attest hash <file>
  attest sign <file> --origin <origin> [--type <media type>] [--out <receipt.json>]
        Off-chain receipt signed by AGENT_KEY. Free, no network needed.
  attest anchor <file> --origin <origin> [--type <media type>] [--ref <uid>]
        On-chain attestation on EAS, signed and paid for by AGENT_KEY.
  attest verify <file> [--receipt <receipt.json>]...
        Who made it and who answers for it.
  attest register-agent --model <ref> --uri <registration file URL> [--expires <unix time>]
        CONTROLLER_KEY registers AGENT_KEY as its agent.

  attest verify-capture <video.mp4> [--manifest <file.manifest.json>]
        Check a recording from the capture app: sealed, partial, altered or invalid.
  attest capture-seal <fragmented.mp4> [--out <sealed.mp4>] [--key <pkcs8.b64>]
        Seal an existing fragmented MP4 the way the app does, with a software key.
        For testing only: real recordings are sealed on the phone by its security chip.

origins: human-made, ai-assisted, ai-generated, agent-action
environment: RPC_URL, AGENT_KEY, CONTROLLER_KEY,
             DEPLOYMENT (default deployments/base-sepolia.json)`;

const MEDIA = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.json': 'application/json',
};

function parseArgs(argv) {
  const pos = [];
  const opt = { receipt: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) pos.push(argv[i]);
    else {
      const k = argv[i].slice(2);
      const v = argv[++i];
      if (v === undefined) throw new Error(`--${k} needs a value`);
      if (k === 'receipt') opt.receipt.push(v);
      else opt[k] = v;
    }
  }
  return { pos, opt };
}

function deployment() {
  const file = process.env.DEPLOYMENT || path.join(__dirname, '..', 'deployments', 'base-sepolia.json');
  if (!fs.existsSync(file)) throw new Error(`no deployment file at ${file} (set DEPLOYMENT, or run npm run deploy)`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function provider() {
  if (!process.env.RPC_URL) throw new Error('set RPC_URL');
  return new ethers.JsonRpcProvider(process.env.RPC_URL);
}
function wallet(name, p) {
  const k = process.env[name];
  if (!k) throw new Error(`set ${name}`);
  return new ethers.Wallet(k, p);
}
function readFile(f) {
  if (!f) throw new Error('give a file');
  return { bytes: fs.readFileSync(f), type: MEDIA[path.extname(f).toLowerCase()] || 'application/octet-stream' };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);

  switch (cmd) {
    case 'hash': {
      console.log(sdk.hashContent(readFile(pos[0]).bytes));
      return;
    }
    case 'sign': {
      const d = deployment();
      const { bytes, type } = readFile(pos[0]);
      const receipt = await sdk.signReceipt(
        wallet('AGENT_KEY'),
        { contentHash: sdk.hashContent(bytes), origin: need(opt, 'origin'), mediaType: opt.type || type },
        { chainId: d.chainId, agents: d.agents },
      );
      const out = opt.out || `${pos[0]}.receipt.json`;
      fs.writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n');
      console.log(`receipt written to ${out}`);
      return;
    }
    case 'anchor': {
      const d = deployment();
      const { bytes, type } = readFile(pos[0]);
      const uid = await sdk.attest(wallet('AGENT_KEY', provider()), d, {
        contentHash: sdk.hashContent(bytes),
        origin: need(opt, 'origin'),
        mediaType: opt.type || type,
        refUID: opt.ref || ethers.ZeroHash,
      });
      console.log(`attestation ${uid}`);
      return;
    }
    case 'verify': {
      const d = deployment();
      const { bytes } = readFile(pos[0]);
      const receipts = opt.receipt.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
      const report = await sdk.inspect(sdk.hashContent(bytes), { provider: provider(), addresses: d, receipts });
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    case 'verify-capture': {
      const buf = fs.readFileSync(need({ f: pos[0] }, 'f'));
      const manifest = opt.manifest ? JSON.parse(fs.readFileSync(opt.manifest, 'utf8')) : undefined;
      const r = capture.verifyCapture(buf, { manifest });
      const m = r.manifest || {};
      const lines = {
        sealed: `SEALED: unaltered since recording (${r.fragments} fragments)`,
        partial: `PARTIAL: recording stopped early; the first ${r.verifiedFragments} of ${r.fragments} fragments are proven`,
        altered:
          typeof r.alteredAt === 'number'
            ? `ALTERED at fragment ${r.alteredAt} (about ${r.alteredAt}s in)` +
              (r.verifiedFragments ? `; fragments 0-${r.verifiedFragments - 1} are original` : '')
            : `ALTERED: ${r.problems[0]}`,
        invalid: `INVALID: ${r.problems[0] || 'cannot be verified'}`,
      };
      console.log(lines[r.status]);
      if (m.meta) {
        console.log(`  signed by key ${m.meta.keyId.slice(0, 16)}… (${m.meta.platform}, ${m.meta.device || 'unknown device'}, ${m.meta.app})`);
        if (m.startMs) console.log(`  recorded ${new Date(m.startMs).toISOString()}${m.endMs ? ` to ${new Date(m.endMs).toISOString()}` : ''} (device clock)`);
      }
      console.log('  device registration and on-chain anchor: not checked yet (phase 2)');
      if (r.status !== 'sealed') process.exitCode = 2;
      return;
    }
    case 'capture-seal': {
      const src = need({ f: pos[0] }, 'f');
      const key = opt.key ? capture.softwareSigner({ key: Buffer.from(fs.readFileSync(opt.key, 'utf8').trim(), 'base64'), format: 'der', type: 'pkcs8' }) : undefined;
      const { file, manifest } = capture.simulateCapture(fs.readFileSync(src), { signer: key });
      const out = opt.out || src.replace(/(\.mp4)?$/i, '.sealed.mp4');
      fs.writeFileSync(out, file);
      console.log(`sealed ${manifest.fragments.length} fragments with test key ${manifest.meta.keyId.slice(0, 16)}… -> ${out}`);
      return;
    }
    case 'register-agent': {
      const d = deployment();
      const p = provider();
      const id = await sdk.registerAgent({
        addresses: d,
        controller: wallet('CONTROLLER_KEY', p),
        agentKey: wallet('AGENT_KEY', p),
        modelRef: need(opt, 'model'),
        uri: need(opt, 'uri'),
        expiresAt: Number(opt.expires || 0),
      });
      console.log(`agent ${id} registered`);
      return;
    }
    default:
      console.log(HELP);
  }
}

function need(opt, k) {
  if (!opt[k]) throw new Error(`--${k} is required`);
  return opt[k];
}

main().catch(async (e) => {
  const p = process.env.RPC_URL ? new ethers.JsonRpcProvider(process.env.RPC_URL) : null;
  console.error(`error: ${await sdk.explainError(e, p)}`);
  process.exit(1);
});
