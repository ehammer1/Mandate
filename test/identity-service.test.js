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
const { createEmailPolicy, matches } = require('../services/identity/email-policy');
const { createMemorySender } = require('../services/identity/senders');
const { encodeProof, enrolMessage } = require('../client/enrol');
const mail = createMemorySender();
const { enrolStartUrl } = require('../client/enrol');
const { createMockOidc } = require('./helpers/mock-oidc');

const APP = 'http://localhost:9999/app/';
let provider, c, idp, gov, msft, service, serviceUrl, issuerKey;
let anchor = 'id';
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
  msft = await createMockOidc({ clientId: 'mandate-ms', clientSecret: 'm5' });
  closers.push(idp.server, gov.server, msft.server);

  const port = await freePort();
  serviceUrl = `http://127.0.0.1:${port}`;
  service = createIdentityService({
    providers: [
      { id: 'testlogin', name: 'Test Login', issuer: idp.issuer(), clientId: 'mandate-test', clientSecret: 's3cret', tier: 0, scope: 'openid email', requireEmailVerified: true, checkEmailDomain: true },
      { id: 'govid', name: 'Gov ID', issuer: gov.issuer(), clientId: 'mandate-gov', clientSecret: 'g0v', tier: 1, scope: 'openid', requiredAcr: 'ial2' },
      // Configured like the real Microsoft provider: no email_verified claim, email trusted.
      { id: 'microsoft', name: 'Microsoft', issuer: msft.issuer(), clientId: 'mandate-ms', clientSecret: 'm5', tier: 0, scope: 'openid email profile', checkEmailDomain: true, emailTrusted: true },
    ],
    publicUrl: serviceUrl,
    pepper: 'x'.repeat(64),
    signer: issuerKey,
    identityAddress: await c.identity.getAddress(),
    allowedReturnOrigins: [new URL(APP).origin],
    emailPolicy: createEmailPolicy({ allow: 'reputable, examplecity.org' }),
    emailSender: mail,
    rateLimitPerMin: 1000, // every test request comes from one address
    emailCodesPerIpHour: 1000,
    clerkAnchor: () => anchor,
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
  idp.setUser({ sub: 'alice-123', email: 'alice@gmail.com', email_verified: true });
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
  idp.setUser({ sub: 'someone-else', email: 'someone@outlook.com', email_verified: true });
  assert.match((await signIn(me, 'testlogin')).enroll_error, /already enrolled/);
});

test('refuses unverified emails, someone else’s voter code, and unknown return sites', async () => {
  idp.setUser({ sub: 'bob-1', email: 'bob@gmail.com', email_verified: false });
  assert.match((await signIn(new Identity('bob'), 'testlogin')).enroll_error, /could not be verified/);

  idp.setUser({ sub: 'carol-1', email: 'carol@icloud.com', email_verified: true });
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
  assert.deepEqual(providers.map((p) => [p.id, p.tier]), [['testlogin', 0], ['govid', 1], ['microsoft', 0], ['email', 0]]);
});

test('email policy: reputable providers, .gov/.edu and listed domains in; throwaway and unknown domains out', async () => {
  const policy = createEmailPolicy({ allow: 'reputable, examplecity.org', block: 'spammy.example' });
  for (const ok of ['a@gmail.com', 'a@Outlook.com', 'a@icloud.com', 'a@proton.me', 'clerk@dmv.ca.gov', 'a@cs.stanford.edu', 'a@examplecity.org', 'a@lincoln.k12.ne.us']) {
    assert.equal(policy.check(ok).ok, true, ok);
  }
  for (const bad of ['a@mailinator.com', 'a@sub.yopmail.com', 'a@randomdomain.xyz', 'a@notgov', 'a@evil-gov.com', 'a@gmail.com.evil.io', 'a@spammy.example', 'not-an-email']) {
    assert.equal(policy.check(bad).ok, false, bad);
  }
  assert.equal(matches('mail.agency.gov', '*.gov'), true);
  assert.equal(matches('gov.evil.com', '*.gov'), false);
  // With no allow list, anything but throwaway mail passes.
  assert.equal(createEmailPolicy({}).check('a@randomdomain.xyz').ok, true);
  assert.equal(createEmailPolicy({}).check('a@mailinator.com').ok, false);
});

test('sign-in with an unaccepted email domain is refused before enrolment', async () => {
  idp.setUser({ sub: 'temp-1', email: 'x@mailinator.com', email_verified: true });
  assert.match((await signIn(new Identity('temp'), 'testlogin')).enroll_error, /temporary-email service/);
  idp.setUser({ sub: 'odd-1', email: 'x@randomdomain.xyz', email_verified: true });
  const r = await signIn(new Identity('odd'), 'testlogin');
  assert.match(r.enroll_error, /not on the list of accepted email providers/);
  assert.match(r.enroll_error, /Gmail, Outlook, iCloud or Yahoo/);
  idp.setUser({ sub: 'city-1', email: 'resident@examplecity.org', email_verified: true });
  assert.equal((await signIn(new Identity('city'), 'testlogin')).enrolled, 'basic');
});

// ---------------------------------------------------------------- email sign-up

const ORIGIN = new URL(APP).origin;
async function post(path, body, origin = ORIGIN) {
  const res = await fetch(`${serviceUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
function ownership(identity) {
  const ts = Date.now();
  return { commitment: identity.commitment.toString(), ts, proof: encodeProof({ pk: identity.publicKey, sig: identity.signMessage(enrolMessage(serviceUrl, identity.commitment, ts)) }) };
}

test('email sign-up: code by email, then enrolled once per mailbox', async () => {
  const providers = await (await fetch(`${serviceUrl}/providers`)).json();
  assert.ok(providers.some((p) => p.id === 'email' && p.kind === 'email'));

  const erin = new Identity('erin');
  const r = await post('/email/start', { ...ownership(erin), email: 'Erin.Smith+mandate@proton.me' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.sentTo, 'E•••@proton.me');
  const code = mail.lastCodeFor('Erin.Smith+mandate@proton.me');
  assert.match(code, /^\d{6}$/);
  assert.match(mail.outbox.at(-1).subject, /sign-up code/);

  const wrong = await post('/email/verify', { session: r.json.session, code: code === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.attemptsLeft, 4);
  const ok = await post('/email/verify', { session: r.json.session, code });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.enrolled, 'basic');
  assert.equal((await c.identity.members(erin.commitment)).active, true);

  // The same mailbox through an alias: allowed to request a code, refused only after proving the mailbox.
  const frank = new Identity('frank');
  const r2 = await post('/email/start', { ...ownership(frank), email: 'erin.smith@proton.me' });
  assert.equal(r2.status, 200);
  const v2 = await post('/email/verify', { session: r2.json.session, code: mail.lastCodeFor('erin.smith@proton.me') });
  assert.equal(v2.status, 409);
  assert.match(v2.json.error, /already been used/);
  // A used session can't be replayed.
  assert.equal((await post('/email/verify', { session: r2.json.session, code: '123456' })).status, 410);
});

test('email sign-up: Google and email for the same Gmail address count once', async () => {
  idp.setUser({ sub: 'gina-google', email: 'gina.lopez@gmail.com', email_verified: true });
  assert.equal((await signIn(new Identity('gina-google'), 'testlogin')).enrolled, 'basic');
  const g2 = new Identity('gina-email');
  const r = await post('/email/start', { ...ownership(g2), email: 'GinaLopez+vote@googlemail.com' });
  assert.equal(r.status, 200);
  const v = await post('/email/verify', { session: r.json.session, code: mail.lastCodeFor('GinaLopez+vote@googlemail.com') });
  assert.equal(v.status, 409);
});

test('email sign-up: lockout, policy, ownership, origin and rate limits', async () => {
  const hal = new Identity('hal');
  const r = await post('/email/start', { ...ownership(hal), email: 'hal@outlook.com' });
  let last;
  for (let i = 0; i < 5; i++) last = await post('/email/verify', { session: r.json.session, code: 'abcdef' });
  assert.match(last.json.error, /Too many wrong codes/);
  assert.equal((await post('/email/verify', { session: r.json.session, code: mail.lastCodeFor('hal@outlook.com') })).status, 410);

  const sentBefore = mail.outbox.length;
  assert.match((await post('/email/start', { ...ownership(new Identity('t1')), email: 'x@mailinator.com' })).json.error, /temporary-email/);
  assert.match((await post('/email/start', { ...ownership(new Identity('t2')), email: 'x@unknown-isp.biz' })).json.error, /not on the list/);
  assert.equal(mail.outbox.length, sentBefore); // nothing sent for refused addresses

  const ivy = new Identity('ivy');
  const forged = { ...ownership(ivy), commitment: (ivy.commitment + 1n).toString() };
  assert.match((await post('/email/start', { ...forged, email: 'ivy@gmail.com' })).json.error, /belongs to you/);

  assert.equal((await post('/email/start', { ...ownership(new Identity('j')), email: 'j@gmail.com' }, 'https://evil.example')).status, 403);

  // At most 3 codes per mailbox per hour.
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await post('/email/start', { ...ownership(new Identity(`kim-${i}`)), email: 'kim@yahoo.com' })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
});

test('Microsoft sign-in: Outlook accounts join; same mailbox as email sign-up counts once', async () => {
  msft.setUser({ sub: 'ms-olivia', email: 'olivia.park@outlook.com', name: 'Olivia' }); // no email_verified, like Microsoft
  const olivia = new Identity('olivia-ms');
  const r = await signIn(olivia, 'microsoft');
  assert.equal(r.enrolled, 'basic', JSON.stringify(r));
  assert.equal(r.provider, 'Microsoft');

  // Same Outlook mailbox through email sign-up: refused after the code proves it.
  const again = new Identity('olivia-email');
  const s = await post('/email/start', { ...ownership(again), email: 'Olivia.Park+x@outlook.com' });
  assert.equal(s.status, 200);
  const v = await post('/email/verify', { session: s.json.session, code: mail.lastCodeFor('Olivia.Park+x@outlook.com') });
  assert.equal(v.status, 409);

  // A Microsoft account that shares no email, or uses a throwaway address, is refused.
  msft.setUser({ sub: 'ms-noemail' });
  assert.match((await signIn(new Identity('ms-noemail'), 'microsoft')).enroll_error, /did not share an email address/);
  msft.setUser({ sub: 'ms-temp', email: 'z@yopmail.com' });
  assert.match((await signIn(new Identity('ms-temp'), 'microsoft')).enroll_error, /temporary-email/);
});

test('clerk desk: ID fingerprints only for approved clerks, same for every desk, never the plain number', async () => {
  const { clerkSessionMessage, canonicalDoc, parseVoterCode, voterCodeQr } = require('../client/clerk');
  const admin = await provider.getSigner(0);
  const desk1 = ethers.Wallet.createRandom();
  const desk2 = ethers.Wallet.createRandom();
  const stranger = ethers.Wallet.createRandom();
  await (await c.identity.connect(admin).setIssuer(desk1.address, 1, true, 'City Hall desk')).wait();
  await (await c.identity.connect(admin).setIssuer(desk2.address, 1, true, 'Library desk')).wait();
  const session = async (w, { expires = Date.now() + 3600_000, url = serviceUrl } = {}) => ({ address: w.address, expires, signature: await w.signMessage(clerkSessionMessage({ serviceUrl: url, address: w.address, expires })) });
  const ask = (sess, doc, origin = new URL(APP).origin) =>
    fetch(`${serviceUrl}/clerk/doc-hash`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ session: sess, doc }) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const doc = { kind: 'state', region: 'ca', number: 'D123-4567' };

  const a = await ask(await session(desk1), doc);
  assert.equal(a.status, 200);
  assert.match(a.docHash, /^0x[0-9a-f]{64}$/);
  assert.equal(a.alreadyUsed, false);
  // Another desk, the number written differently: the same fingerprint.
  const b = await ask(await session(desk2), { kind: 'state', region: 'CA ', number: 'd 1234567' });
  assert.equal(b.docHash, a.docHash);
  // Keyed: not a plain hash anyone could recompute from a list of ID numbers.
  assert.notEqual(a.docHash, ethers.keccak256(ethers.toUtf8Bytes(canonicalDoc(doc))));
  // A passport is a different document.
  assert.notEqual((await ask(await session(desk1), { kind: 'passport', region: 'US', number: 'D1234567' })).docHash, a.docHash);

  // Once used on-chain, the desk is told before it tries again.
  await (await c.identity.connect(admin).setIssuer(issuerKey.address, 1, true, 'Sign-in service')).wait();
  await (await c.identity.connect(issuerKey).enroll(new Identity('desk-person').commitment, 1, a.docHash, 0)).wait();
  assert.equal((await ask(await session(desk2), doc)).alreadyUsed, true);

  // Refused: not a clerk, a removed clerk, expired or too-long sessions, forged or replayed-elsewhere signatures, other sites.
  assert.equal((await ask(await session(stranger), doc)).status, 403);
  await (await c.identity.connect(admin).setIssuer(desk2.address, 1, false, 'Library desk')).wait();
  assert.equal((await ask(await session(desk2), doc)).status, 403);
  assert.equal((await ask(await session(desk1, { expires: Date.now() - 1000 }), doc)).status, 401);
  assert.equal((await ask(await session(desk1, { expires: Date.now() + 13 * 3600_000 }), doc)).status, 401);
  assert.equal((await ask({ ...(await session(stranger)), address: desk1.address }, doc)).status, 401);
  assert.equal((await ask(await session(desk1, { url: 'https://other-service.example' }), doc)).status, 401);
  assert.equal((await ask(await session(desk1), doc, 'https://evil.example')).status, 403);
  // Nonsense IDs are refused with a message for the clerk.
  const bad = await ask(await session(desk1), { kind: 'state', region: 'C', number: '12' });
  assert.equal(bad.status, 400);
  assert.match(bad.error, /Enter the state/);

  // Voter-code QR text round-trips; junk is refused.
  const id = new Identity('qr');
  assert.equal(parseVoterCode(voterCodeQr(id.commitment)), id.commitment);
  assert.equal(parseVoterCode(` ${id.commitment}\n`), id.commitment);
  assert.throws(() => parseVoterCode('https://example.com'), /isn't a Mandate voter code/);
  assert.throws(() => parseVoterCode('0'), /isn't a valid voter code/);
});

test('clerk desk: the city picks one anchor, so nobody can enrol once by ID and again by voter roll', async () => {
  const { clerkSessionMessage, canonicalDoc } = require('../client/clerk');
  const admin = await provider.getSigner(0);
  const desk = ethers.Wallet.createRandom();
  await (await c.identity.connect(admin).setIssuer(desk.address, 1, true, 'Precinct desk')).wait();
  const expires = Date.now() + 3600_000;
  const session = { address: desk.address, expires, signature: await desk.signMessage(clerkSessionMessage({ serviceUrl, address: desk.address, expires })) };
  const ask = (doc) => fetch(`${serviceUrl}/clerk/doc-hash`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(APP).origin }, body: JSON.stringify({ session, doc }) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const roll = { kind: 'roll', region: 'OR', number: '000-555-123' };
  const id = { kind: 'state', region: 'OR', number: '000555123' };

  anchor = 'id';
  assert.equal((await ask(id)).status, 200);
  const r1 = await ask(roll);
  assert.equal(r1.status, 400);
  assert.match(r1.error, /by government photo ID/);
  anchor = 'roll';
  const r2 = await ask(roll);
  assert.equal(r2.status, 200);
  assert.match((await ask(id)).error, /by their voter registration record/);
  // A roll record and an ID with the same number never share a fingerprint.
  assert.notEqual(canonicalDoc(roll), canonicalDoc(id));
  anchor = 'id';
});
