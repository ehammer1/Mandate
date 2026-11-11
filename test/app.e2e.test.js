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
const { createMemorySender } = require('../services/identity/senders');
const { createEmailPolicy } = require('../services/identity/email-policy');
const mail = createMemorySender();
const postbox = require('../services/identity/mail').createMemoryMailer();
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const QRCode = require('qrcode');
const jsQR = require('jsqr');
const { voterCodeQr, parseVoterCode } = require('../client/clerk');

// A person at the clerk desk whose phone shows their voter-code QR to the desk's camera.
const scanned = new Identity('scanned-at-the-desk');
// A made-up voter roll for the desk's roll lookups.
const ROLL_KEY = 'r'.repeat(48);
const appRoll = require('../scripts/roll-import').buildRoll(
  ['VOTER_ID,FIRST_NAME,LAST_NAME,BIRTH_DATE,RES_ADDRESS,ZIP_CODE', 'OR2001,Maria,Okafor-Brown,1975-06-30,"88 River Rd",97205', 'OR2002,Sam,Lee,1990-02-14,12 Oak Ave,97206'].join('\n'),
  { key: ROLL_KEY, state: 'OR' },
);

/** A fake camera feed (Y4M video) showing a QR code, for Chromium's fake capture device. */
function qrVideo(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const W = 480, H = 480, n = qr.modules.size, scale = Math.floor((W - 80) / n), off = Math.floor((W - n * scale) / 2);
  const Y = Buffer.alloc(W * H, 235);
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
    if (!qr.modules.get(r, col)) continue;
    for (let y = 0; y < scale; y++) Y.fill(16, (off + r * scale + y) * W + off + col * scale, (off + r * scale + y) * W + off + (col + 1) * scale);
  }
  const UV = Buffer.alloc((W / 2) * (H / 2), 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), Y, UV, UV]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mandate-cam-')), 'qr.y4m');
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), frame, frame]));
  return file;
}

const DAY = 86_400;
const QUESTION_CID = 'bafy' + 'q'.repeat(55);
const docHash = (s) => ethers.keccak256(ethers.toUtf8Bytes(`pepper:${s}`));

let walletAccount, rpcUrlForPage, cdpMain, authIdMain, appConfig, appIpfs;
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

  ({ contracts: c } = await deployAll(admin, { seasoningDays: 30, rules: { MIN_POLL_MINUTES: 10, BINDING_QUORUM_PCT: 0, BINDING_CHECK_REQUIRED: 0, CHECK_MIN_VOTES: 1, RULE_CHANGE_MIN_MINUTES: 1440 } }));
  await (await c.identity.setIssuer(clerk.address, 1, true, 'Example City Clerk')).wait();

  relay = createRelayer({ provider, signer: relayerSigner, voteAddress: await c.vote.getAddress(), budgetAddress: await c.budget.getAddress(), feedbackAddress: await c.feedback.getAddress(), noticeBoardAddress: await c.notices.getAddress(), log: () => {} });
  const relayPort = await listen(relay);

  const ipfs = { [QUESTION_CID]: JSON.stringify({ title: 'Publish the FY2027 line-item budget?', body: 'Every line item above $10,000, as CSV, within 30 days.', options: ['Yes', 'No'] }) };
  const appOpts = {
    ipfs,
    config: {
      rpcUrl,
      voteAddress: await c.vote.getAddress(),
      identityAddress: await c.identity.getAddress(),
      creditsAddress: await c.credits.getAddress(),
      registryAddress: await c.registry.getAddress(),
      noticeBoardAddress: await c.notices.getAddress(),
      charterAddress: await c.charter.getAddress(),
      budgetAddress: await c.budget.getAddress(),
      feedbackAddress: await c.feedback.getAddress(),
      escrowFactoryAddress: await c.escrows.getAddress(),
      officialsAddress: await c.officials.getAddress(),
      bodiesAddress: await c.bodies.getAddress(),
      bodyRecordsAddress: await c.bodyRecords.getAddress(),
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
    emailSender: mail,
    emailPolicy: createEmailPolicy({ allow: 'reputable' }),
    allowInsecure: true,
    clerkAnchor: () => appOpts.config.clerkAnchor || 'id',
    appConfig: () => appOpts.config,
    askEnabled: true,
    answerQuestion: async (item, q) => ({ answer: `Asked "${q}" about "${item.title}".`, answered_by_text: !/parking/i.test(q), quotes: ['within 30 days'], model: 'claude-opus-5-5' }),
    roll: () => appRoll,
    rollKey: ROLL_KEY,
    mailer: postbox,
    mailPerIpHour: 1000,
    // Files go to a stand-in for IPFS: the app's own test server serves them back.
    uploads: require('../services/identity/uploads').createUploads({
      store: {
        pin: async (bytes, name, type) => {
          const cid = `bafy${require('crypto').createHash('sha256').update(bytes).digest('hex').slice(0, 40)}`;
          appIpfs[cid] = { type, body: Buffer.from(bytes) };
          return cid;
        },
        unpin: async (cid) => delete appIpfs[cid],
      },
      appConfig: () => appOpts.config,
      provider,
      read: async (bytes, type) => ({ kind: type === 'application/pdf' ? 'document' : 'photo', alt: 'A deep pothole on Elm Street', text: 'ELM ST', summary: 'A photo of a pothole next to a street sign.', personal_info: type !== 'application/pdf', personal_info_note: 'a car licence plate', model: 'claude-opus-5-5' }),
      adminToken: 'takedown-token',
    }),
    log: () => {},
  });
  await new Promise((r) => idService.listen(idPort, '127.0.0.1', r));
  servers.push(idService);
  appOpts.config.identityService = `http://127.0.0.1:${idPort}`;

  appConfig = appOpts.config;
  appIpfs = appOpts.ipfs;
  app = createAppServer(appOpts); // reads appOpts on every request
  const appPort = await listen(app);
  appOpts.config.ipfsGateway = `http://localhost:${appPort}`; // the app's own server doubles as the IPFS gateway
  appUrl = `http://localhost:${appPort}/`; // passkeys need a domain name, not an IP
  returnOrigins.push(`http://localhost:${appPort}`);

  browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${qrVideo(voterCodeQr(scanned.commitment))}`] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.grantPermissions(['camera'], { origin: appUrl.replace(/\/$/, '') });
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
        // Real wallets sign messages with personal_sign; the local chain offers the equivalent eth_sign.
        if (method === 'personal_sign') return send('eth_sign', [params[1], params[0]]);
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
  cdpMain = cdp;
  ({ authenticatorId: authIdMain } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  }));
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

test('passkey sign-up, enrollment, anonymous vote through relayer fail-over, same identity on return', async () => {
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
  // The QR code on screen carries exactly this voter code.
  const img = await page.evaluate(() => {
    const cv = document.querySelector('#voter-qr');
    return { w: cv.width, h: cv.height, data: Array.from(cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data) };
  });
  assert.equal(parseVoterCode(jsQR(Uint8ClampedArray.from(img.data), img.w, img.h).data), commitment);

  // The clerk checks ID at the desk and enrolls the voter code (a long-time resident: full rights at once),
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
  await page.waitForFunction(() => /can enroll voters/.test(document.querySelector('#admin-who').textContent));

  // The clerk desk: open it once (signs a desk session), then serve people one by one.
  await page.waitForSelector('#nav-clerk:not([hidden])');
  await page.click('#nav-clerk');
  await page.waitForSelector('text=Main Library desk');
  await page.click('#btn-clerk-open');
  await page.waitForSelector('#clerk-steps:not([hidden])');

  // A newcomer, code pasted: enrolled with full rights after a new-resident wait.
  const newcomer = new Identity('library-visitor');
  await page.fill('#clerk-code', newcomer.commitment.toString());
  await page.click('#btn-clerk-lookup');
  await page.waitForSelector('#clerk-person >> text=Not on the voter list yet');
  await page.fill('#clerk-doc-region', 'ca');
  await page.fill('#clerk-doc-number', 'D1234567');
  await page.check('#clerk-new-resident');
  await page.selectOption('#clerk-residence', 'id');
  await page.click('#btn-clerk-submit');
  await page.waitForFunction(() => /Done: enrolled/.test(document.querySelector('#clerk-result').textContent), null, { timeout: 60_000 });
  assert.match(await page.textContent('#clerk-result'), /from .* \(new-resident waiting period\)/);
  const m = await c.identity.members(newcomer.commitment);
  assert.equal(m.active, true);
  assert.equal(m.issuer, auto);
  assert.equal(m.tier, 1n); // new resident: verified, waiting out seasoning
  assert.notEqual(m.docHash, ethers.keccak256(ethers.toUtf8Bytes('D1234567'))); // keyed fingerprint, not a plain hash
  await shot('5-clerk-done');

  // Next person: everything about the last one is gone from the screen.
  await page.click('#btn-clerk-next');
  for (const id of ['#clerk-code', '#clerk-doc-region', '#clerk-doc-number']) assert.equal(await page.inputValue(id), '');
  assert.equal(await page.textContent('#clerk-result'), '');

  // Same ID, written differently, for a second voter code: refused before anything is sent.
  const twice = new Identity('same-id-again');
  await page.fill('#clerk-code', twice.commitment.toString());
  await page.click('#btn-clerk-lookup');
  await page.waitForSelector('#clerk-person >> text=Not on the voter list yet');
  await page.fill('#clerk-doc-region', 'CA');
  await page.fill('#clerk-doc-number', 'd-123 4567');
  await page.check('#clerk-new-resident');
  await page.selectOption('#clerk-residence', 'id');
  await page.click('#btn-clerk-submit');
  await page.waitForFunction(() => /already linked to another voter code/.test(document.querySelector('#clerk-result').textContent), null, { timeout: 30_000 });
  assert.equal((await c.identity.members(twice.commitment)).active, false);

  // A basic member who joined online, QR scanned with the camera: upgraded, long-time resident.
  await page.click('#btn-clerk-next');
  await (await c.identity.connect(await provider.getSigner(3)).enroll(scanned.commitment, 0, ethers.ZeroHash, 0)).wait();
  await page.click('#btn-clerk-scan');
  await page.waitForSelector('#clerk-person >> text=Basic member', { timeout: 30_000 });
  assert.equal(await page.inputValue('#clerk-code'), scanned.commitment.toString());
  assert.equal(await page.isVisible('#clerk-video'), false); // camera off once scanned
  await page.selectOption('#clerk-doc-kind', 'passport');
  await page.fill('#clerk-doc-region', 'US');
  await page.fill('#clerk-doc-number', 'P9876543');
  await page.fill('#clerk-since', '2019-05');
  await page.selectOption('#clerk-residence', 'id');
  await page.click('#btn-clerk-submit');
  await page.waitForFunction(() => /Done: upgraded/.test(document.querySelector('#clerk-result').textContent), null, { timeout: 60_000 });
  assert.match(await page.textContent('#clerk-result'), /can vote in full-rights polls now/);
  assert.equal((await c.identity.members(scanned.commitment)).tier, 2n); // long-time resident: full rights at once

  // Already verified: the desk says so and offers nothing to do.
  await page.click('#btn-clerk-next');
  await page.fill('#clerk-code', voterCodeQr(scanned.commitment));
  await page.click('#btn-clerk-lookup');
  await page.waitForSelector('#clerk-person >> text=Nothing to do');
  assert.equal(await page.isVisible('#clerk-id'), false);
  await page.click('#btn-clerk-next');

  // Open a poll from the app.
  await page.click('#nav-admin');
  const before = await c.vote.pollCount();
  await page.fill('#poll-title', 'Open the library on Sundays?');
  await page.fill('#poll-body', 'From January, 10am to 4pm.');
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
  await page.waitForFunction(() => /can enroll voters/.test(document.querySelector('#admin-who').textContent));
  // The wallet's own clerk desk: a different account needs its own desk session.
  await page.click('#nav-clerk');
  await page.waitForSelector('text=Test Wallet clerk');
  await page.click('#btn-clerk-open');
  await page.waitForSelector('#clerk-steps:not([hidden])');
  assert.equal(await page.textContent('#clerk-result'), ''); // old results cleared
  const another = new Identity('wallet-enrolled');
  await page.fill('#clerk-code', another.commitment.toString());
  await page.click('#btn-clerk-lookup');
  await page.waitForSelector('#clerk-person >> text=Not on the voter list yet');
  await page.fill('#clerk-doc-region', 'NY');
  await page.fill('#clerk-doc-number', '123456789');
  await page.fill('#clerk-since', '2015-01');
  await page.selectOption('#clerk-residence', 'id');
  await page.click('#btn-clerk-submit');
  await page.waitForFunction(() => /Done: enrolled/.test(document.querySelector('#clerk-result').textContent), null, { timeout: 60_000 });
  assert.equal((await c.identity.members(another.commitment)).issuer, walletAccount);
  await shot('5-admin');
});

test('council: one member proposes a new clerk, another approves, it runs after the public wait', async () => {
  const { deploy } = require('../scripts/deploy');
  await page.click('#nav-account');
  await page.click('#btn-auto-wallet');
  await page.waitForFunction(() => /automatic/i.test(document.querySelector('#account-status').textContent));
  const auto = ethers.getAddress((await page.textContent('#account-address')).trim());
  const council = await deploy(admin, 'Council', {}, [auto, walletAccount, admin.address], 2, 3600, 0, await c.vote.getAddress(), await c.identity.groupId(2), 7 * 86_400);
  await (await c.identity.grantRole(ethers.ZeroHash, await council.getAddress())).wait();
  appConfig.councilAddress = await council.getAddress();

  // Reload to pick up the new setting; unlock with the passkey again, then use the wallet (a member, not an admin).
  await page.reload();
  await page.click('#btn-unlock');
  await page.waitForSelector('#screen-home:not([hidden])');
  await page.click('#nav-account');
  await page.click('#wallet-list button[data-injected]');
  await page.waitForFunction(() => /Connected: Test Wallet/.test(document.querySelector('#account-kind').textContent));
  await page.click('#nav-admin');
  await page.waitForFunction(() => /council member/.test(document.querySelector('#admin-who').textContent));
  await page.waitForSelector('#admin-council:not([hidden]) >> text=No changes proposed yet');
  assert.equal((await page.textContent('#btn-grant')).trim(), 'Propose to the council');

  const desk = ethers.Wallet.createRandom().address;
  await page.fill('#grant-address', desk);
  await page.selectOption('#grant-action', 'give');
  await page.selectOption('#grant-kind', 'issuer');
  await page.fill('#grant-name', 'Council desk');
  await page.fill('#grant-reason', 'Second desk at City Hall');
  await page.click('#btn-grant');
  await page.waitForFunction(() => /Proposed as council change #1\. It needs 1 more approval, then a public waiting period of 1 hour/.test(document.querySelector('#grant-status').textContent), null, { timeout: 60_000 });
  await page.waitForSelector('#council-1 >> text=Collecting approvals');
  assert.match(await page.textContent('#council-1'), /Approve 0x.* as clerk "Council desk" \(can give full voting rights\)/);
  assert.match(await page.textContent('#council-1'), /Second desk at City Hall/);
  assert.equal(await page.locator('#council-1 button', { hasText: 'Approve' }).count(), 0); // already approved by proposing
  assert.equal((await c.identity.issuers(desk)).active, false); // nothing happens yet
  await shot('7-council-proposed');

  // The second member (the automatic account) approves: the public wait starts.
  await page.click('#nav-account');
  await page.click('#btn-auto-wallet');
  await page.click('#nav-admin');
  // It is at the top, waiting on this member, with a link that jumps to it.
  await page.waitForSelector('#admin-todo a[data-goto="council-1"] >> text=Approve', { timeout: 60_000 });
  assert.match(await page.textContent('#admin-todo'), /Waiting on you \(1\)[\s\S]*Council change #1/);
  await page.waitForFunction(() => /^Admin \(1\)$/.test(document.querySelector('#nav-admin').textContent));
  assert.match(await page.textContent('#admin-menu'), /Council/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${process.env.APP_SCREENSHOT_DIR || '/tmp'}/7b-todo.png` }).catch(() => {});
  await page.click('#admin-todo a[data-goto="council-1"]');
  await page.waitForSelector('#council-1.flash');
  await page.click('#council-1 button:has-text("Approve")');
  await page.waitForSelector('#council-1 >> text=Waiting period', { timeout: 60_000 });
  assert.equal((await c.identity.issuers(desk)).active, false);

  // An hour later anyone can run it.
  await provider.send('evm_increaseTime', [3601]);
  await provider.send('evm_mine', []);
  // No refresh needed: when the wait runs out, the council section updates itself and shows the Run button.
  await page.waitForSelector('#council-1 button:has-text("Run it now")', { timeout: 90_000 });
  await page.waitForSelector('#admin-todo a[data-goto="council-1"] >> text=Run', { timeout: 30_000 });
  await page.click('#council-1 button:has-text("Run it now")');
  // Done items leave the open list; they are under "Done".
  await page.waitForSelector('#council-list [data-show="done"][aria-pressed="false"] >> text=Done (1)', { timeout: 60_000 });
  await page.click('#council-list [data-show="done"]');
  await page.waitForSelector('#council-1 >> text=Done', { timeout: 60_000 });
  assert.equal((await c.identity.issuers(desk)).name, 'Council desk');
  assert.equal((await c.identity.issuers(desk)).active, true);
  await shot('8-council-done');
  delete appConfig.councilAddress;
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
  // Back from the provider: a browser-saved key reopens by itself, with the result shown.
  await page.waitForSelector('#screen-home:not([hidden])', { timeout: 60_000 });
  await page.waitForFunction(() => /You joined as a basic member with Test Login/.test(document.querySelector('#home-notice')?.textContent || ''));
  assert.equal(new URL(page.url()).hash, ''); // notice consumed, address cleaned
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
  await page.click('#public-option summary');
  await page.click('#btn-public');
  await page.waitForSelector('#screen-home:not([hidden])');
  assert.match(await page.textContent('#signin-method'), /nothing is saved here/);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), before); // no keys, no remembered credential
  await page.click('#nav-account');
  await page.waitForSelector('#account-address + .copy-btn');
  await page.click('#btn-signout');
  assert.equal(await page.textContent('#voter-code'), ''); // nothing left on screen either
});

test('join with email: code by email, enrolled without leaving the page', async () => {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click('#device-option summary');
  await page.click('#btn-device');
  await page.waitForSelector('#join-online #join-email');
  await page.fill('#join-email', 'newcomer@proton.me');
  await page.click('#btn-email-send');
  await page.waitForFunction(() => /Code sent to n•••@proton.me/.test(document.querySelector('#email-status').textContent));
  await shot('7-email-code');
  await page.fill('#join-code', '000000' === mail.lastCodeFor('newcomer@proton.me') ? '111111' : '000000');
  await page.click('#btn-email-verify');
  await page.waitForFunction(() => /not right/.test(document.querySelector('#email-status').textContent));
  await page.fill('#join-code', mail.lastCodeFor('newcomer@proton.me'));
  await page.click('#btn-email-verify');
  await page.waitForFunction(() => /^Basic/.test(document.querySelector('#membership .big')?.textContent || ''), null, { timeout: 60_000 });
  assert.match(await page.textContent('#home-notice'), /joined as a basic member with your email/);
  // A basic member sees why they can't vote in a full-rights poll, instead of buttons that would fail.
  await page.click('#btn-refresh');
  await page.waitForSelector('#poll-1 >> text=Only residents with full voting rights can vote in this poll');
  assert.equal(await page.locator('#poll-1 button.choice').count(), 0);
});

test('newcomer: "Join with my email" makes the voter key and lands on the email box', async () => {
  await page.click('#btn-signout');
  await page.click('#btn-join-email');
  await page.waitForSelector('#screen-home:not([hidden])');
  await page.waitForFunction(() => /Step 2 of 2/.test(document.querySelector('#email-status')?.textContent || ''), null, { timeout: 30_000 });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'join-email');
  await shot('8-join-with-email');
});

test('no duplicate passkeys: creating again on a device that has one unlocks the existing key', async () => {
  const count = async () => (await cdpMain.send('WebAuthn.getCredentials', { authenticatorId: authIdMain })).credentials.length;
  await page.click('#btn-signout');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const before = await count();
  await page.click('#btn-join-email'); // first time on this browser: creates a passkey
  await page.waitForSelector('#screen-home:not([hidden])');
  assert.equal(await count(), before + 1);
  await page.click('[data-go="screen-code"]');
  const first = (await page.textContent('#voter-code')).trim();

  // Use a browser-saved key in between (this used to make the app forget the passkey).
  await page.click('#btn-signout');
  await page.click('#device-option summary').catch(() => {});
  await page.click('#btn-device');
  await page.waitForSelector('#screen-home:not([hidden])');

  for (const btn of ['#btn-join-email', '#btn-create']) {
    await page.click('#btn-signout');
    await page.click(btn);
    await page.waitForSelector('#screen-home:not([hidden])');
    await page.click('[data-go="screen-code"]');
    assert.equal((await page.textContent('#voter-code')).trim(), first, `${btn} reused the existing voter key`);
  }
  assert.equal(await count(), before + 1); // still just that one new passkey
});

test('a device that already has a voter key leads with "Welcome back", not "Join"', async () => {
  await page.click('#btn-signout');
  await page.reload();
  assert.equal(await page.isVisible('#welcome-back'), true);
  assert.equal(await page.isVisible('#new-here'), false);
  await page.click('#btn-welcome-unlock');
  await page.waitForSelector('#screen-home:not([hidden])');
});

test('shared computer, no smartphone: a written code works now and later, and nothing is saved', async () => {
  await page.click('#btn-signout');
  await page.reload();
  const before = await page.evaluate(() => JSON.stringify(localStorage));
  await page.click('#public-option summary');
  await page.click('#btn-public-code');
  await page.waitForSelector('#screen-home:not([hidden])');
  assert.match(await page.textContent('#backup-intro'), /only copy: nothing is saved on this computer/);
  assert.equal(await page.isVisible('#btn-print-code'), true);
  const code = (await page.textContent('#backup-code')).trim();
  assert.match(code, /^MV2-/);
  await page.click('[data-go="screen-code"]');
  const voter = (await page.textContent('#voter-code')).trim();
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), before); // nothing stored

  // Coming back another day: type the written code in, same voter, still nothing stored.
  await page.click('#btn-signout');
  await page.reload();
  await page.click('#public-option summary');
  await page.fill('#public-code', code);
  await page.click('#btn-public-restore');
  await page.waitForSelector('#screen-home:not([hidden])');
  await page.click('[data-go="screen-code"]');
  assert.equal((await page.textContent('#voter-code')).trim(), voter);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), before);
  assert.match(await page.textContent('#signin-method'), /nothing is saved here/);
  await page.click('#btn-signout');
});

test('shared computer, new person with a phone: the passkey is made without being remembered here', async () => {
  await page.reload();
  const before = await page.evaluate(() => JSON.stringify(localStorage));
  // A roaming (external) authenticator stands in for the person's phone.
  const { authenticatorId: phone } = await cdpMain.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });
  try {
    await page.click('#public-option summary');
    await page.click('#btn-public-new');
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.match(await page.textContent('#signin-method'), /nothing is saved here/);
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), before);
    const onPhone = (await cdpMain.send('WebAuthn.getCredentials', { authenticatorId: phone })).credentials.length;
    assert.equal(onPhone, 1); // created on the "phone", not on this computer
    await page.click('#btn-signout');
  } finally {
    await cdpMain.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: phone });
  }
});

test('public dashboard: voter list, polls with counts, clerks and watchdog alerts, without signing in', async () => {
  const now = Math.floor(Date.now() / 1000);
  appIpfs['alerts.json'] = JSON.stringify([
    { severity: 'info', rule: 'poll-opened', title: 'Poll 1 opened', time: now - 7200, tx: '0x' + '1'.repeat(64) },
    { severity: 'high', rule: 'role-change', title: 'ADMIN role granted to 0xabc…1234 on voting', time: now - 600, tx: '0x' + '2'.repeat(64) },
  ]);
  appConfig.watchdogAlertsUrl = `${appUrl}ipfs/alerts.json`;
  const dash = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  dash.on('pageerror', (e) => errors.push(e.message));
  await dash.goto(`${appUrl}dashboard.html`);
  await dash.waitForSelector('#tiles .tile', { timeout: 60_000 });
  const tiles = await dash.textContent('#tiles');
  const members = Number((await dash.textContent('#tiles .tile .n')).replace(/,/g, ''));
  assert.ok(members >= 5, tiles); // the voters enrolled by earlier tests
  assert.match(tiles, /1\s*urgent watchdog alerts/);
  await dash.waitForSelector('#dash-poll-1 >> text=Publish the FY2027 line-item budget?');
  assert.match(await dash.textContent('#dash-poll-1'), /Yes\s*1 · 100%/);
  assert.match(await dash.textContent('#dash-poll-1'), /1 of 3 eligible voted \(33% turnout\)/);
  assert.match(await dash.textContent('#sources'), /Example City Clerk/);
  assert.match(await dash.textContent('#mandates'), /No mandates yet/);
  // Urgent-only filter.
  assert.equal(await dash.locator('#alerts .alert').count(), 2);
  await dash.click('#alert-filters button[data-sev="high"]');
  assert.equal(await dash.locator('#alerts .alert').count(), 1);
  assert.match(await dash.textContent('#alerts'), /▲ Urgent.*ADMIN role granted/s);
  // Fits a phone screen: no sideways scrolling.
  assert.ok(await dash.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await dash.screenshot({ path: process.env.APP_SCREENSHOT_DIR ? `${process.env.APP_SCREENSHOT_DIR}/9-dashboard.png` : require('node:os').tmpdir() + '/dash.png', fullPage: true });
  assert.deepEqual(errors, []);
  await dash.close();
});

test('mandate lifecycle: binding poll, vote, mandate, budget, evidence, verification, payout', async () => {
  page.removeAllListeners('dialog');
  await page.goto(appUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click('#device-option summary');
  await page.click('#btn-device');
  await page.waitForSelector('#screen-home:not([hidden])');
  await page.click('[data-go="screen-code"]');
  const voter = BigInt((await page.textContent('#voter-code')).trim());
  await page.click('#nav-account');
  const me = ethers.getAddress((await page.textContent('#account-address')).trim());

  // Setup by the (test) admins: this person can open polls, has fee money and is on the voter list;
  // the admin is an independent verifier, so mandates can be checked.
  await (await admin.sendTransaction({ to: me, value: ethers.parseEther('2') })).wait();
  await (await c.vote.grantRole(await c.vote.PROPOSER_ROLE(), me)).wait();
  await (await c.registry.grantRole(await c.registry.VERIFIER_ROLE(), admin.address)).wait();
  const longAgo = (await provider.getBlock('latest')).timestamp - 3 * 365 * DAY;
  await (await c.identity.connect(clerk).enroll(voter, 1, docHash('DL-lifecycle'), longAgo)).wait();

  // A binding poll, written in the app: if Yes wins, this person must get it done within 30 days.
  await page.click('#nav-polls');
  await page.waitForSelector('#nav-admin:not([hidden])');
  await page.click('#nav-admin');
  await page.fill('#poll-title', 'Fix the Elm Street crossing');
  await page.fill('#poll-body', 'Raised crossing with flashing lights, done within 30 days.');
  await page.selectOption('#poll-kind', '2');
  await page.fill('#poll-responsible', me);
  await page.fill('#poll-mdays', '30');
  await page.fill('#poll-checks', '1');
  await page.selectOption('#poll-group', '0');
  await page.fill('#poll-days', '0.01');
  await page.fill('#poll-quorum', '1');
  await page.click('#btn-open-poll');
  await page.waitForFunction(() => /Open poll: done/.test(document.querySelector('#poll-status').textContent), null, { timeout: 60_000 });
  const pollId = await c.vote.pollCount();
  const poll = await c.vote.getPoll(pollId);
  assert.match(poll.questionCID, /^nb:0x[0-9a-f]{64}$/);
  assert.match(await c.notices.read(poll.questionCID.slice(3)), /Fix the Elm Street crossing/);

  // Vote Yes privately, then once voting ends anyone can record the result: the mandate is created.
  await page.click('#nav-polls');
  await page.waitForSelector(`#poll-${pollId} >> text=Binding.`);
  assert.match(await page.textContent(`#poll-${pollId}`), /is responsible for doing it within 30 days, and 1 independent verifier must confirm/);
  await page.click(`#poll-${pollId} button.choice >> text=Yes`);
  await page.waitForFunction((id) => /Your vote is recorded/.test(document.querySelector(`#poll-status-${id}`).textContent), pollId.toString(), { timeout: 120_000 });
  await provider.send('evm_increaseTime', [3600]);
  await provider.send('evm_mine', []);
  await page.click('#btn-refresh');
  await page.click(`#poll-${pollId} button.finalize`);
  await page.waitForFunction(() => (document.querySelector('#poll-list')?.textContent || '').includes('Closed · passed'), null, { timeout: 60_000 });
  assert.equal(await c.registry.mandateCount(), 1n);

  // Mandates screen: the goal, then back it with 0.5 ETH (its escrow is created on the way).
  await page.click('#nav-mandates');
  await page.waitForSelector('#mandate-1 >> text=Fix the Elm Street crossing');
  assert.match(await page.textContent('#mandate-1'), /nobody has backed it yet/);
  await page.fill('#back-1', '0.5');
  await page.click('#mandate-1 button[data-act="back"]');
  await page.waitForFunction(() => /Back this mandate: done/.test(document.querySelector('#mandate-status-1')?.textContent || ''), null, { timeout: 60_000 });
  const escrow = new ethers.Contract(await c.escrows.escrowOf(1), ['function lockedBalance() view returns (uint256)', 'function settlement() view returns (uint8)'], provider);
  assert.equal(await escrow.lockedBalance(), ethers.parseEther('0.5'));
  assert.match(await page.textContent('#mandate-1'), /0\.5 ETH held/);

  // The responsible party (this person) submits evidence; the verifier approves; the budget is paid out.
  await page.fill('#evidence-1', 'Installed on 3 March. Photos: example.org/elm');
  await page.click('#mandate-1 button[data-act="evidence"]');
  await page.waitForSelector('#mandate-1 >> text=Evidence under review', { timeout: 60_000 });
  assert.match(await page.textContent('#mandate-1'), /Installed on 3 March/);
  await (await c.registry.attest(1, true, '')).wait();
  await page.click('#btn-mandates-refresh');
  await page.waitForSelector('#mandate-1 button[data-act="release"]');
  const before = await provider.getBalance(me);
  await page.click('#mandate-1 button[data-act="release"]');
  await page.waitForFunction(() => /Pay the budget: done/.test(document.querySelector('#mandate-status-1')?.textContent || ''), null, { timeout: 60_000 });
  assert.equal(await escrow.lockedBalance(), 0n);
  assert.ok((await provider.getBalance(me)) - before > ethers.parseEther('0.49'));
  assert.match(await page.textContent('#mandate-1'), /Done and verified/);
  await shot('10-mandate-paid');

  // As a verifier in the app: approve someone else's evidence, with published reasons.
  await (await c.registry.grantRole(await c.registry.VERIFIER_ROLE(), me)).wait();
  await (await c.registry.grantRole(await c.registry.GOVERNOR_ROLE(), admin.address)).wait();
  const now = (await provider.getBlock('latest')).timestamp;
  await (await c.notices.post(JSON.stringify({ title: 'Publish bus timetables as open data', body: '' }))).wait();
  const spec = 'nb:' + ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ title: 'Publish bus timetables as open data', body: '' })));
  await (await c.registry.createMandate(admin.address, now + 30 * DAY, 1, ethers.id('general'), spec)).wait();
  await (await c.registry.submitEvidence(2, spec)).wait();
  await page.click('#btn-mandates-refresh');
  await page.waitForSelector('#mandate-2 button[data-act="approve"]');
  assert.equal(await page.locator('#mandate-1 button[data-act="approve"]').count(), 0); // can't check your own
  await page.fill('#reason-2', 'Files are live at example.org/gtfs and match the published schedule.');
  await page.click('#mandate-2 button[data-act="approve"]');
  await page.waitForFunction(() => /Approve: done/.test(document.querySelector('#mandate-status-2')?.textContent || ''), null, { timeout: 60_000 });
  assert.equal((await c.registry.getMandate(2)).status, 3n);
});

test('voter-roll city: the desk enrolls by voter registration record, no photo ID', async () => {
  // The person from the previous test becomes a clerk; the city switches its anchor to the voter roll.
  await page.click('#nav-account');
  const me = ethers.getAddress((await page.textContent('#account-address')).trim());
  await (await c.identity.setIssuer(me, 1, true, 'Precinct 4 desk')).wait();
  appConfig.clerkAnchor = 'roll';
  await page.reload();
  await page.click('#btn-device');
  await page.waitForSelector('#screen-home:not([hidden])');
  await page.waitForSelector('#nav-clerk:not([hidden])');
  await page.click('#nav-clerk');
  await page.click('#btn-clerk-open');
  await page.waitForSelector('#clerk-steps:not([hidden])');
  const person = new Identity('no-photo-id');
  await page.fill('#clerk-code', person.commitment.toString());
  await page.click('#btn-clerk-lookup');
  await page.waitForSelector('#clerk-person >> text=Not on the voter list yet');
  assert.equal((await page.textContent('#clerk-id-title')).trim(), '2. Find them in the voter roll');
  assert.match(await page.textContent('#clerk-checklist'), /No photo ID is needed/);
  assert.equal(await page.isVisible('#clerk-doc-kind'), false); // only one kind of record in this city
  assert.equal(await page.inputValue('#clerk-doc-kind'), 'roll');
  await page.fill('#clerk-doc-region', 'OR');
  await page.fill('#clerk-doc-number', '000-555-123');
  await page.selectOption('#clerk-residence', 'roll');
  await page.fill('#clerk-since', '2012-03');
  await page.click('#btn-clerk-submit');
  await page.waitForFunction(() => /Done: enrolled/.test(document.querySelector('#clerk-result').textContent), null, { timeout: 60_000 });
  assert.equal((await c.identity.members(person.commitment)).tier, 2n);

  // The same registration can't back a second code.
  await page.click('#btn-clerk-next');
  const again = new Identity('no-photo-id-again');
  await page.fill('#clerk-code', again.commitment.toString());
  await page.click('#btn-clerk-lookup');
  await page.waitForSelector('#clerk-person >> text=Not on the voter list yet');
  await page.fill('#clerk-doc-region', 'or');
  await page.fill('#clerk-doc-number', '000555123');
  await page.selectOption('#clerk-residence', 'utility');
  await page.check('#clerk-new-resident');
  await page.click('#btn-clerk-submit');
  await page.waitForFunction(() => /already linked to another voter code/.test(document.querySelector('#clerk-result').textContent), null, { timeout: 30_000 });
  delete appConfig.clerkAnchor;
});

test('cross-checked poll: online sign-ups outvote ID-checked residents, so the result is held as contested', async () => {
  process.env.SEMAPHORE_ARTIFACTS_DIR ||= require('node:path').dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json'));
  const { buildBallot } = require('../client/ballot');
  // Two people who only signed up online; this person (ID-checked, full rights) is the third voter.
  const online = [new Identity('online-a'), new Identity('online-b')];
  const signup = await provider.getSigner(3); // the online sign-up service
  for (const [i, o] of online.entries()) await (await c.identity.connect(signup).enroll(o.commitment, 0, docHash(`acct-x${i}`), 0)).wait();

  await page.click('#nav-admin');
  await page.fill('#poll-title', 'Rename Central Park after the founder?');
  await page.selectOption('#poll-kind', '0');
  await page.selectOption('#poll-group', '0');
  await page.selectOption('#poll-check', '1');
  await page.fill('#poll-check-min', '1');
  await page.fill('#poll-days', '0.01');
  await page.fill('#poll-quorum', '2');
  await page.click('#btn-open-poll');
  await page.waitForFunction(() => /Open poll: done/.test(document.querySelector('#poll-status').textContent), null, { timeout: 60_000 });
  const pollId = await c.vote.pollCount();

  // This ID-checked person votes No in the app; the ballot proves the stricter list, so it counts in both tallies.
  await page.click('#nav-polls');
  await page.waitForSelector(`#poll-${pollId} >> text=Cross-checked.`);
  await page.click(`#poll-${pollId} button.choice >> text=No`);
  await page.waitForFunction((id) => /Your vote is recorded/.test(document.querySelector(`#poll-status-${id}`).textContent), pollId.toString(), { timeout: 120_000 });
  // The two online-only members vote Yes (anyone may submit a ballot; no wallet needed).
  for (const o of online) await (await c.vote.castBallot(pollId, await buildBallot({ provider, vote: c.vote, pollId, identity: o, option: 0 }))).wait();
  assert.deepEqual((await c.vote.tally(pollId)).map(Number), [2, 1]);
  assert.deepEqual((await c.vote.getCheck(pollId))[1].map(Number), [0, 1]);

  await provider.send('evm_increaseTime', [3600]);
  await provider.send('evm_mine', []);
  await page.click('#btn-refresh');
  await page.click(`#poll-${pollId} button.finalize`);
  await page.waitForSelector(`#poll-${pollId} >> text=Closed · contested`, { timeout: 60_000 });
  assert.match(await page.textContent(`#poll-${pollId}`), /Contested\. ID-checked voters chose the other side/);
  assert.equal((await c.vote.getPoll(pollId)).passed, false);
  await shot('11-contested');
});

test('rules: the community changes its own voting rules by vote, within the charter\'s limits', async () => {
  await page.click('#nav-rules');
  await page.waitForSelector('#rules-list >> text=Shortest time a poll stays open');
  assert.match(await page.textContent('#rules-list'), /How much an ID-checked vote counts in a cross-checked poll\s*1×/);

  // A rule-change poll, written in the app: make ID-checked votes count 1.5×.
  await page.click('#nav-admin');
  await page.fill('#poll-title', 'Make ID-checked votes count 1.5 times in cross-checked polls?');
  await page.selectOption('#poll-kind', '4');
  await page.waitForSelector('#poll-rule-key option', { state: 'attached' });
  await page.selectOption('#poll-rule-key', ethers.id('VERIFIED_WEIGHT_PCT'));
  assert.match(await page.textContent('#poll-rule-hint'), /Allowed: 1× to 3×/);
  await page.fill('#poll-rule-value', '500');
  await page.click('#btn-open-poll');
  await page.waitForFunction(() => /outside the charter's limits/.test(document.querySelector('#poll-status').textContent));
  await page.fill('#poll-rule-value', '150');
  await page.selectOption('#poll-group', '2');
  assert.equal(await page.isHidden('#poll-check-box'), true); // nothing stricter than full voting rights
  await page.fill('#poll-days', '0.5'); // the rules say rule changes stay open at least a day
  await page.click('#btn-open-poll');
  await page.waitForFunction(() => /shorter than the community's rules allow/.test(document.querySelector('#poll-status').textContent), null, { timeout: 60_000 });
  assert.equal(await page.inputValue('#poll-title'), 'Make ID-checked votes count 1.5 times in cross-checked polls?'); // nothing was published or cleared
  await page.fill('#poll-days', '1');
  await page.fill('#poll-quorum', '1');
  await page.click('#btn-open-poll');
  await page.waitForFunction(() => /Open poll: done/.test(document.querySelector('#poll-status').textContent), null, { timeout: 60_000 });
  const pollId = await c.vote.pollCount();

  await page.click('#nav-polls');
  await page.waitForSelector(`#poll-${pollId} >> text=Rule change.`);
  assert.match(await page.textContent(`#poll-${pollId}`), /change "How much an ID-checked vote counts in a cross-checked poll" from 1× to 1\.5×/);
  await page.click(`#poll-${pollId} button.choice >> text=Yes`);
  await page.waitForFunction((id) => /Your vote is recorded/.test(document.querySelector(`#poll-status-${id}`).textContent), pollId.toString(), { timeout: 120_000 });
  await provider.send('evm_increaseTime', [DAY + 60]);
  await provider.send('evm_mine', []);
  await page.click('#btn-refresh');
  await page.click(`#poll-${pollId} button.finalize`);
  await page.waitForSelector(`#poll-${pollId} >> text=Closed · passed`, { timeout: 60_000 });
  assert.equal(await c.charter.rule(ethers.id('VERIFIED_WEIGHT_PCT')), 150n);
  await page.click('#nav-rules');
  await page.waitForSelector('#rules-list >> text=1.5×');
  await shot('12-rules');
});

test('voter-roll lookup at the desk: found by name, birth date and address, enrolled without typing a registration number', async () => {
  appConfig.clerkAnchor = 'roll';
  await page.reload();
  await page.click('#btn-device');
  await page.waitForSelector('#screen-home:not([hidden])');
  await page.waitForSelector('#nav-clerk:not([hidden])');
  await page.click('#nav-clerk');
  await page.click('#btn-clerk-open');
  await page.waitForSelector('#clerk-steps:not([hidden])');
  const maria = new Identity('maria-at-the-desk');
  await page.fill('#clerk-code', maria.commitment.toString());
  await page.click('#btn-clerk-lookup');
  await page.waitForSelector('#clerk-person >> text=Not on the voter list yet');
  await page.waitForSelector('#clerk-roll:not([hidden])');
  assert.match(await page.textContent('#clerk-roll-intro'), /OR voter roll \(2 records\)\. A match is all you need/);

  // Not found first (wrong ZIP), then found with a nickname-free first name and half of the double surname.
  await page.fill('#clerk-roll-first', 'Maria');
  await page.fill('#clerk-roll-last', 'Brown');
  await page.fill('#clerk-roll-dob', '1975-06-30');
  await page.fill('#clerk-roll-house', '88');
  await page.fill('#clerk-roll-zip', '97999');
  await page.click('#btn-clerk-roll');
  await page.waitForSelector('#clerk-roll-status >> text=Not found in the voter roll');
  await page.fill('#clerk-roll-zip', '97205');
  await page.click('#btn-clerk-roll');
  await page.waitForSelector('#clerk-roll-status >> text=registration ending 001');
  assert.equal(await page.isVisible('#clerk-manual'), false); // nothing to type
  assert.equal(await page.inputValue('#clerk-roll-last'), ''); // details wiped once matched
  assert.equal(await page.inputValue('#clerk-residence'), 'roll');
  await page.fill('#clerk-since', '2001-09');
  await page.click('#btn-clerk-submit');
  await page.waitForFunction(() => /Done: enrolled/.test(document.querySelector('#clerk-result').textContent), null, { timeout: 60_000 });
  assert.equal((await c.identity.members(maria.commitment)).tier, 2n);

  // The same registration can't back a second code, however it is entered.
  await page.click('#btn-clerk-next');
  const again = new Identity('maria-second-phone');
  await page.fill('#clerk-code', again.commitment.toString());
  await page.click('#btn-clerk-lookup');
  await page.waitForSelector('#clerk-person >> text=Not on the voter list yet');
  await page.fill('#clerk-roll-first', 'Maria');
  await page.fill('#clerk-roll-last', 'Okafor-Brown');
  await page.fill('#clerk-roll-dob', '1975-06-30');
  await page.fill('#clerk-roll-zip', '97205');
  await page.click('#btn-clerk-roll');
  await page.waitForSelector('#clerk-roll-status >> text=already linked to another voter code');
  await shot('13-roll-lookup');
  delete appConfig.clerkAnchor;
});

test('civic budget: open a round, spread credits quadratically and privately, fund the most-backed projects', async () => {
  process.env.SEMAPHORE_ARTIFACTS_DIR ||= require('node:path').dirname(require.resolve('@zk-kit/semaphore-artifacts/package.json'));
  const { buildAllocation } = require('../client/budget');
  await page.click('#nav-account');
  const me = ethers.getAddress((await page.textContent('#account-address')).trim());
  await (await c.budget.grantRole(await c.budget.PROPOSER_ROLE(), me)).wait();
  await page.click('#nav-polls'); // refresh roles
  await page.waitForSelector('#nav-admin:not([hidden])');
  await page.click('#nav-admin');
  await page.waitForSelector('#admin-budget:not([hidden])');
  await page.fill('#round-title', 'Neighbourhood projects');
  await page.fill('#round-proposals', 'Repave Oak Street | 50000\nLibrary Sunday hours | $30k\nNew playground | 40,000');
  await page.fill('#round-budget', '80000');
  await page.fill('#round-credits', '9');
  await page.fill('#round-days', '0.01');
  await page.selectOption('#round-group', '2');
  await page.click('#btn-open-round');
  await page.waitForFunction(() => /Open budget round: done/.test(document.querySelector('#round-status').textContent), null, { timeout: 60_000 });
  const id = await c.budget.roundCount();
  const [, costs] = await c.budget.getProposals(id);
  assert.deepEqual(costs.map(Number), [50_000, 30_000, 40_000]);

  // Two neighbours (ID-checked residents enrolled in earlier tests) take part without the app.
  for (const [who, votes] of [[new Identity('n1'), [0, 2, 2]], [new Identity('n2'), [0, 3, 0]]]) {
    await (await c.budget.allocate(id, await buildAllocation({ provider, budget: c.budget, roundId: id, identity: who, votes }))).wait();
  }

  await page.click('#nav-budget');
  await page.waitForSelector(`#round-${id} >> text=Neighbourhood projects`);
  const plus = (i) => page.click(`#round-${id} .budget-row[data-i="${i}"] button[data-step="1"]`);
  await plus(0);
  await plus(0);
  assert.equal((await page.textContent(`#credits-${id}`)).trim(), '4 of 9 credits used');
  await plus(0);
  assert.equal((await page.textContent(`#credits-${id}`)).trim(), '9 of 9 credits used');
  await plus(1); // would cost 10
  assert.match(await page.textContent(`#round-status-${id}`), /would cost 10 credits; you have 9/);
  await page.click(`#round-${id} button[data-act="allocate"]`);
  await page.waitForSelector(`#round-${id} >> text=Your choices are recorded.`, { timeout: 120_000 });
  assert.equal(await page.locator(`#round-${id} button[data-step]`).count(), 0);
  const [, , votes] = await c.budget.getProposals(id);
  assert.deepEqual(votes.map(Number), [3, 5, 2]);

  await provider.send('evm_increaseTime', [3600]);
  await provider.send('evm_mine', []);
  await page.click('#nav-budget');
  await page.click(`#round-${id} button[data-act="count"]`);
  await page.waitForSelector(`#round-${id} >> text=$80,000 of $80,000 allocated`, { timeout: 60_000 });
  // Library (5 votes, 30k) then Oak (3, 50k) fill the budget; the playground (2) doesn't fit.
  assert.match(await page.textContent(`#round-${id} .budget-row[data-i="1"]`), /✓ funded/);
  assert.match(await page.textContent(`#round-${id} .budget-row[data-i="0"]`), /✓ funded/);
  assert.match(await page.textContent(`#round-${id} .budget-row[data-i="2"]`), /not funded/);
  await shot('14-budget');
});

test('verify by mail: a newcomer matches their voter registration and confirms the code from the letter', async () => {
  appConfig.clerkAnchor = 'roll';
  // The council has approved the sign-in service for ID checks (here: the test admin does it directly).
  await (await c.identity.setIssuer((await provider.getSigner(3)).address, 1, true, 'Online sign-up')).wait();
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click('#device-option summary');
  await page.click('#btn-device');
  await page.waitForSelector('#screen-home:not([hidden])');
  await page.waitForSelector('#mail-option');
  await page.click('#mail-option summary');
  await page.fill('#mail-first', 'Sam');
  await page.fill('#mail-last', 'Lee');
  await page.fill('#mail-dob', '1990-02-14');
  await page.fill('#mail-street', '12 Oak Avenue');
  await page.fill('#mail-city', 'Portland');
  await page.fill('#mail-state', 'OR');
  await page.fill('#mail-zip', '97206');
  await page.click('#btn-mail-send');
  await page.waitForSelector('#mail-status >> text=Letter on its way', { timeout: 60_000 });
  const letter = postbox.outbox.at(-1);
  assert.deepEqual([letter.to.name, letter.to.address_line1, letter.to.address_zip], ['Sam Lee', '12 Oak Avenue', '97206']);

  // Days later: the code from the letter.
  await page.fill('#mail-code', 'NOTRIGHT');
  await page.click('#btn-mail-verify');
  await page.waitForSelector('#mail-status >> text=That code is not right');
  await page.fill('#mail-code', letter.code);
  await page.click('#btn-mail-verify');
  await page.waitForSelector('#mail-status >> text=you are now an ID-checked resident', { timeout: 60_000 });
  await page.waitForFunction(() => /Verified resident|full voting rights/i.test(document.querySelector('#membership .big')?.textContent || ''), null, { timeout: 30_000 });
  await shot('15-verified-by-mail');
  delete appConfig.clerkAnchor;
});

test('residents speak between votes: comments, a petition that opens its own poll, and an outcome rating', async () => {
  // The resident verified by mail in the previous test (ID-checked) is still signed in.
  await page.click('#nav-polls');
  await page.waitForSelector('#poll-1 .thread-box summary');
  await page.click('#poll-1 .thread-box summary');
  await page.fill('#c-poll-1', 'Please publish the spreadsheet in an open format too.');
  await page.click('#poll-1 .thread-box button[data-post]');
  await page.waitForSelector('#poll-1 .thread-box >> text=Please publish the spreadsheet in an open format too.', { timeout: 120_000 });
  assert.match(await page.textContent('#poll-1 .thread-box'), /Comments \(1\)/);
  assert.match(await page.textContent('#poll-1 .thread-box .comment'), /ID-checked resident/);

  // A petition: once it has enough signatures, its poll opens by itself.
  await page.click('#nav-petitions');
  await page.click('#screen-petitions details summary');
  await page.selectOption('#petition-kind', '0');
  await page.fill('#petition-title', 'Should the library open on Sundays?');
  await page.selectOption('#petition-tier', '1');
  await page.click('#btn-petition');
  await page.waitForSelector('#petition-status >> text=Petition started', { timeout: 60_000 });
  const pid = await c.feedback.petitionCount();
  const before = await c.vote.pollCount();
  await page.click(`#petition-${pid} button[data-sign]`);
  await page.waitForSelector(`#petition-${pid} >> text=opened by itself`, { timeout: 120_000 });
  assert.equal(await c.vote.pollCount(), before + 1n);
  assert.match(await page.textContent(`#petition-${pid}`), /1 of 1/);

  // Rate the finished Elm Street mandate.
  await page.click('#nav-mandates');
  await page.waitForSelector('#mandate-1 .rating-box button[data-score="4"]');
  await page.click('#mandate-1 .rating-box button[data-score="4"]');
  await page.waitForSelector('#mandate-1 .rating-box >> text=4.0 of 5 from 1 resident', { timeout: 120_000 });
  await shot('16-feedback');
});

test('most requested petitions are ranked, and times count down live', async () => {
  await page.reload(); // the test chain's clock jumped ahead; a fresh visit reads it again
  await page.click('#btn-device');
  await page.waitForSelector('#screen-home:not([hidden])');
  await page.click('#nav-petitions');
  if (!(await page.$eval('#screen-petitions details', (d) => d.open))) await page.click('#screen-petitions details summary');
  await page.selectOption('#petition-kind', '0');
  await page.fill('#petition-title', 'Add a crosswalk on Main Street');
  await page.selectOption('#petition-category', 'roads');
  await page.selectOption('#petition-tier', '1');
  await page.click('#btn-petition');
  await page.waitForSelector('#petition-status >> text=Petition started', { timeout: 60_000 });
  const pid = await c.feedback.petitionCount();
  await page.waitForSelector(`#petition-${pid} >> text=#1 most requested`, { timeout: 60_000 });
  assert.match(await page.textContent(`#petition-${pid}`), /started (just now|\d+s ago|\d+m)/);
  assert.match(await page.textContent(`#petition-${pid} h3`), /Roads and transport/);
  await page.click('#petition-sort-new');
  await page.waitForSelector('#petition-sort-new[aria-pressed="true"]');
  await page.selectOption('#petition-filter', 'health');
  await page.waitForSelector('#petition-list >> text=No petitions on this topic yet');
  await page.selectOption('#petition-filter', 'roads');
  await page.waitForSelector(`#petition-${pid}`);

  // Home: one list of everything open, ranked by urgency and importance, filterable by topic.
  await page.click('#nav-polls');
  await page.waitForSelector('#attention li', { timeout: 60_000 });
  const attn = await page.textContent('#attention');
  assert.match(attn, /(Urgent|Soon|Upcoming)/, attn);
  const levels = await page.$$eval('#attention li', (lis) => lis.map((li) => li.className));
  const rank = { 'attn urgent': 0, 'attn soon': 1, 'attn upcoming': 2 };
  assert.deepEqual([...levels].sort((a, b) => rank[a] - rank[b]), levels, 'more urgent items come first');
  await page.waitForSelector('#attention-filters button[data-cat="all"][aria-pressed="true"]');

  // Countdown alerts: follow an item, put it on the calendar with alerts, and get an alert in the app.
  await page.click('#attention li:first-child [data-follow]');
  await page.waitForSelector('#attention li:first-child [data-follow][aria-pressed="true"]');
  const href = await page.getAttribute('#attention li:first-child a[download]', 'href');
  const ics = decodeURIComponent(href.replace(/^data:text\/calendar;charset=utf-8,/, ''));
  assert.match(ics, /TRIGGER;RELATED=END:-P1D[\s\S]*TRIGGER;RELATED=END:-PT8H[\s\S]*TRIGGER;RELATED=END:-PT1H/);
  await page.click('#attention-card details:has(#reminder-settings) summary');
  await page.click('#reminder-settings [data-off="604800"]'); // add "1 week before"
  await page.waitForSelector('#reminder-settings [data-off="604800"][aria-pressed="true"]');
  await page.selectOption('#remind-scope', 'all');
  await page.click('#btn-refresh');
  await page.waitForSelector('#toasts .toast', { timeout: 60_000 });
  assert.match(await page.textContent('#toasts .toast'), /left: /);
  await shot('18-attention');
  for (const b of await page.$$('#toasts .toast button')) await b.click();

  const dash = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  dash.on('pageerror', (e) => errors.push(e.message));
  await dash.goto(`${appUrl}dashboard.html`);
  await dash.waitForSelector('#requested li', { timeout: 60_000 });
  await dash.waitForSelector('#attention li', { timeout: 60_000 });
  assert.match(await dash.textContent('#requested'), /Roads and transport/);
  assert.match(await dash.textContent('#requested'), /#1 · Petition \d+[\s\S]*Add a crosswalk on Main Street/);
  const first = await dash.textContent('#requested .countdown');
  await dash.waitForFunction((t) => document.querySelector('#requested .countdown').textContent !== t, first, { timeout: 5000 });
  assert.deepEqual(errors, []);
  await dash.close();
});

test('photos and documents: take, scan, AI reads them, fingerprints check out, takedowns hide them', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGM4YaNBEmIY1TCqYfhqAAAeBCwQMwPSngAAAABJRU5ErkJggg==', 'base64');
  await page.click('#nav-petitions');
  if (!(await page.$eval('#screen-petitions details', (d) => d.open))) await page.click('#screen-petitions details summary');
  await page.fill('#petition-title', 'Fix the pothole on Elm Street');
  await page.waitForSelector('#petition-attach [data-pick="library"]', { state: 'attached', timeout: 30_000 });
  await page.setInputFiles('#petition-attach [data-pick="library"]', { name: 'pothole.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('#petition-attach .attach-list li', { timeout: 120_000 });
  assert.equal(await page.inputValue('#petition-attach [data-alt="0"]'), 'A deep pothole on Elm Street'); // AI wrote the description
  assert.match(await page.textContent('#petition-attach'), /AI noticed private details: a car licence plate/);
  // A two-page scan becomes one PDF.
  await page.setInputFiles('#petition-attach [data-pick="scan"]', { name: 'p1.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('#petition-attach >> text=1 page scanned');
  await page.setInputFiles('#petition-attach p.note [data-pick="scan"]', { name: 'p2.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('#petition-attach >> text=2 pages scanned');
  await page.click('#petition-attach [data-done]');
  await page.waitForSelector('#petition-attach .attach-list li:nth-child(2) >> text=scan-2-pages.pdf', { timeout: 120_000 });
  await page.click('#btn-petition');
  await page.waitForSelector('#petition-status >> text=Petition started', { timeout: 60_000 });
  const pid = await c.feedback.petitionCount();
  await page.waitForSelector(`#petition-${pid} .attachments img[alt="A deep pothole on Elm Street"]`, { timeout: 60_000 });
  const rec = JSON.parse(await c.notices.read((await c.feedback.getPetition(pid)).ref.slice(3)));
  assert.equal(rec.attachments?.length, 2, JSON.stringify(rec.attachments?.map((x) => [x.name, x.type, x.cid])));
  assert.match(await page.textContent(`#petition-${pid} .attachments`), /scan-2-pages\.pdf/);
  await page.click(`#petition-${pid} .attachments [data-check] >> nth=0`);
  await page.waitForSelector(`#petition-${pid} >> text=Matches its fingerprint on the public record`, { timeout: 30_000 });
  // The published document carries each file's fingerprint and what AI read.
  const doc = JSON.parse(await c.notices.read((await c.feedback.getPetition(pid)).ref.slice(3)));
  assert.equal(doc.attachments.length, 2);
  assert.match(doc.attachments[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(doc.attachments[1].type, 'application/pdf');
  assert.equal(doc.attachments[0].ai.summary, 'A photo of a pothole next to a street sign.');
  // A takedown: the file stops being served, and the app says so.
  const res = await fetch(`${appConfig.identityService}/upload/remove`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer takedown-token' }, body: JSON.stringify({ cid: doc.attachments[0].cid, reason: 'licence plate' }) });
  assert.equal(res.status, 200);
  await page.reload();
  await page.click('#btn-device');
  await page.waitForSelector('#screen-home:not([hidden])');
  await page.click('#nav-petitions');
  await page.waitForSelector(`#petition-${pid} >> text=A file here was taken down`, { timeout: 60_000 });
  await shot('19-attachments');
});

test('government bodies: set up from a template, public agenda with notice, roll-call vote, on the dashboard', async () => {
  await page.click('#nav-account');
  const auto = ethers.getAddress((await page.textContent('#account-address')).trim());
  await (await c.bodies.grantRole(await c.bodies.REGISTRAR_ROLE(), auto)).wait();
  await (await admin.sendTransaction({ to: auto, value: ethers.parseEther('1') })).wait();

  // A registrar sets up a city council from the template, with a shorter notice for the test.
  await page.click('#nav-polls');
  await page.waitForSelector('#nav-admin:not([hidden])', { timeout: 60_000 });
  await page.click('#nav-admin');
  await page.waitForSelector('#admin-bodies:not([hidden])', { timeout: 60_000 });

  // A whole organization from a template: a state gets a House and a Senate, in that order.
  await page.click('#org-setup summary');
  await page.selectOption('#org-type', 'state');
  await page.fill('#org-name', 'Example State');
  const plan = await page.textContent('#org-bodies');
  assert.match(plan, /Example State House of Representatives[\s\S]*Then: Example State Senate[\s\S]*Example State Senate[\s\S]*Governor's account/);
  assert.match(await page.textContent('#org-rules'), /Signatures that force a vote/);
  const before = await c.bodies.bodyCount();
  await page.click('#btn-org-create');
  await page.waitForFunction((q) => /Created|failed/.test(document.querySelector(q).textContent), '#org-status', { timeout: 120_000 });
  assert.match(await page.textContent('#org-status'), /Created Example State House of Representatives, Example State Senate/);
  assert.equal(await c.bodies.bodyCount(), before + 2n);
  const senateId = before + 2n;
  const [senate] = await c.bodies.getBody(senateId);
  assert.deepEqual([senate.name, Number(senate.seats), senate.passOfSeats], ['Example State Senate', 40, true]);

  await page.selectOption('#body-template', 'city');
  assert.equal(await page.inputValue('#body-seats'), '7');
  await page.fill('#body-name', 'Example City Council');
  await page.fill('#body-notice', '0.5');
  await page.fill('#body-vote', '1');
  await page.click('#btn-body-save');
  await page.waitForFunction((q) => /done|failed/.test(document.querySelector(q).textContent), '#body-status', { timeout: 60_000 });
  assert.match(await page.textContent('#body-status'), /done/);
  const bodyId = await c.bodies.bodyCount();
  const [rules] = await c.bodies.getBody(bodyId);
  assert.deepEqual([rules.name, Number(rules.seats), Number(rules.noticeMinutes), Number(rules.residentTier), rules.explainDissent], ['Example City Council', 7, 30, 2, true]);

  // Seats: this account and the city clerk.
  await page.waitForSelector(`#body-seat-body option[value="${bodyId}"]`, { state: 'attached' });
  await page.selectOption('#body-seat-body', String(bodyId));
  await page.fill('#body-seat-name', 'District 1');
  await page.fill('#body-seat-address', auto);
  await page.click('#btn-body-seat');
  await page.waitForFunction((q) => /done|failed/.test(document.querySelector(q).textContent), '#body-seat-status', { timeout: 60_000 });
  assert.match(await page.textContent('#body-seat-status'), /done/);
  await (await c.bodies.seat(bodyId, clerk.address, 'District 2', 0)).wait();

  // A member puts an item on the agenda: published now, voting opens after the notice.
  await page.click('#nav-bodies');
  await page.waitForSelector(`#body-${bodyId} details.propose summary`, { timeout: 60_000 });
  await page.click(`#body-${bodyId} details.propose summary`);
  await page.fill(`#body-${bodyId} .propose [data-f="title"]`, 'Repave Elm Street in 2027');
  await page.fill(`#body-${bodyId} .propose [data-f="body"]`, 'Full repaving between 1st and 9th, budget $1.2M.');
  await page.selectOption(`#body-${bodyId} .propose [data-f="cat"]`, 'roads');
  await page.click(`#body-${bodyId} [data-propose]`);
  const motionId = await (async () => {
    for (let i = 0; i < 120; i++) {
      const n = await c.bodies.motionCount();
      if (n > 0n) return n;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('no motion');
  })();
  await page.waitForSelector(`#motion-${motionId} >> text=On the agenda`, { timeout: 60_000 });
  assert.match(await page.textContent(`#motion-${motionId}`), /voting opens in/);
  assert.match(await page.textContent(`#motion-${motionId}`), /Roads and transport/);

  // After the notice period: this member votes from the app, the other member from their account.
  await provider.send('evm_increaseTime', [31 * 60]);
  await provider.send('evm_mine', []);
  await page.click('#nav-bodies');
  await page.waitForSelector(`#motion-${motionId} [data-vote="${motionId}:1"]`, { timeout: 60_000 });
  await page.click(`#motion-${motionId} [data-vote="${motionId}:1"]`);
  await page.waitForSelector(`#motion-${motionId} >> text=1 Yes`, { timeout: 60_000 });
  await (await c.bodies.connect(clerk).castVote(motionId, 1, 'Long overdue')).wait();
  await page.click('#nav-bodies');
  await page.waitForSelector(`#motion-${motionId} [data-count]`, { timeout: 60_000 });
  await page.click(`#motion-${motionId} [data-count]`);
  await page.waitForSelector(`#motion-${motionId} >> text=Adopted`, { state: 'attached', timeout: 60_000 });
  await page.click(`#body-${bodyId} [data-body-filter] [data-show="decided"]`);
  await page.waitForSelector(`#motion-${motionId} >> text=Adopted`, { timeout: 30_000 });
  assert.match(await page.textContent(`#motion-${motionId}`), /Long overdue/);

  // An adopted item goes on to the next body, with a link back.
  await (await c.bodies.seat(senateId, auto, 'Seat 1', 0)).wait();
  await page.click('#nav-bodies');
  await page.waitForSelector(`#motion-${motionId} [data-forward]`, { state: 'attached', timeout: 60_000 });
  await page.click(`#motion-${motionId} details:has([data-forward]) summary`);
  await page.selectOption(`#motion-${motionId} [data-f="target"]`, String(senateId));
  await page.click(`#motion-${motionId} [data-forward]`);
  const next = motionId + 1n;
  await page.waitForSelector(`#motion-${next} >> text=Comes from Example City Council, which adopted it 2–0`, { timeout: 60_000 });
  assert.equal((await c.bodies.getMotion(next)).m.bodyId, senateId);

  // Roles: the registrar makes this member the council's clerk too.
  await page.click('#nav-admin');
  await page.waitForSelector(`#body-role-body option[value="${bodyId}"]`, { state: 'attached', timeout: 60_000 });
  await page.selectOption('#body-role-body', String(bodyId));
  await page.fill('#body-role-address', auto);
  await page.check('#body-role-clerk');
  await page.click('#btn-body-role');
  await page.waitForFunction(() => /done|failed/.test(document.querySelector('#body-role-status').textContent), null, { timeout: 60_000 });
  assert.match(await page.textContent('#body-role-status'), /done/);
  assert.equal(await c.bodies.holds(bodyId, auto, 2), true);
  await page.click('#nav-bodies');
  await page.waitForSelector(`#body-${bodyId} >> text=Your roles here: member, clerk`, { timeout: 60_000 });

  // Recusal: a member steps aside on a new item, with a public reason.
  await page.click(`#body-${bodyId} details.propose:has([data-propose]) summary`);
  await page.fill(`#body-${bodyId} .propose [data-f="title"]`, 'Contract with Acme Paving');
  await page.click(`#body-${bodyId} [data-propose]`);
  const item = motionId + 2n;
  await page.waitForSelector(`#motion-${item} details:has([data-recuse]) summary`, { timeout: 60_000 });
  await page.click(`#motion-${item} details:has([data-recuse]) summary`);
  await page.fill(`#motion-${item} [data-f="recuseWhy"]`, 'My brother owns Acme Paving');
  await page.click(`#motion-${item} [data-recuse]`);
  await page.waitForSelector(`#motion-${item} >> text=1 recused`, { timeout: 60_000 });
  assert.match(await page.textContent(`#motion-${item}`), /Recused[\s\S]*My brother owns Acme Paving/);

  // A closed session: recorded with a reason and a sealed fingerprint; published later, unchanged.
  await page.click(`#body-${bodyId} details:has([data-closed]) summary`);
  await page.fill(`#body-${bodyId} [data-f="csCite"]`, 'Open Meetings Act, personnel exception');
  await page.fill(`#body-${bodyId} [data-f="csMinutes"]`, 'Interviewed two applicants for city manager. No action taken.');
  const due = new Date((Number((await provider.getBlock('latest')).timestamp) + 30 * 86_400) * 1000).toISOString().slice(0, 10);
  await page.fill(`#body-${bodyId} [data-f="csBy"]`, due);
  await page.click(`#body-${bodyId} [data-closed]`);
  await page.waitForSelector(`#body-${bodyId} >> text=Closed session 1`, { state: 'attached', timeout: 60_000 });
  assert.equal(await c.bodyRecords.sessionCount(), 1n);
  await page.click(`#body-${bodyId} details:has([data-publish]) summary`);
  await page.waitForFunction((b) => document.querySelector(`#body-${b} [data-f="pubText"]`)?.value.includes('Interviewed'), String(bodyId), { timeout: 30_000 }); // kept on this device
  await page.click(`#body-${bodyId} [data-publish]`);
  await page.waitForSelector(`#body-${bodyId} >> text=Minutes published, matching their seal`, { state: 'attached', timeout: 60_000 });
  assert.ok(Number((await c.bodyRecords.getSession(1)).s.publishedAt) > 0);

  const dash = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  dash.on('pageerror', (e) => errors.push(e.message));
  await dash.goto(`${appUrl}dashboard.html`);
  await dash.waitForSelector('#bodies >> text=Example City Council', { timeout: 60_000 });
  assert.match(await dash.textContent('#bodies'), /Repave Elm Street in 2027[\s\S]*2 Yes · 0 No/);
  assert.match(await dash.textContent('#bodies'), /Example State Senate/);
  assert.deepEqual(errors, []);
  await dash.close();
  await shot('17-bodies');
});

test('explained in plain language: the published AI summary, labelled, and answers from the text', async () => {
  const vote = (await c.vote.getAddress()).toLowerCase();
  appIpfs[`poll-${vote}-1.json`] = JSON.stringify({
    kind: 'poll', id: 1, summary: 'The city would publish its full budget online.', changes: [{ before: 'Only totals are published', after: 'Every line item above $10,000' }],
    affected: ['Residents', 'Finance department'], cost: 'Not stated in the text.', timeline: 'Within 30 days of adoption', arguments_for: ['Transparency'], arguments_against: ['Staff time'],
    quotes: ['within 30 days'], unanswered: ['Who maintains the spreadsheet?'], check: { quotesKept: 1, quotesRemoved: 1 }, model: 'claude-opus-5-5', label: 'AI summary: read the full text before you decide',
  });
  appConfig.explanationsUrl = `${appUrl}ipfs/`;
  await page.reload();
  await page.click('#btn-device');
  await page.waitForSelector('#screen-home:not([hidden])');
  await page.click('#nav-polls');
  await page.waitForSelector('#poll-1 .explain-box summary');
  await page.click('#poll-1 .explain-box summary');
  const text = await page.textContent('#poll-1 .explain-box');
  assert.match(text, /The city would publish its full budget online\./);
  assert.match(text, /Now:\s*Only totals are published/);
  assert.match(text, /Not answered by the text\s*Who maintains the spreadsheet\?/);
  assert.match(text, /AI summary: read the full text before you decide/);
  assert.match(text, /1 quote\(s\) that didn't match the text were removed/);

  await page.fill('#ask-poll-1', 'When does it start?');
  await page.click('#poll-1 .explain-box button[data-ask]');
  await page.waitForSelector('#poll-1 .explain-box .answer >> text=Asked "When does it start?" about "Publish the FY2027 line-item budget?"');
  await page.fill('#ask-poll-1', 'What about parking?');
  await page.click('#poll-1 .explain-box button[data-ask]');
  await page.waitForSelector("#poll-1 .explain-box .answer >> text=The text doesn't answer this.");
  await shot('17-explained');
});

test('stay informed: closing-soon reminder, calendar and news feeds, a printable notice', async () => {
  appConfig.calendarUrl = 'https://example.org/calendar.ics';
  appConfig.feedUrl = 'https://example.org/feed.xml';
  const doc = JSON.stringify({ title: 'Plant 200 street trees this spring?', body: 'Advisory.' });
  await (await c.notices.post(doc)).wait();
  await (await c.vote.createPoll(await c.identity.groupId(0), 86_400, 1, 2, 0, '0x', `nb:${ethers.keccak256(ethers.toUtf8Bytes(doc))}`, 0)).wait();
  const id = await c.vote.pollCount();
  await page.reload();
  await page.click('#btn-device');
  await page.waitForSelector('#screen-home:not([hidden])');
  await page.click('#nav-polls');
  await page.waitForSelector(`#poll-${id}`);
  assert.match(await page.textContent('#poll-list'), new RegExp(`Closing soon:.*poll ${id} closes`));
  await page.click('#poll-list details.card summary >> text=Stay informed');
  assert.equal(await page.getAttribute('#poll-list a[href^="webcal:"]', 'href'), 'webcal://example.org/calendar.ics');

  const sheet = await browser.newPage({ viewport: { width: 800, height: 1000 } });
  await sheet.goto(`${appUrl}notice.html`);
  await sheet.waitForSelector('#items >> text=Plant 200 street trees this spring?');
  assert.match(await sheet.textContent('#address'), /^http:\/\/localhost:\d+\/$/);
  assert.ok(await sheet.evaluate(() => document.querySelector('#qr').width > 0)); // the QR code is drawn
  await sheet.screenshot({ path: process.env.APP_SCREENSHOT_DIR ? `${process.env.APP_SCREENSHOT_DIR}/18-notice.png` : require('node:os').tmpdir() + '/notice.png' });
  await sheet.close();
});
