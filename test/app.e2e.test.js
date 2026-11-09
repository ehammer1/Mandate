// Voter web app end to end in a real browser (Chromium + a virtual passkey):
// create a passkey-derived voter key, get enrolled by the clerk, vote anonymously
// through the relayer with a proof built in the browser, sign in again with the
// same passkey and see the same identity. Run: npm test (after build:app)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { chromium } = require('playwright');
const { Identity } = require('@semaphore-protocol/identity');
const { deployAll } = require('../scripts/deploy');
const { createAppServer } = require('../scripts/serve-app');
const { createRelayer } = require('../broker/relayer');
const { createIdentityService } = require('../services/identity/server');
const { createMockOidc } = require('./helpers/mock-oidc');
const net = require('node:net');

const DAY = 86_400;
const QUESTION_CID = 'bafy' + 'q'.repeat(55);
const docHash = (s) => ethers.keccak256(ethers.toUtf8Bytes(`pepper:${s}`));

let walletAccount, rpcUrlForPage;
let chain, provider, admin, clerk, relayerSigner, c, relay, app, browser, page, appUrl;
const servers = [];
const shot = async (name) => process.env.APP_SCREENSHOT_DIR && page.screenshot({ path: `${process.env.APP_SCREENSHOT_DIR}/${name}.png`, fullPage: true });
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => { servers.push(srv); r(srv.address().port); }));

before(async () => {
  chain = ganache.server({ logging: { quiet: true }, wallet: { totalAccounts: 6, defaultBalance: 1000 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } });
  await new Promise((r) => chain.listen(0, '127.0.0.1', r));
  const rpcUrl = `http://127.0.0.1:${chain.address().port}`;
  rpcUrlForPage = rpcUrl;
  provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 100 });
  [admin, clerk, relayerSigner] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));

  ({ contracts: c } = await deployAll(admin, { seasoningDays: 30 }));
  await (await c.identity.setIssuer(clerk.address, 1, true, 'Example City Clerk')).wait();

  relay = createRelayer({ provider, signer: relayerSigner, voteAddress: await c.vote.getAddress(), log: () => {} });
  const relayPort = await listen(relay);

  const ipfs = { [QUESTION_CID]: JSON.stringify({ title: 'Publish the FY2027 line-item budget?', body: 'Every line item above $10,000, as CSV, within 30 days.', options: ['Yes', 'No'] }) };
  const appOpts = {
    ipfs,
    config: {
      rpcUrl,
      voteAddress: await c.vote.getAddress(),
      identityAddress: await c.identity.getAddress(),
      creditsAddress: await c.credits.getAddress(),
      relayers: ['http://127.0.0.1:1', `http://127.0.0.1:${relayPort}`], // the first is down: tests fail-over
      artifactsBase: '/artifacts',
      chainId: Number((await provider.getNetwork()).chainId),
    },
  };
  walletAccount = (await provider.getSigner(4)).address;
  // Sign-in identity service with a mock OpenID provider ("Test Login").
  const idp = await createMockOidc({ clientId: 'mandate-app', clientSecret: 'app-secret' });
  servers.push(idp.server);
  const idPort = await new Promise((r) => { const t = net.createServer().listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); });
  const identitySigner = await provider.getSigner(3);
  const returnOrigins = [];
  await (await c.identity.setIssuer(identitySigner.address, 0, true, 'Online sign-up')).wait();
  const idService = createIdentityService({
    providers: [{ id: 'testlogin', name: 'Test Login', issuer: idp.issuer(), clientId: 'mandate-app', clientSecret: 'app-secret', tier: 0, scope: 'openid email', requireEmailVerified: true }],
    publicUrl: `http://127.0.0.1:${idPort}`,
    pepper: 'p'.repeat(64),
    signer: identitySigner,
    identityAddress: await c.identity.getAddress(),
    allowedReturnOrigins: returnOrigins, // filled once the app's port is known
    allowInsecure: true,
    log: () => {},
  });
  await new Promise((r) => idService.listen(idPort, '127.0.0.1', r));
  servers.push(idService);
  appOpts.config.identityService = `http://127.0.0.1:${idPort}`;

  app = createAppServer(appOpts); // reads appOpts on every request
  const appPort = await listen(app);
  appOpts.config.ipfsGateway = `http://localhost:${appPort}`; // the app's own server doubles as the IPFS gateway
  appUrl = `http://localhost:${appPort}/`; // passkeys need a domain name, not an IP
  returnOrigins.push(`http://localhost:${appPort}`);

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await context.newPage();
  // A stand-in browser wallet that announces itself the standard way (EIP-6963) and
  // forwards requests to the local chain, signing as an unlocked test account.
  await context.addInitScript(({ rpc, account }) => {
    const send = async (method, params) => {
      const res = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }) });
      const body = await res.json();
      if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data });
      return body.result;
    };
    const provider = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        return send(method, params);
      },
      on() {},
      removeListener() {},
    };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'test-wallet', name: 'Test Wallet', icon: '', rdns: 'org.example.test' }, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
  }, { rpc: rpcUrlForPage, account: walletAccount });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });
});

after(async () => {
  await browser?.close();
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
  await chain?.close();
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('passkey sign-up, enrolment, anonymous vote through relayer fail-over, same identity on return', async () => {
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(appUrl);
  await page.waitForSelector('#screen-signin:not([hidden])');
  await shot('1-sign-in');
  await page.click('#btn-create');
  await page.waitForSelector('#screen-home:not([hidden])');
  await page.waitForFunction(() => /Not enrolled/.test(document.querySelector('#membership').textContent));

  await page.click('[data-go="screen-code"]');
  const commitment = BigInt((await page.textContent('#voter-code')).trim());
  assert.ok(commitment > 0n);

  // The clerk checks ID at the desk and enrols the voter code (a long-time resident: full rights at once),
  // plus two neighbours so the voter list is bigger than one.
  const longAgo = (await provider.getBlock('latest')).timestamp - 3 * 365 * DAY;
  await (await c.identity.connect(clerk).enroll(commitment, 1, docHash('DL-app'), longAgo)).wait();
  for (const [i, n] of [new Identity('n1'), new Identity('n2')].entries()) {
    await (await c.identity.connect(clerk).enroll(n.commitment, 1, docHash(`DL-n${i}`), longAgo)).wait();
  }

  // The council clerk opens a poll for residents with full voting rights.
  await (await c.vote.createPoll(await c.identity.groupId(2), 7 * DAY, 1, 2, 0, '0x', QUESTION_CID, 0)).wait();

  await page.click('#nav-polls');
  await page.waitForFunction(() => /full voting rights/.test(document.querySelector('#membership').textContent));
  await page.waitForSelector('text=Publish the FY2027 line-item budget?');
  await shot('2-poll-open');
  await page.click('#poll-1 button.choice >> text=Yes');
  await page.waitForFunction(() => /Your vote is recorded/.test(document.querySelector('#poll-status-1').textContent), null, { timeout: 120_000 });
  assert.deepEqual((await c.vote.tally(1)).map(Number), [1, 0]);
  await shot('3-voted');

  // Sign out and back in with the same passkey: same voter, and the app knows this vote was cast.
  await page.click('#btn-signout');
  await page.click('#btn-unlock');
  await page.waitForSelector('#screen-home:not([hidden])');
  await page.click('[data-go="screen-code"]');
  assert.equal(BigInt((await page.textContent('#voter-code')).trim()), commitment);
  await page.click('#nav-polls');
  await page.waitForSelector('#poll-1 >> text=Your vote is recorded');
  assert.equal(await page.locator('#poll-1 button.choice').count(), 0);

  // Optional account: derived from the same passkey, but a different key from the voter key.
  await page.click('#nav-account');
  const addr = (await page.textContent('#account-address')).trim();
  assert.ok(ethers.isAddress(addr));
  await shot('4-account');
});

test('admin from the passkey account, and from a connected wallet', async () => {
  // Make the app's automatic (passkey-derived) account an admin, clerk and poll opener, and give it fee money.
  await page.click('#nav-account');
  const auto = ethers.getAddress((await page.textContent('#account-address')).trim());
  await (await c.identity.grantRole(ethers.ZeroHash, auto)).wait();
  await (await c.identity.setIssuer(auto, 1, true, 'Main Library desk')).wait();
  await (await c.vote.grantRole(await c.vote.PROPOSER_ROLE(), auto)).wait();
  await (await admin.sendTransaction({ to: auto, value: ethers.parseEther('1') })).wait();

  await page.click('#nav-polls'); // refreshes roles
  await page.waitForSelector('#nav-admin:not([hidden])');
  await page.click('#nav-admin');
  await page.waitForFunction(() => /can enrol voters/.test(document.querySelector('#admin-who').textContent));

  // Enrol a newcomer by voter code from the app.
  const newcomer = new Identity('library-visitor');
  await page.fill('#enrol-code', newcomer.commitment.toString());
  await page.fill('#enrol-doc', 'D1234567');
  await page.check('#enrol-new');
  await page.click('#btn-enrol');
  await page.waitForFunction(() => /Enrol voter: done/.test(document.querySelector('#enrol-status').textContent), null, { timeout: 60_000 });
  const m = await c.identity.members(newcomer.commitment);
  assert.equal(m.active, true);
  assert.equal(m.issuer, auto);
  assert.equal(m.tier, 1n); // new resident: verified, waiting out seasoning

  // Open a poll from the app.
  const before = await c.vote.pollCount();
  await page.fill('#poll-question', QUESTION_CID);
  await page.click('#btn-open-poll');
  await page.waitForFunction(() => /Open poll: done/.test(document.querySelector('#poll-status').textContent), null, { timeout: 60_000 });
  assert.equal(await c.vote.pollCount(), before + 1n);

  // Connect a browser wallet (announced via EIP-6963), make it a clerk from the passkey account,
  // then switch to the wallet and see it act with its own roles.
  await page.click('#nav-account');
  await page.waitForSelector('#wallet-list button[data-injected]');
  await page.click('#nav-admin');
  await page.fill('#grant-address', walletAccount);
  await page.selectOption('#grant-kind', 'issuer');
  await page.fill('#grant-name', 'Test Wallet clerk');
  await page.click('#btn-grant');
  await page.waitForFunction(() => /done/.test(document.querySelector('#grant-status').textContent), null, { timeout: 60_000 });
  assert.equal((await c.identity.issuers(walletAccount)).active, true);

  await page.click('#nav-account');
  await page.click('#wallet-list button[data-injected]');
  await page.waitForFunction(() => /Connected: Test Wallet/.test(document.querySelector('#account-kind').textContent));
  assert.equal(ethers.getAddress((await page.textContent('#account-address')).trim()), walletAccount);
  await page.click('#nav-admin');
  await page.waitForFunction(() => /can enrol voters/.test(document.querySelector('#admin-who').textContent));
  assert.equal(await page.textContent('#enrol-status'), ''); // old results cleared
  const another = new Identity('wallet-enrolled');
  await page.fill('#enrol-code', another.commitment.toString());
  await page.click('#btn-enrol');
  await page.waitForFunction(() => /Enrol voter: done/.test(document.querySelector('#enrol-status').textContent), null, { timeout: 60_000 });
  assert.equal((await c.identity.members(another.commitment)).issuer, walletAccount);
  await shot('5-admin');
});

test('join online: sign in with a provider, come back enrolled', async () => {
  // A new person on a fresh device key (signed-out state, different voter identity).
  await page.click('#btn-signout');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click('#device-option summary');
  await page.click('#btn-device');
  await page.waitForSelector('#screen-home:not([hidden])');
  await page.waitForSelector('#join-online button[data-join="testlogin"]');
  await shot('6-join-online');
  await page.click('#join-online button[data-join="testlogin"]');

  // Redirected through the identity service and the provider, back to the app.
  await page.waitForFunction(() => /You joined as a basic member with Test Login/.test((document.querySelector('#signin-status')?.textContent || '') + (document.querySelector('#home-notice')?.textContent || '')), null, { timeout: 60_000 });
  assert.equal(new URL(page.url()).hash, ''); // notice consumed, address cleaned
  if (await page.isVisible('#screen-signin')) await page.click('#btn-device'); // fresh load: unlock the same device key
  await page.waitForSelector('#screen-home:not([hidden])');
  await page.waitForFunction(() => /^Basic/.test(document.querySelector('#membership .big')?.textContent || ''));
  assert.match(await page.textContent('#home-notice'), /joined as a basic member/);
  await page.click('[data-go="screen-code"]');
  const code = BigInt((await page.textContent('#voter-code')).trim());
  const m = await c.identity.members(code);
  assert.equal(m.active, true);
  assert.notEqual(m.accountHash, ethers.ZeroHash);
});

test('shared computer: sign in with the passkey without saving anything here', async () => {
  await page.click('#btn-signout');
  const before = await page.evaluate(() => JSON.stringify(localStorage));
  await page.click('#btn-public');
  await page.waitForSelector('#screen-home:not([hidden])');
  assert.match(await page.textContent('#signin-method'), /nothing is saved here/);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), before); // no keys, no remembered credential
  await page.click('#nav-account');
  await page.waitForSelector('#account-address + .copy-btn');
  await page.click('#btn-signout');
  assert.equal(await page.textContent('#voter-code'), ''); // nothing left on screen either
});
