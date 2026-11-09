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

const DAY = 86_400;
const QUESTION_CID = 'bafy' + 'q'.repeat(55);
const docHash = (s) => ethers.keccak256(ethers.toUtf8Bytes(`pepper:${s}`));

let chain, provider, admin, clerk, relayerSigner, c, relay, app, browser, page, appUrl;
const servers = [];
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => { servers.push(srv); r(srv.address().port); }));

before(async () => {
  chain = ganache.server({ logging: { quiet: true }, wallet: { totalAccounts: 4, defaultBalance: 1000 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } });
  await new Promise((r) => chain.listen(0, '127.0.0.1', r));
  const rpcUrl = `http://127.0.0.1:${chain.address().port}`;
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
    },
  };
  app = createAppServer(appOpts); // reads appOpts on every request
  const appPort = await listen(app);
  appOpts.config.ipfsGateway = `http://localhost:${appPort}`; // the app's own server doubles as the IPFS gateway
  appUrl = `http://localhost:${appPort}/`; // passkeys need a domain name, not an IP

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await context.newPage();
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
  const shot = async (name) => process.env.APP_SCREENSHOT_DIR && page.screenshot({ path: `${process.env.APP_SCREENSHOT_DIR}/${name}.png`, fullPage: true });
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
