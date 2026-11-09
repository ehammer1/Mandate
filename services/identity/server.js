#!/usr/bin/env node
/**
 * services/identity/server.js - the sign-in identity service.
 *
 * An identity source (an "issuer" in IdentityRegistry) that enrols people who
 * sign in with an OpenID Connect provider:
 *
 *   Google, Apple, Microsoft            -> BASIC tier   (proves an account, not a person)
 *   Login.gov / ID.me / state identity  -> VERIFIED tier (identity-proofed providers;
 *                                          configured as generic OIDC providers)
 *
 * Flow
 *   1. The voter app sends the person here with their voter code and a signature
 *      made with their voter key (proving the code is theirs, not someone else's).
 *   2. They sign in with the provider (authorization code + PKCE, state, nonce).
 *   3. We validate the ID token, derive a fingerprint of the account,
 *      HMAC(pepper, provider:issuer:subject), and enrol the voter code on-chain.
 *      The contract refuses a fingerprint it has already seen, so one account
 *      enrols one person, auditable by anyone, with no database here.
 *   4. The person is sent back to the app.
 *
 * Privacy: the provider learns that the person used Mandate, never how they vote.
 * This service sees the provider's ID token briefly and stores nothing. On-chain
 * there is only the voter code and an unlinkable fingerprint.
 *
 * Endpoints: GET /providers · GET /start · GET|POST /callback · GET /health
 * Configuration: environment variables, see docs/identity-service.md.
 */

'use strict';

require('dotenv').config();

const http = require('http');
const crypto = require('crypto');
const { ethers } = require('ethers');
const client = require('openid-client');
const { Identity } = require('@semaphore-protocol/identity');

const TTL_MS = 10 * 60 * 1000;
const MAX_BODY = 64 * 1024;

const IDENTITY_ABI = [
  'function enroll(uint256 commitment, uint8 tier, bytes32 docHash, uint64 residentSince)',
  'function members(uint256) view returns (address issuer, uint8 tier, bool active, uint64 verifiedAt, uint64 residentSince, bytes32 docHash, bytes32 accountHash)',
  'function commitmentOfAccount(bytes32) view returns (uint256)',
  'function commitmentOfDoc(bytes32) view returns (uint256)',
  'function issuers(address) view returns (uint8 maxTier, bool active, string name)',
  'error AccountAlreadyUsed(uint256 commitment)',
  'error DocumentAlreadyUsed(uint256 commitment)',
  'error AlreadyEnrolled()',
  'error IssuerInactive()',
  'error TierNotAllowed(uint8 tier, uint8 maxTier)',
];

const { enrolMessage, decodeProof, encodeProof } = require('../../client/enrol');
const { createEmailPolicy, normalizeEmail } = require('./email-policy');
const { senderFromEnv } = require('./senders');

// ---------------------------------------------------------------- providers

/**
 * Provider definitions. Convenience env vars for the big three, plus any number of
 * generic OIDC providers via OIDC_PROVIDERS (JSON array) for Login.gov, ID.me,
 * state identity systems, or a test provider.
 */
function providersFromEnv(env = process.env) {
  const list = [];
  if (env.GOOGLE_CLIENT_ID) {
    list.push({ id: 'google', name: 'Google', issuer: 'https://accounts.google.com', clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, tier: 0, scope: 'openid email', requireEmailVerified: true, checkEmailDomain: true });
  }
  if (env.MICROSOFT_CLIENT_ID) {
    // Personal Microsoft accounts (Outlook, Hotmail, Live, Xbox, Skype). The "consumers" tenant has a
    // fixed id, so the issuer validates. Microsoft verifies a personal account's email when the account
    // is created but sends no email_verified claim, hence emailTrusted (personal accounts only).
    list.push({ id: 'microsoft', name: 'Microsoft', issuer: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0', clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, tier: 0, scope: 'openid email profile', checkEmailDomain: true, emailTrusted: true });
  }
  if (env.APPLE_CLIENT_ID) {
    // Apple's client secret is a short-lived ES256 JWT signed with your .p8 key (built per request).
    list.push({ id: 'apple', name: 'Apple', issuer: 'https://appleid.apple.com', clientId: env.APPLE_CLIENT_ID, apple: { teamId: env.APPLE_TEAM_ID, keyId: env.APPLE_KEY_ID, privateKey: env.APPLE_PRIVATE_KEY }, tier: 0, scope: 'openid' });
  }
  if (env.OIDC_PROVIDERS) {
    for (const p of JSON.parse(env.OIDC_PROVIDERS)) list.push({ scope: 'openid', tier: 0, ...p });
  }
  for (const p of list) {
    if (!/^[a-z0-9-]{2,32}$/.test(p.id)) throw new Error(`bad provider id ${p.id}`);
    if (p.tier !== 0 && p.tier !== 1) throw new Error(`provider ${p.id}: tier must be 0 (basic) or 1 (verified)`);
  }
  return list;
}

async function appleClientSecret(apple, clientId) {
  const { SignJWT, importPKCS8 } = await import('jose');
  const key = await importPKCS8(apple.privateKey.replace(/\\n/g, '\n'), 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: apple.keyId })
    .setIssuer(apple.teamId)
    .setAudience('https://appleid.apple.com')
    .setSubject(clientId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

// ------------------------------------------------------------------ service

/**
 * @param {object} o
 * @param {Array} o.providers                provider definitions (providersFromEnv)
 * @param {string} o.publicUrl               this service's public base URL (callback = publicUrl + /callback)
 * @param {string} o.pepper                  secret for account fingerprints (32+ random bytes, hex or text)
 * @param {ethers.Signer} o.signer           issuer key (needs the issuer role on IdentityRegistry)
 * @param {string} o.identityAddress
 * @param {string[]} o.allowedReturnOrigins  where people may be sent back to (the voter app)
 * @param {object} [o.emailPolicy]           createEmailPolicy(...): applied to providers with checkEmailDomain
 * @param {object} [o.emailSender]           senders.js sender; enables email sign-up with one-time codes
 * @param {number} [o.rateLimitPerMin]       requests per IP per minute (default 20)
 * @param {number} [o.emailCodesPerIpHour]   sign-up codes per IP per hour (default 10)
 * @param {boolean} [o.allowInsecure]        http providers (tests only)
 */
function createIdentityService(o) {
  if (!o.pepper || String(o.pepper).length < 32) throw new Error('IDENTITY_PEPPER must be at least 32 characters of random data');
  const log = o.log || ((m) => console.log(`${new Date().toISOString()} [identity] ${m}`));
  const registry = new ethers.Contract(o.identityAddress, IDENTITY_ABI, o.signer);
  const providers = new Map(o.providers.map((p) => [p.id, p]));
  const configs = new Map(); // provider id -> openid-client Configuration
  const pending = new Map(); // state -> { ... }, short-lived
  const usedProofs = new Set();
  const hits = new Map();
  const emailSessions = new Map(); // session id -> { ... }, 10 minutes
  const emailSends = new Map(); // normalized email -> [timestamps]
  const ipSends = new Map(); // ip -> [timestamps]
  let queue = Promise.resolve();

  const callbackUrl = new URL('callback', o.publicUrl.replace(/\/?$/, '/')).toString();

  async function configFor(p) {
    if (configs.has(p.id)) return configs.get(p.id);
    let auth;
    if (p.apple) {
      auth = async (_as, _client, body) => {
        body.set('client_id', p.clientId);
        body.set('client_secret', await appleClientSecret(p.apple, p.clientId));
      };
    } else if (p.privateKeyJwk) auth = client.PrivateKeyJwt(p.privateKeyJwk);
    else if (p.clientSecret) auth = client.ClientSecretPost(p.clientSecret);
    const cfg = await client.discovery(new URL(p.issuer), p.clientId, undefined, auth, o.allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined);
    configs.set(p.id, cfg);
    return cfg;
  }

  const hmac = (text) => '0x' + crypto.createHmac('sha256', String(o.pepper)).update(text).digest('hex');

  /** One mailbox, one fingerprint, whether it arrives through Google or email sign-up. */
  function emailFingerprint(email) {
    return hmac(`email|${normalizeEmail(email)}`);
  }

  /** The account's email if the provider vouches for it (email_verified, or a provider we trust to verify). */
  function verifiedEmailOf(p, claims) {
    const flagged = claims.email_verified === true || claims.email_verified === 'true';
    return (flagged || (p.emailTrusted && claims.email)) && normalizeEmail(claims.email) ? claims.email : null;
  }

  function fingerprint(p, claims) {
    if (p.checkEmailDomain && verifiedEmailOf(p, claims)) return emailFingerprint(claims.email);
    // Otherwise bound to provider id + issuer + subject: stable for the account, meaningless without the pepper.
    return hmac(`${p.id}|${claims.iss}|${claims.sub}`);
  }

  /** The voter key signs (service, code, time): only the code's owner can enrol it. Throws if not. */
  function verifyOwnership(commitmentText, tsText, proofText) {
    const commitment = BigInt(commitmentText);
    const ts = Number(tsText);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > TTL_MS) throw new Error('expired');
    const proof = decodeProof(proofText);
    const pk = proof.pk.map(BigInt);
    const sig = { R8: proof.sig.R8.map(BigInt), S: BigInt(proof.sig.S) };
    if (Identity.generateCommitment(pk) !== commitment) throw new Error('key mismatch');
    if (!Identity.verifySignature(enrolMessage(o.publicUrl, commitment, ts), sig, pk)) throw new Error('bad signature');
    const tag = `${commitment}:${ts}`;
    if (usedProofs.has(tag)) throw new Error('replayed');
    usedProofs.add(tag);
    return commitment;
  }

  /** Enrol on-chain, one transaction at a time. Returns the tx hash or throws { userMessage }. */
  async function enrol(commitment, tier, hash, label) {
    const used = tier === 1 ? await registry.commitmentOfDoc(hash) : await registry.commitmentOfAccount(hash);
    if (used !== 0n) throw Object.assign(new Error('used'), { userMessage: `This ${label} has already been used to enrol someone.`, status: 409 });
    try {
      const run = queue.then(async () => {
        const tx = await registry.enroll(commitment, tier, hash, 0);
        await tx.wait();
        return tx.hash;
      });
      queue = run.catch(() => {});
      return await run;
    } catch (e) {
      const name = e?.revert?.name;
      log(`enrol failed: ${name || e.shortMessage || e.message}`);
      if (name === 'AccountAlreadyUsed' || name === 'DocumentAlreadyUsed') throw Object.assign(e, { userMessage: `This ${label} has already been used to enrol someone.`, status: 409 });
      if (name === 'AlreadyEnrolled') throw Object.assign(e, { userMessage: 'This voter code is already enrolled.', status: 409 });
      throw Object.assign(e, { userMessage: 'Enrolment failed on the network. Please try again later.', status: 502 });
    }
  }

  function backTo(res, returnUrl, params) {
    const u = new URL(returnUrl);
    u.hash = new URLSearchParams(params).toString();
    res.writeHead(302, { Location: u.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  function fail(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
  }

  function limited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > (o.rateLimitPerMin ?? 20);
  }

  function sweep() {
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.at > TTL_MS) pending.delete(k);
    if (usedProofs.size > 50_000) usedProofs.clear();
  }

  // GET /start?provider=..&commitment=..&proof=..&ts=..&return=..
  async function start(req, res, url) {
    const q = url.searchParams;
    const returnUrl = q.get('return') || '';
    let returnOrigin;
    try {
      returnOrigin = new URL(returnUrl).origin;
    } catch {
      return fail(res, 400, 'Missing or invalid return address.');
    }
    if (!o.allowedReturnOrigins.includes(returnOrigin)) return fail(res, 400, 'This app is not allowed to use this identity service.');

    const p = providers.get(q.get('provider') || '');
    if (!p) return backTo(res, returnUrl, { enroll_error: 'Unknown sign-in option.' });

    let commitment;
    try {
      commitment = verifyOwnership(q.get('commitment'), q.get('ts'), q.get('proof'));
    } catch {
      return backTo(res, returnUrl, { enroll_error: 'Could not confirm this voter code belongs to you. Please try again.' });
    }

    const m = await registry.members(commitment);
    if (m.issuer !== ethers.ZeroAddress) return backTo(res, returnUrl, { enroll_error: 'This voter code is already enrolled.' });

    const cfg = await configFor(p);
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    pending.set(state, { at: Date.now(), provider: p.id, commitment: commitment.toString(), verifier, nonce, returnUrl });
    sweep();

    const params = {
      redirect_uri: callbackUrl,
      scope: p.scope,
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    };
    if (p.acrValues) params.acr_values = p.acrValues;
    if (p.prompt) params.prompt = p.prompt;
    const to = client.buildAuthorizationUrl(cfg, params);
    res.writeHead(302, { Location: to.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  // GET|POST /callback
  async function callback(req, res, url) {
    let currentUrl = url;
    if (req.method === 'POST') {
      // Providers using response_mode=form_post (Apple with scopes) post the result.
      const body = await readBody(req);
      currentUrl = new URL(url.toString());
      for (const [k, v] of new URLSearchParams(body)) currentUrl.searchParams.set(k, v);
    }
    const state = currentUrl.searchParams.get('state') || '';
    const s = pending.get(state);
    if (!s) return fail(res, 400, 'This sign-in link expired. Please start again from the app.');
    pending.delete(state);
    const p = providers.get(s.provider);

    if (currentUrl.searchParams.get('error')) {
      return backTo(res, s.returnUrl, { enroll_error: 'Sign-in was cancelled.' });
    }

    let claims;
    try {
      const cfg = await configFor(p);
      const tokens = await client.authorizationCodeGrant(cfg, currentUrl, { pkceCodeVerifier: s.verifier, expectedState: state, expectedNonce: s.nonce });
      claims = tokens.claims();
      if (!claims?.sub) throw new Error('no subject');
      if (p.requireEmailVerified && claims.email_verified !== true && claims.email_verified !== 'true') throw new Error('email not verified');
      if (p.requiredAcr && claims.acr !== p.requiredAcr) throw new Error('identity not verified to the required level');
    } catch (e) {
      log(`sign-in failed for ${p.id}: ${e.message}`);
      return backTo(res, s.returnUrl, { enroll_error: `Sign-in with ${p.name} could not be verified (${e.message}).` });
    }

    if (p.checkEmailDomain && o.emailPolicy) {
      const email = verifiedEmailOf(p, claims);
      const verdict = email ? o.emailPolicy.check(email) : { ok: false, reason: claims.email ? 'the email address is not verified' : 'the account did not share an email address' };
      if (!verdict.ok) {
        log(`sign-in refused by email policy: ${verdict.reason}`);
        return backTo(res, s.returnUrl, {
          enroll_error: `This account can't be used to join (${verdict.reason}). Please use an address from a well-known provider such as Gmail, Outlook, iCloud or Yahoo, or a .gov or .edu address.`,
        });
      }
    }

    try {
      const txHash = await enrol(BigInt(s.commitment), p.tier, fingerprint(p, claims), `${p.name} account`);
      log(`enrolled a voter via ${p.id} (tier ${p.tier}) tx=${txHash}`);
      return backTo(res, s.returnUrl, { enrolled: p.tier === 1 ? 'verified' : 'basic', provider: p.name, tx: txHash });
    } catch (e) {
      return backTo(res, s.returnUrl, { enroll_error: e.userMessage || 'Enrolment failed. Please try again later.' });
    }
  }

  // ------------------------------------------------------ email sign-up
  //
  // POST /email/start  { commitment, ts, proof, email }  -> { session, sentTo }
  // POST /email/verify { session, code }                  -> { enrolled: 'basic', tx }
  //
  // Codes: 6 digits, 10 minutes, 5 guesses, stored only as a hash. Whether an address
  // is already enrolled is revealed only after the code proves the mailbox is theirs.

  const CODE_TTL = 10 * 60 * 1000;
  const recentCount = (map, key, windowMs) => {
    const now = Date.now();
    const list = (map.get(key) || []).filter((t) => now - t < windowMs);
    map.set(key, list);
    return list;
  };
  const maskEmail = (e) => e.replace(/^(.)[^@]*(@.*)$/, (_m, a, d) => `${a}•••${d}`);

  async function emailStart(body, ip) {
    if (!o.emailSender) return [503, { error: 'Email sign-up is not available right now.' }];
    let commitment;
    try {
      commitment = verifyOwnership(body.commitment, body.ts, body.proof);
    } catch {
      return [400, { error: 'Could not confirm this voter code belongs to you. Please try again.' }];
    }
    const email = String(body.email || '').trim();
    const norm = normalizeEmail(email);
    if (!norm) return [400, { error: 'Please enter a valid email address.' }];
    const verdict = o.emailPolicy ? o.emailPolicy.check(email) : { ok: true };
    if (!verdict.ok) {
      return [400, { error: `This address can't be used to join (${verdict.reason}). Please use an address from a well-known provider such as Gmail, Outlook, iCloud, Yahoo or Proton, or a .gov or .edu address.` }];
    }
    if ((await registry.members(commitment)).issuer !== ethers.ZeroAddress) return [409, { error: 'This voter code is already enrolled.' }];

    const perEmail = recentCount(emailSends, norm, 3600_000);
    const perIp = recentCount(ipSends, ip, 3600_000);
    if (perEmail.length >= 3 || perIp.length >= (o.emailCodesPerIpHour ?? 10)) return [429, { error: 'Too many codes requested. Please wait an hour and try again.' }];
    perEmail.push(Date.now());
    perIp.push(Date.now());

    const session = crypto.randomBytes(16).toString('hex');
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    emailSessions.set(session, { at: Date.now(), norm, commitment: commitment.toString(), codeHash: crypto.createHash('sha256').update(`${session}:${code}`).digest(), attempts: 0 });
    for (const [k, v] of emailSessions) if (Date.now() - v.at > CODE_TTL) emailSessions.delete(k);

    try {
      await o.emailSender.send(
        email,
        `${code} is your Mandate sign-up code`,
        `Your Mandate sign-up code is ${code}\n\nEnter it in the Mandate app within 10 minutes to join.\n\nIf you didn't ask for this, you can ignore this email. Nobody can join with your address without this code.`,
      );
    } catch (e) {
      emailSessions.delete(session);
      log(`email send failed: ${e.message}`);
      return [502, { error: 'We could not send the email. Please check the address or try again later.' }];
    }
    log(`sign-up code sent to ${maskEmail(norm)}`);
    return [200, { session, sentTo: maskEmail(email) }];
  }

  async function emailVerify(body) {
    const s = emailSessions.get(String(body.session || ''));
    if (!s || Date.now() - s.at > CODE_TTL) {
      emailSessions.delete(String(body.session || ''));
      return [410, { error: 'This code has expired. Please request a new one.' }];
    }
    const given = crypto.createHash('sha256').update(`${body.session}:${String(body.code || '').replace(/\s/g, '')}`).digest();
    if (!crypto.timingSafeEqual(given, s.codeHash)) {
      s.attempts += 1;
      if (s.attempts >= 5) {
        emailSessions.delete(String(body.session));
        return [400, { error: 'Too many wrong codes. Please request a new one.', attemptsLeft: 0 }];
      }
      return [400, { error: 'That code is not right. Please check the email and try again.', attemptsLeft: 5 - s.attempts }];
    }
    emailSessions.delete(String(body.session));
    try {
      const tx = await enrol(BigInt(s.commitment), 0, hmac(`email|${s.norm}`), 'email address');
      log(`enrolled a voter via email tx=${tx}`);
      return [200, { enrolled: 'basic', tx }];
    } catch (e) {
      return [e.status || 502, { error: e.userMessage || 'Enrolment failed. Please try again later.' }];
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, o.publicUrl);
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{"ok":true}');
      }
      if (url.pathname === '/providers') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        const list = [...providers.values()].map((p) => ({ id: p.id, name: p.name, tier: p.tier }));
        if (o.emailSender) list.push({ id: 'email', name: 'Email', tier: 0, kind: 'email' });
        return res.end(JSON.stringify(list));
      }
      if (url.pathname.startsWith('/email/')) {
        // Called from the voter app's page: allow its origin only.
        const origin = req.headers.origin || '';
        const cors = o.allowedReturnOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
        const json = (status, obj) => {
          res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
          res.end(JSON.stringify(obj));
        };
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
          return res.end();
        }
        if (!cors['Access-Control-Allow-Origin']) return json(403, { error: 'This app is not allowed to use this identity service.' });
        if (limited(ip)) return json(429, { error: 'Too many attempts. Please wait a minute.' });
        if (req.method !== 'POST') return json(405, { error: 'POST only' });
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return json(400, { error: 'Invalid request.' });
        }
        const [status, out] = url.pathname === '/email/start' ? await emailStart(body, ip) : url.pathname === '/email/verify' ? await emailVerify(body) : [404, { error: 'Not found' }];
        return json(status, out);
      }
      if (limited(ip)) return fail(res, 429, 'Too many attempts. Please wait a minute.');
      if (url.pathname === '/start' && req.method === 'GET') return await start(req, res, url);
      if (url.pathname === '/callback') return await callback(req, res, url);
      fail(res, 404, 'Not found');
    } catch (e) {
      log(`error: ${e.message}`);
      fail(res, 500, 'Something went wrong. Please try again.');
    }
  });
  return server;
}

module.exports = { createIdentityService, providersFromEnv, enrolMessage, encodeProof };

if (require.main === module) {
  const clean = (v) => String(v || '').trim().replace(/^['"]|['"]$/g, '');
  const need = (n) => clean(process.env[n]) || (console.error(`[identity] missing env ${n}`), process.exit(2));
  (async () => {
    let identityAddress = clean(process.env.IDENTITY_ADDRESS);
    let rpcUrl = clean(process.env.RPC_URL);
    if (process.env.CONFIG_URL) {
      const cfg = await (await fetch(clean(process.env.CONFIG_URL), { cache: 'no-store' })).json();
      identityAddress ||= cfg.identityAddress;
      rpcUrl ||= cfg.rpcUrl;
    }
    if (!ethers.isAddress(identityAddress)) throw new Error('set IDENTITY_ADDRESS or CONFIG_URL');
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    // ISSUER_SEED lets a host generate the secret itself (e.g. Render's generateValue): the key is
    // derived from it, so no private key is ever copied by hand. ISSUER_PRIVATE_KEY also works.
    const seed = clean(process.env.ISSUER_SEED);
    const key = clean(process.env.ISSUER_PRIVATE_KEY) || (seed && ethers.keccak256(ethers.toUtf8Bytes(`mandate-issuer:${seed}`)));
    if (!key) throw new Error('set ISSUER_SEED or ISSUER_PRIVATE_KEY');
    const signer = new ethers.Wallet(key, provider);
    const providers = providersFromEnv();
    if (!providers.length && !process.env.EMAIL_PROVIDER) console.warn('[identity] no sign-in providers configured yet (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET); running so the issuer address can be approved');
    const reg = new ethers.Contract(identityAddress, IDENTITY_ABI, provider);
    const me = await reg.issuers(signer.address);
    console.log(`[identity] issuer address ${signer.address}${me.active ? ` (approved as "${me.name}")` : ' (NOT approved yet: an admin must approve it in the app: Admin -> Give someone a role -> Clerk)'}`);
    const server = createIdentityService({
      providers,
      publicUrl: need('PUBLIC_URL'),
      pepper: need('IDENTITY_PEPPER'),
      signer,
      identityAddress: ethers.getAddress(identityAddress),
      allowedReturnOrigins: need('ALLOWED_RETURN_ORIGINS').split(',').map((s) => s.trim()),
      emailPolicy: createEmailPolicy({ allow: process.env.EMAIL_DOMAINS_ALLOW, block: process.env.EMAIL_DOMAINS_BLOCK }),
      emailSender: senderFromEnv(),
    });
    const port = Number(process.env.PORT || 8790);
    server.listen(port, () => console.log(`[identity] listening on :${port}; issuer ${signer.address}; providers: ${[...providers.map((p) => `${p.name}(${p.tier ? 'verified' : 'basic'})`), ...(process.env.EMAIL_PROVIDER ? [`Email via ${process.env.EMAIL_PROVIDER}(basic)`] : [])].join(', ')}`));
  })().catch((e) => {
    console.error(`[identity] ${e.message}`);
    process.exit(1);
  });
}
