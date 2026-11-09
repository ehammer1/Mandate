// End-to-end: registry on a local chain, a fake IPFS gateway, a stubbed AI check,
// and the real broker/attestor.js process. Run: npm test
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const ganache = require('ganache');
const { ethers } = require('ethers');

const art = (n) => require(`../build/${n}.json`);
const SPEC_CID = 'bafy' + 'a'.repeat(55);
const GOOD_CID = 'bafy' + 'b'.repeat(55);
const BAD_CID = 'bafy' + 'c'.repeat(55);
const IPFS = {
  [SPEC_CID]: JSON.stringify({ title: 'Publish budget', criteria: [{ id: 'c1', text: 'CSV published' }] }),
  [GOOD_CID]: 'FY2027 budget published as budget.csv',
  [BAD_CID]: 'we will publish it soon',
};

let chain, gateway, rpcUrl, gatewayUrl, provider, signers, reg;

before(async () => {
  chain = ganache.server({ logging: { quiet: true }, wallet: { totalAccounts: 6, defaultBalance: 1000 }, chain: { hardfork: 'shanghai' }, miner: { blockTime: 0 } });
  await new Promise((r) => chain.listen(0, r));
  rpcUrl = `http://127.0.0.1:${chain.address().port}`;
  gateway = http.createServer((req, res) => {
    const cid = req.url.replace('/ipfs/', '');
    if (IPFS[cid]) return res.end(IPFS[cid]);
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;

  provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 100 });
  signers = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const [admin, , v1, v2] = signers;
  reg = await new ethers.ContractFactory(art('MandateRegistry').abi, art('MandateRegistry').bytecode, admin).deploy(admin.address);
  await reg.waitForDeployment();
  await (await reg.grantRole(await reg.GOVERNOR_ROLE(), admin.address)).wait();
  for (const v of [v1, v2]) await (await reg.grantRole(await reg.VERIFIER_ROLE(), v.address)).wait();
});

after(async () => {
  await new Promise((r) => gateway.close(r));
  await chain.close();
});

// Ganache's first accounts are deterministic from its default mnemonic only when seeded,
// so ask the node for the verifier key instead.
async function keyOf(addr) {
  const accounts = await provider.send('eth_accounts', []);
  const idx = accounts.findIndex((a) => a.toLowerCase() === addr.toLowerCase());
  const keys = chain.provider.getInitialAccounts();
  return keys[accounts[idx].toLowerCase()].secretKey;
}

function runAttestor(env, untilFn, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attestor-'));
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'broker', 'attestor.js')], {
      cwd: tmp,
      env: {
        PATH: process.env.PATH,
        RPC_URL: rpcUrl,
        REGISTRY_ADDRESS: reg.target,
        START_BLOCK: '0',
        CONFIRMATIONS: '0',
        POLL_INTERVAL_MS: '200',
        IPFS_GATEWAY: gatewayUrl,
        PYTHON_BIN: path.join(__dirname, 'fixtures', 'fake-python'),
        STATE_FILE: path.join(tmp, 'state.json'),
        ...env,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const started = Date.now();
    const tick = setInterval(async () => {
      try {
        if (await untilFn()) {
          clearInterval(tick);
          child.kill('SIGTERM');
          resolve(out);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(tick);
          child.kill('SIGKILL');
          reject(new Error(`timed out; attestor output:\n${out}`));
        }
      } catch (e) {
        clearInterval(tick);
        child.kill('SIGKILL');
        reject(e);
      }
    }, 300);
  });
}

test('attestor approves grounded evidence and rejects the rest', async () => {
  const [admin, agency, v1, v2] = signers;
  const deadline = (await provider.getBlock('latest')).timestamp + 30 * 86400;
  await (await reg.createMandate(agency.address, deadline, 2, ethers.id('budget'), SPEC_CID)).wait();
  const id = 1n;

  // Round 1: weak evidence -> both AI verifiers reject -> back to Active.
  await (await reg.connect(agency).submitEvidence(id, BAD_CID)).wait();
  for (const v of [v1, v2]) {
    await runAttestor({ VERIFIER_PRIVATE_KEY: await keyOf(v.address) }, () => reg.hasAttested(id, 1, v.address));
  }
  assert.equal(await reg.statusOf(id), 1n);

  // Round 2: good evidence -> both approve -> Fulfilled.
  await (await reg.connect(agency).submitEvidence(id, GOOD_CID)).wait();
  for (const v of [v1, v2]) {
    await runAttestor({ VERIFIER_PRIVATE_KEY: await keyOf(v.address) }, () => reg.hasAttested(id, 2, v.address));
  }
  assert.equal(await reg.isFulfilled(id), true);
});

test('attestor does not attest when the AI check errors (retries instead)', async () => {
  const [, agency, v1] = signers;
  const deadline = (await provider.getBlock('latest')).timestamp + 30 * 86400;
  await (await reg.createMandate(agency.address, deadline, 2, ethers.id('budget'), SPEC_CID)).wait();
  const id = await reg.mandateCount();
  await (await reg.connect(agency).submitEvidence(id, GOOD_CID)).wait();
  let polls = 0;
  const out = await runAttestor(
    { VERIFIER_PRIVATE_KEY: await keyOf(v1.address), FAKE_VERDICT: 'error' },
    async () => ++polls > 15,
  );
  assert.match(out, /transient error/);
  assert.equal(await reg.hasAttested(id, 1, v1.address), false);
});
