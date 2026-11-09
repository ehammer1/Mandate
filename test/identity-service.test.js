// Sign-in identity service end to end: real OpenID flow (PKCE, state, nonce,
// signed ID tokens) against a mock provider, enrolment on a local chain.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Identity } = require('@semaphore-protocol/identity');
const { deployAll } = require('../scripts/deploy');
const { createIdentityService } = require('../services/identity/server');
const { enrolStartUrl } = require('../client/enrol');
const { createMockOidc } = require('./helpers/mock-oidc');

const APP = 'http://localhost:9999/app/';
let provider, c, idp, gov, service, serviceUrl, issuerKey;
const closers = [];

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

before(async () => {
  const g = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 3, defaultBalance: 100 }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } });
  provider = new ethers.BrowserProvider(g, undefined, { cacheTimeout: -1 });
  const admin = await provider.getSigner(0);
  issuerKey = await provider.getSigner(1);
  ({ contracts: c } = await deployAll(admin, {}));
  await (await c.identity.setIssuer(issuerKey.address, 1, true, 'Sign-in service')).wait();

  idp = await createMockOidc({ clientId: 'mandate-test', clientSecret: 's3cret' });
  gov = await createMockOidc({ clientId: 'mandate-gov', clientSecret: 'g0v' });
  closers.push(idp.server, gov.server);

  const port = await freePort();
  serviceUrl = `http://127.0.0.1:${port}`;
  service = createIdentityService({
    providers: [
      { id: 'testlogin', name: 'Test Login', issuer: idp.issuer(), clientId: 'mandate-test', clientSecret: 's3cret', tier: 0, scope: 'openid email', requireEmailVerified: true },
      { id: 'govid', name: 'Gov ID', issuer: gov.issuer(), clientId: 'mandate-gov', clientSecret: 'g0v', tier: 1, scope: 'openid', requiredAcr: 'ial2' },
    ],
    publicUrl: serviceUrl,
    pepper: 'x'.repeat(64),
    signer: issuerKey,
    identityAddress: await c.identity.getAddress(),
    allowedReturnOrigins: [new URL(APP).origin],
    allowInsecure: true,
    log: () => {},
  });
  await new Promise((r) => service.listen(port, '127.0.0.1', r));
  closers.push(service);
});

after(async () => {
  for (const s of closers) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
});

/** What the voter app does: sign (service, code, time) with the voter key, then follow redirects. */
async function signIn(identity, providerId, { tamper } = {}) {
  let url = enrolStartUrl({ serviceUrl, providerId, identity, returnUrl: APP });
  if (tamper) url = url.replace(`commitment=${identity.commitment}`, `commitment=${identity.commitment + 1n}`);
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url, { redirect: 'manual' });
    const loc = res.headers.get('location');
    if (!loc) return { status: res.status, text: await res.text() };
    if (loc.startsWith(APP)) return Object.fromEntries(new URLSearchParams(new URL(loc).hash.slice(1)));
    url = loc;
  }
  throw new Error('too many redirects');
}

test('Google-style sign-in enrols the voter code at the basic tier, once per account', async () => {
  const me = new Identity('alice');
  idp.setUser({ sub: 'alice-123', email_verified: true });
  const r = await signIn(me, 'testlogin');
  assert.equal(r.enrolled, 'basic', JSON.stringify(r));
  const m = await c.identity.members(me.commitment);
  assert.equal(m.active, true);
  assert.equal(m.tier, 0n);
  assert.notEqual(m.accountHash, ethers.ZeroHash);

  // Same account, different voter code: refused, enforced by the contract.
  const r2 = await signIn(new Identity('alice-second-phone'), 'testlogin');
  assert.match(r2.enroll_error, /already been used/);

  // The same code again: refused before any sign-in.
  idp.setUser({ sub: 'someone-else', email_verified: true });
  assert.match((await signIn(me, 'testlogin')).enroll_error, /already enrolled/);
});

test('refuses unverified emails, someone else’s voter code, and unknown return sites', async () => {
  idp.setUser({ sub: 'bob-1', email_verified: false });
  assert.match((await signIn(new Identity('bob'), 'testlogin')).enroll_error, /could not be verified/);

  idp.setUser({ sub: 'carol-1', email_verified: true });
  assert.match((await signIn(new Identity('carol'), 'testlogin', { tamper: true })).enroll_error, /belongs to you/);

  const res = await fetch(`${serviceUrl}/start?provider=testlogin&return=${encodeURIComponent('https://evil.example/')}`, { redirect: 'manual' });
  assert.equal(res.status, 400);
});

test('identity-proofed provider enrols at the verified tier only with the required assurance', async () => {
  const dan = new Identity('dan');
  gov.setUser({ sub: 'gov-dan', acr: 'ial1' });
  assert.match((await signIn(dan, 'govid')).enroll_error, /required level/);

  gov.setUser({ sub: 'gov-dan', acr: 'ial2' });
  const r = await signIn(dan, 'govid');
  assert.equal(r.enrolled, 'verified', JSON.stringify(r));
  const m = await c.identity.members(dan.commitment);
  assert.equal(m.tier, 1n);
  assert.notEqual(m.docHash, ethers.ZeroHash);

  const providers = await (await fetch(`${serviceUrl}/providers`)).json();
  assert.deepEqual(providers.map((p) => [p.id, p.tier]), [['testlogin', 0], ['govid', 1]]);
});
