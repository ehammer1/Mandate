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
const { createEmailPolicy } = require('./email-policy');

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
    // Personal Microsoft accounts (the "consumers" tenant has a fixed id, so the issuer validates).
    list.push({ id: 'microsoft', name: 'Microsoft', issuer: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0', clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, tier: 0, scope: 'openid' });
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

  function fingerprint(p, claims) {
    // Bound to provider id + issuer + subject: stable for the account, meaningless without the pepper.
    return '0x' + crypto.createHmac('sha256', String(o.pepper)).update(`${p.id}|${claims.iss}|${claims.sub}`).digest('hex');
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
    return recent.length > 20;
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

    // The voter key signs (service, code, time): only the code's owner can enrol it.
    let commitment;
    try {
      commitment = BigInt(q.get('commitment'));
      const ts = Number(q.get('ts'));
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > TTL_MS) throw new Error('expired');
      const proof = decodeProof(q.get('proof'));
      const pk = proof.pk.map(BigInt);
      const sig = { R8: proof.sig.R8.map(BigInt), S: BigInt(proof.sig.S) };
      if (Identity.generateCommitment(pk) !== commitment) throw new Error('key mismatch');
      if (!Identity.verifySignature(enrolMessage(o.publicUrl, commitment, ts), sig, pk)) throw new Error('bad signature');
      const tag = `${commitment}:${ts}`;
      if (usedProofs.has(tag)) throw new Error('replayed');
      usedProofs.add(tag);
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
      const verified = claims.email_verified === true || claims.email_verified === 'true';
      const verdict = verified ? o.emailPolicy.check(claims.email) : { ok: false, reason: 'the email address is not verified' };
      if (!verdict.ok) {
        log(`sign-in refused by email policy: ${verdict.reason}`);
        return backTo(res, s.returnUrl, {
          enroll_error: `This account can't be used to join (${verdict.reason}). Please use an address from a well-known provider such as Gmail, Outlook, iCloud or Yahoo, or a .gov or .edu address.`,
        });
      }
    }

    const hash = fingerprint(p, claims);
    const commitment = BigInt(s.commitment);
    try {
      const used = p.tier === 1 ? await registry.commitmentOfDoc(hash) : await registry.commitmentOfAccount(hash);
      if (used !== 0n) return backTo(res, s.returnUrl, { enroll_error: `This ${p.name} account has already been used to enrol someone.` });

      const run = queue.then(async () => {
        const tx = await registry.enroll(commitment, p.tier, hash, 0);
        await tx.wait();
        return tx.hash;
      });
      queue = run.catch(() => {});
      const txHash = await run;
      log(`enrolled a voter via ${p.id} (tier ${p.tier}) tx=${txHash}`);
      return backTo(res, s.returnUrl, { enrolled: p.tier === 1 ? 'verified' : 'basic', provider: p.name, tx: txHash });
    } catch (e) {
      const name = e?.revert?.name;
      const msg = name === 'AccountAlreadyUsed' || name === 'DocumentAlreadyUsed'
        ? `This ${p.name} account has already been used to enrol someone.`
        : name === 'AlreadyEnrolled'
          ? 'This voter code is already enrolled.'
          : 'Enrolment failed on the network. Please try again later.';
      log(`enrol failed: ${name || e.shortMessage || e.message}`);
      return backTo(res, s.returnUrl, { enroll_error: msg });
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
        return res.end(JSON.stringify([...providers.values()].map((p) => ({ id: p.id, name: p.name, tier: p.tier }))));
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
    if (!providers.length) console.warn('[identity] no sign-in providers configured yet (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET); running so the issuer address can be approved');
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
    });
    const port = Number(process.env.PORT || 8790);
    server.listen(port, () => console.log(`[identity] listening on :${port}; issuer ${signer.address}; providers: ${providers.map((p) => `${p.name}(${p.tier ? 'verified' : 'basic'})`).join(', ')}`));
  })().catch((e) => {
    console.error(`[identity] ${e.message}`);
    process.exit(1);
  });
}
