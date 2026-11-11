#!/usr/bin/env node
/**
 * services/identity/server.js - the sign-in identity service.
 *
 * An identity source (an "issuer" in IdentityRegistry) that enrolls people who
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
 *      HMAC(pepper, provider:issuer:subject), and enroll the voter code on-chain.
 *      The contract refuses a fingerprint it has already seen, so one account
 *      enrolls one person, auditable by anyone, with no database here.
 *   4. The person is sent back to the app.
 *
 * Privacy: the provider learns that the person used Mandate, never how they vote.
 * This service sees the provider's ID token briefly and stores nothing. On-chain
 * there is only the voter code and an unlinkable fingerprint.
 *
 * Endpoints: GET /providers · GET /start · GET|POST /callback · GET /health
 *            POST /email/start · POST /email/verify · POST /clerk/doc-hash
 * Configuration: environment variables, see docs/identity-service.md.
 */

'use strict';

require('dotenv').config();

const http = require('http');
const crypto = require('crypto');
const { ethers } = require('ethers');
const client = require('openid-client');
const { Identity } = require('@semaphore-protocol/identity');
const { canonicalDoc, clerkSessionMessage, CLERK_SESSION_MAX_MS, kindsFor } = require('../../client/clerk.js');
const { lookUp } = require('../../client/roll.js');

const TTL_MS = 10 * 60 * 1000;
const MAX_BODY = 64 * 1024;

const IDENTITY_ABI = [
  'function enroll(uint256 commitment, uint8 tier, bytes32 docHash, uint64 residentSince)',
  'function upgrade(uint256 commitment, bytes32 docHash, uint64 residentSince)',
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
 * @param {number} [o.mailPerIpHour]       letter requests per IP per hour (default 3)
 * @param {object} [o.mailer]              mail.js mailer: verification codes by post to registered addresses (voter-roll cities)
 * @param {() => object} [o.appConfig]     the published app config (for "ask a question" about polls and mandates)
 * @param {boolean} [o.askEnabled]          answer residents' questions with Claude (needs ANTHROPIC_API_KEY)
 * @param {object} [o.mdl]                 createMdlVerifier(...): sign-up with a state mobile ID (verified tier)
 * @param {() => object} [o.roll]           the voter roll file (scripts/roll-import.js), or null
 * @param {string} [o.rollKey]               the key its fingerprints were made with (ROLL_KEY)
 * @param {() => string} [o.clerkAnchor]     the city's one-person-one-code anchor for clerk desks: 'id' (default) or 'roll'
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

  /** The voter key signs (service, code, time): only the code's owner can enroll it. Throws if not. */
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

  /** Enroll on-chain, one transaction at a time. Returns the tx hash or throws { userMessage }. */
  async function enroll(commitment, tier, hash, label) {
    const used = tier === 1 ? await registry.commitmentOfDoc(hash) : await registry.commitmentOfAccount(hash);
    if (used !== 0n) throw Object.assign(new Error('used'), { userMessage: `This ${label} has already been used to enroll someone.`, status: 409 });
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
      log(`enroll failed: ${name || e.shortMessage || e.message}`);
      if (name === 'AccountAlreadyUsed' || name === 'DocumentAlreadyUsed') throw Object.assign(e, { userMessage: `This ${label} has already been used to enroll someone.`, status: 409 });
      if (name === 'AlreadyEnrolled') throw Object.assign(e, { userMessage: 'This voter code is already enrolled.', status: 409 });
      throw Object.assign(e, { userMessage: 'Enrollment failed on the network. Please try again later.', status: 502 });
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
      const txHash = await enroll(BigInt(s.commitment), p.tier, fingerprint(p, claims), `${p.name} account`);
      log(`enrolled a voter via ${p.id} (tier ${p.tier}) tx=${txHash}`);
      return backTo(res, s.returnUrl, { enrolled: p.tier === 1 ? 'verified' : 'basic', provider: p.name, tx: txHash });
    } catch (e) {
      return backTo(res, s.returnUrl, { enroll_error: e.userMessage || 'Enrollment failed. Please try again later.' });
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

  // POST /clerk/doc-hash { session: { address, expires, signature }, doc: { kind, region, number } }
  //   -> { docHash, alreadyUsed }
  //
  // The clerk desk never holds the pepper: it asks here, so every desk gets the same
  // fingerprint for the same document, and the number itself is never published. Only
  // accounts that are active clerks (issuers allowed to verify) on the registry may ask.
  const clerkHits = new Map(); // clerk address -> [timestamps]

  /** The approved clerk behind a desk session, or [status, error]. */
  async function clerkFrom(body) {
    const sess = body.session || {};
    const expires = Number(sess.expires);
    if (!ethers.isAddress(sess.address) || !Number.isFinite(expires)) return [400, { error: 'Open the clerk desk again.' }];
    if (expires < Date.now() || expires - Date.now() > CLERK_SESSION_MAX_MS) return [401, { error: 'The desk session has expired. Tap "Open the desk" again.' }];
    let signer;
    try {
      signer = ethers.verifyMessage(clerkSessionMessage({ serviceUrl: o.publicUrl, address: ethers.getAddress(sess.address), expires }), String(sess.signature || ''));
    } catch {
      signer = null;
    }
    if (!signer || signer !== ethers.getAddress(sess.address)) return [401, { error: 'Could not confirm the desk session. Tap "Open the desk" again.' }];
    const iss = await registry.issuers(signer);
    if (!iss.active || Number(iss.maxTier) < 1) return [403, { error: 'This account is not an approved clerk.' }];

    const recent = recentCount(clerkHits, signer, 3600_000);
    if (recent.length >= (o.clerkLookupsPerHour ?? 120)) return [429, { error: 'Too many ID checks this hour from this desk. Please wait a few minutes.' }];
    recent.push(Date.now());
    return { signer };
  }

  async function clerkDocHash(body) {
    const who = await clerkFrom(body);
    if (Array.isArray(who)) return who;
    const { signer } = who;

    const anchor = (o.clerkAnchor && o.clerkAnchor()) || 'id';
    if (!kindsFor(anchor).includes(body.doc?.kind)) {
      return [400, { error: anchor === 'roll' ? 'This city enrolls people by their voter registration record, not by ID document.' : 'This city enrolls people by government photo ID, not by voter registration record.' }];
    }
    let canonical;
    try {
      canonical = canonicalDoc(body.doc || {});
    } catch (e) {
      return [400, { error: e.message }];
    }
    const docHash = hmac(canonical);
    const usedBy = await registry.commitmentOfDoc(docHash);
    log(`document fingerprint for clerk ${signer}`);
    return [200, { docHash, alreadyUsed: usedBy !== 0n }];
  }

  // POST /clerk/roll-match { session, person: { first, last, dob, house, zip } }
  //   -> { matched, ambiguous?, matchedOn?, registrationEnds?, docHash?, alreadyUsed? }
  // Finds the person in the city's voter roll (keyed fingerprints only). In a voter-roll
  // city the match also gives the one-person fingerprint for enrolling them.
  async function clerkRollMatch(body) {
    const who = await clerkFrom(body);
    if (Array.isArray(who)) return who;
    const roll = o.roll && o.roll();
    if (!roll || !o.rollKey) return [503, { error: 'No voter roll is loaded on this service yet.' }];
    const r = lookUp(roll, o.rollKey, body.person || {});
    log(`roll lookup for clerk ${who.signer}: ${r.matched ? 'matched' : r.ambiguous ? 'ambiguous' : r.incomplete ? 'incomplete' : 'no match'}`);
    if (r.incomplete) return [400, { error: 'Enter at least the surname, date of birth and ZIP code, plus the first name or house number.' }];
    if (!r.matched) return [200, { matched: false, ambiguous: !!r.ambiguous }];
    const out = { matched: true, matchedOn: r.matchedOn, registrationEnds: String(r.registration).slice(-3) };
    if (((o.clerkAnchor && o.clerkAnchor()) || 'id') === 'roll') {
      out.docHash = hmac(canonicalDoc({ kind: 'roll', region: roll.state, number: r.registration }));
      out.alreadyUsed = (await registry.commitmentOfDoc(out.docHash)) !== 0n;
    }
    return [200, out];
  }

  // POST /mdl/start  { commitment, ts, proof }        -> { session, request } for navigator.credentials.get
  // POST /mdl/finish { session, response, origin }    -> { enrolled: 'verified', tx }
  // The phone's wallet checks its owner is present and shares only the requested fields,
  // signed by the issuing state. The document becomes the same fingerprint a clerk desk
  // makes for a licence, so one person still gets one voter code.
  async function mdlStart(body) {
    if (!o.mdl) return [503, { error: 'Mobile ID sign-up is not available here.' }];
    let commitment;
    try {
      commitment = verifyOwnership(body.commitment, body.ts, body.proof);
    } catch {
      return [400, { error: 'Could not confirm this voter code belongs to you. Please try again.' }];
    }
    const me = await registry.issuers(await o.signer.getAddress());
    if (!me.active || Number(me.maxTier) < 1) return [503, { error: 'Mobile ID sign-up is waiting for the council to approve this service for ID checks.' }];
    return [200, await o.mdl.start(commitment)];
  }

  async function mdlFinish(body, origin) {
    if (!o.mdl) return [503, { error: 'Mobile ID sign-up is not available here.' }];
    let r;
    try {
      r = await o.mdl.finish(body.session, body.response, origin);
    } catch (e) {
      log(`mobile ID refused: ${e.message}`);
      return [400, { error: e.userMessage || 'This mobile ID could not be verified.' }];
    }
    const docHash = hmac(canonicalDoc({ kind: r.jurisdiction.length === 2 ? 'state' : 'other', region: r.jurisdiction, number: r.documentNumber }));
    if ((await registry.commitmentOfDoc(docHash)) !== 0n) return [409, { error: 'This ID has already been used to enroll someone. If you lost your phone, ask the clerk to remove your old voter code.' }];
    return enrolVerified(r.commitment, docHash, `mobile ID (${r.jurisdiction})`);
  }

  /** Enroll at the ID-checked level, or upgrade a basic member. */
  async function enrolVerified(commitment, docHash, how) {
    const m = await registry.members(commitment);
    if (m.active && Number(m.tier) >= 1) return [409, { error: 'This voter code is already ID-checked.' }];
    if (m.issuer !== ethers.ZeroAddress && !m.active) return [409, { error: 'This voter code was removed. Please make a new one.' }];
    try {
      const run = queue.then(async () => {
        const tx = m.active ? await registry.upgrade(commitment, docHash, 0) : await registry.enroll(commitment, 1, docHash, 0);
        await tx.wait();
        return tx.hash;
      });
      queue = run.catch(() => {});
      const tx = await run;
      log(`enrolled a voter via ${how} tx=${tx}`);
      return [200, { enrolled: 'verified', tx }];
    } catch (e) {
      log(`${how} enroll failed: ${e.revert?.name || e.shortMessage || e.message}`);
      return [e.revert?.name === 'DocumentAlreadyUsed' ? 409 : 502, { error: e.revert?.name === 'DocumentAlreadyUsed' ? 'This registration or ID has already been used to enroll someone.' : 'Enrollment failed on the network. Please try again later.' }];
    }
  }

  // POST /roll/mail/start  { commitment, ts, proof, person: { first, last, dob, street, line2?, city, state, zip } } -> { sent }
  // POST /roll/mail/verify { commitment, ts, proof, person, code } -> { enrolled: 'verified', tx }
  // Voter-roll cities: the person's details must match their registration, including the
  // street, and a code goes by post in a sealed letter to that registered address. The code
  // is derived (registration, voter code, month), so nothing waits in storage meanwhile.
  const mailIp = new Map();
  const mailReg = new Map();
  const mailTries = new Map();
  const mailCode = (registration, commitment, month) => {
    const h = crypto.createHmac('sha256', String(o.pepper)).update(`mailcode|${registration}|${commitment}|${month}`).digest();
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from(h.subarray(0, 8), (b) => A[b % 32]).join('');
  };
  const month = (offset = 0) => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + offset);
    return d.toISOString().slice(0, 7);
  };

  async function rollMailCheck(body) {
    const roll = o.roll && o.roll();
    if (!o.mailer || !roll || !o.rollKey || ((o.clerkAnchor && o.clerkAnchor()) || 'id') !== 'roll') return { err: [503, { error: 'Verification by mail is not available here.' }] };
    let commitment;
    try {
      commitment = verifyOwnership(body.commitment, body.ts, body.proof);
    } catch {
      return { err: [400, { error: 'Could not confirm this voter code belongs to you. Please try again.' }] };
    }
    const p = body.person || {};
    const r = lookUp(roll, o.rollKey, p);
    if (r.ambiguous) return { err: [409, { error: 'These details fit more than one registration. Please verify in person at the clerk.' }] };
    if (!r.matched || !r.streetMatched) return { err: [404, { error: 'We could not find a registration with exactly these details, including your street. Check them against your voter registration card, or verify in person.' }] };
    const docHash = hmac(canonicalDoc({ kind: 'roll', region: roll.state, number: r.registration }));
    if ((await registry.commitmentOfDoc(docHash)) !== 0n) return { err: [409, { error: 'This registration has already been used to enroll someone. If that wasn\'t you, please contact the city clerk.' }] };
    const me = await registry.issuers(await o.signer.getAddress());
    if (!me.active || Number(me.maxTier) < 1) return { err: [503, { error: 'Verification by mail is waiting for the council to approve this service for ID checks.' }] };
    return { commitment, registration: r.registration, docHash, person: p, state: roll.state };
  }

  async function rollMailStart(body, ip) {
    if ((recentCount(mailIp, ip, 3600_000)).length >= (o.mailPerIpHour ?? 3)) return [429, { error: 'Too many requests. Please try again in an hour.' }];
    mailIp.get(ip).push(Date.now());
    const c = await rollMailCheck(body);
    if (c.err) return c.err;
    const sent = recentCount(mailReg, c.registration, 30 * 86_400_000);
    if (sent.length >= 2) return [429, { error: 'Two letters have already been sent for this registration this month. Please wait for them, or verify in person.' }];
    sent.push(Date.now());
    const p = c.person;
    try {
      await o.mailer.send(
        { name: `${String(p.first || '').trim()} ${String(p.last || '').trim()}`.trim(), address_line1: String(p.street || '').trim(), address_line2: String(p.line2 || '').trim() || undefined, address_city: String(p.city || '').trim(), address_state: String(p.state || c.state).trim(), address_zip: String(p.zip || '').trim() },
        mailCode(c.registration, c.commitment, month()),
      );
    } catch (e) {
      log(`letter failed: ${e.message}`);
      return [502, { error: 'We could not send the letter. Please try again later.' }];
    }
    log(`verification letter sent for a ${c.state} registration`);
    return [200, { sent: true }];
  }

  async function rollMailVerify(body) {
    const c = await rollMailCheck(body);
    if (c.err) return c.err;
    const tries = recentCount(mailTries, String(c.commitment), 3600_000);
    if (tries.length >= 5) return [429, { error: 'Too many attempts. Please wait an hour.' }];
    tries.push(Date.now());
    const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const ok = [month(), month(-1)].some((mo) => {
      const want = Buffer.from(mailCode(c.registration, c.commitment, mo));
      return code.length === want.length && crypto.timingSafeEqual(Buffer.from(code), want);
    });
    if (!ok) return [400, { error: 'That code is not right, or it has expired. Check the letter, or request a new one.' }];
    return enrolVerified(c.commitment, c.docHash, `mailed code (${c.state} voter roll)`);
  }

  // POST /ask { kind: 'poll' | 'mandate', id, question } -> { answer, answered_by_text, quotes, model }
  // Answers from the published text only, with quotes checked against it.
  const askHits = new Map();
  const askCache = new Map();
  async function askQuestion(body, ip) {
    if (!o.askEnabled || !o.appConfig) return [503, { error: 'Questions are not available right now.' }];
    if (recentCount(askHits, ip, 3600_000).length >= (o.askPerIpHour ?? 10)) return [429, { error: 'Too many questions this hour. Please try again later.' }];
    askHits.get(ip).push(Date.now());
    const question = String(body.question || '').trim();
    const id = Number(body.id);
    if (question.length < 3 || question.length > 500 || !['poll', 'mandate'].includes(body.kind) || !Number.isInteger(id) || id < 1) return [400, { error: 'Ask a question of 3 to 500 characters.' }];
    const key = `${body.kind}:${id}:${question.toLowerCase().replace(/\s+/g, ' ')}`;
    if (askCache.has(key)) return [200, askCache.get(key)];
    const cfg = o.appConfig();
    const provider = o.signer.provider;
    const { readDoc, effectOf } = require('../explainer/source');
    let doc;
    let effect = '';
    if (body.kind === 'poll') {
      const vote = new ethers.Contract(cfg.voteAddress, ['function getPoll(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 quorum, uint8 options, uint8 action, bool finalized, bool passed, address proposer, uint256 bond, string questionCID, bytes actionData))'], provider);
      const p = await vote.getPoll(id).catch(() => null);
      if (!p) return [404, { error: 'No such poll.' }];
      doc = await readDoc(cfg, provider, p.questionCID);
      effect = await effectOf(cfg, provider, p);
    } else {
      const reg = new ethers.Contract(cfg.registryAddress, ['function getMandate(uint256) view returns (tuple(address responsible, uint64 createdAt, uint64 deadline, uint64 settledAt, uint16 threshold, uint8 status, uint32 round, uint32 approvals, uint32 rejections, bytes32 category, string specCID, string evidenceCID, uint64 pausedAt))'], provider);
      const m = await reg.getMandate(id).catch(() => null);
      if (!m) return [404, { error: 'No such mandate.' }];
      doc = await readDoc(cfg, provider, m.specCID);
    }
    if (!doc) return [404, { error: 'The text of this item could not be read.' }];
    try {
      const out = await (o.answerQuestion || require('../explainer/explain').answer)({ ...doc, effect }, question);
      if (askCache.size > 500) askCache.clear();
      askCache.set(key, out);
      return [200, out];
    } catch (e) {
      log(`question not answered: ${e.message}`);
      return [502, { error: e.refusal ? 'This question could not be answered.' : 'The assistant is unavailable right now. Please try again later.' }];
    }
  }

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
      const tx = await enroll(BigInt(s.commitment), 0, hmac(`email|${s.norm}`), 'email address');
      log(`enrolled a voter via email tx=${tx}`);
      return [200, { enrolled: 'basic', tx }];
    } catch (e) {
      return [e.status || 502, { error: e.userMessage || 'Enrollment failed. Please try again later.' }];
    }
  }

  const uploadHits = new Map();
  function readRaw(req, max) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > max) {
          reject(new Error('too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
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
      if (url.pathname === '/roll') {
        // Public: which roll snapshot is in use (no records), so anyone can audit it.
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        const roll = o.roll && o.roll();
        return res.end(JSON.stringify(roll ? { loaded: true, state: roll.state, records: roll.records, createdAt: roll.createdAt, digest: roll.digest } : { loaded: false }));
      }
      if (url.pathname === '/providers') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        const list = [...providers.values()].map((p) => ({ id: p.id, name: p.name, tier: p.tier }));
        if (o.emailSender) list.push({ id: 'email', name: 'Email', tier: 0, kind: 'email' });
        if (o.mdl) list.push({ id: 'mdl', name: 'Mobile ID', tier: 1, kind: 'mdl' });
        if (o.mailer && o.roll && o.roll() && (o.clerkAnchor ? o.clerkAnchor() : 'id') === 'roll') list.push({ id: 'mail', name: 'Code by mail', tier: 1, kind: 'mail' });
        return res.end(JSON.stringify(list));
      }
      if (url.pathname === '/upload/blocked') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ enabled: !!o.uploads, ai: !!(o.uploads && o.askEnabled), blocked: o.uploads ? o.uploads.blocked() : [] }));
      }
      if (url.pathname === '/upload' || url.pathname === '/upload/remove') {
        const origin = req.headers.origin || '';
        const admin = url.pathname === '/upload/remove';
        const cors = o.allowedReturnOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
        const json = (status, obj) => {
          res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
          res.end(JSON.stringify(obj));
        };
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, X-Upload-Proof, X-File-Name', 'Access-Control-Max-Age': '600' });
          return res.end();
        }
        if (!admin && !cors['Access-Control-Allow-Origin']) return json(403, { error: 'This app is not allowed to use this identity service.' });
        if (!o.uploads) return json(503, { error: 'Adding files is not available right now.' });
        if (req.method !== 'POST') return json(405, { error: 'POST only' });
        if (admin) {
          let body;
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            return json(400, { error: 'Invalid request.' });
          }
          const [status, out] = await o.uploads.remove(body, req.headers.authorization);
          return json(status, out);
        }
        if (recentCount(uploadHits, ip, 3600_000).length >= (o.uploadsPerIpHour ?? 60)) return json(429, { error: 'Too many files this hour. Please try again later.' });
        uploadHits.get(ip).push(Date.now());
        let bytes;
        try {
          bytes = await readRaw(req, require('./uploads').MAX_BYTES);
        } catch {
          return json(413, { error: 'Files can be up to 10 MB.' });
        }
        const [status, out] = await o.uploads.upload(bytes, req.headers, url.searchParams);
        return json(status, out);
      }
      if (url.pathname.startsWith('/email/') || url.pathname.startsWith('/clerk/') || url.pathname.startsWith('/mdl/') || url.pathname.startsWith('/roll/') || url.pathname === '/ask') {
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
        const route = { '/email/start': () => emailStart(body, ip), '/email/verify': () => emailVerify(body), '/clerk/doc-hash': () => clerkDocHash(body), '/clerk/roll-match': () => clerkRollMatch(body), '/mdl/start': () => mdlStart(body), '/mdl/finish': () => mdlFinish(body, origin), '/roll/mail/start': () => rollMailStart(body, ip), '/roll/mail/verify': () => rollMailVerify(body), '/ask': () => askQuestion(body, ip) }[url.pathname];
        const [status, out] = route ? await route() : [404, { error: 'Not found' }];
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

/**
 * Mobile ID sign-up from the environment: MDL_IACA_ROOTS (PEM certificates, pasted) or
 * MDL_IACA_URL (a PEM bundle to download); MDL_ZIPS (comma-separated ZIP codes or prefixes)
 * and/or MDL_CITY limit it to residents. Off unless roots are given.
 */
async function mdlFromEnv(env = process.env) {
  let pem = String(env.MDL_IACA_ROOTS || '');
  if (!pem.trim() && env.MDL_IACA_URL) pem = await (await fetch(String(env.MDL_IACA_URL).trim())).text();
  const roots = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  if (!roots.length) return undefined;
  const { createMdlVerifier } = require('./mdl');
  console.log(`[identity] mobile ID sign-up on: ${roots.length} trusted issuing authorit${roots.length === 1 ? 'y' : 'ies'}`);
  return createMdlVerifier({ roots, zips: String(env.MDL_ZIPS || '').split(',').map((z) => z.trim()).filter(Boolean), city: String(env.MDL_CITY || '').trim() || undefined });
}

module.exports = { createIdentityService, providersFromEnv, enrolMessage, encodeProof, mdlFromEnv };

if (require.main === module) {
  const clean = (v) => String(v || '').trim().replace(/^['"]|['"]$/g, '');
  const need = (n) => clean(process.env[n]) || (console.error(`[identity] missing env ${n}`), process.exit(2));
  (async () => {
    let identityAddress = clean(process.env.IDENTITY_ADDRESS);
    let rpcUrl = clean(process.env.RPC_URL);
    // The clerk-desk anchor follows the published app config (re-read every 5 minutes), unless set here.
    let anchor = clean(process.env.CLERK_ANCHOR) || 'id';
    let appCfg = null;
    if (process.env.CONFIG_URL) {
      const load = async () => (await fetch(`${clean(process.env.CONFIG_URL)}?t=${Date.now()}`, { cache: 'no-store' })).json();
      const cfg = await load();
      appCfg = cfg;
      setInterval(() => load().then((c) => (appCfg = c)).catch(() => {}), 5 * 60_000).unref();
      identityAddress ||= cfg.identityAddress;
      rpcUrl ||= cfg.rpcUrl;
      if (!clean(process.env.CLERK_ANCHOR)) {
        anchor = cfg.clerkAnchor || 'id';
        setInterval(() => load().then((c) => (anchor = c.clerkAnchor || 'id')).catch(() => {}), 5 * 60_000).unref();
      }
    }
    if (!ethers.isAddress(identityAddress)) throw new Error('set IDENTITY_ADDRESS or CONFIG_URL');
    // The voter roll (keyed fingerprints from scripts/roll-import.js), re-read hourly.
    let roll = null;
    const rollUrl = clean(process.env.ROLL_URL);
    if (rollUrl) {
      const loadRoll = async () => {
        roll = await (await fetch(`${rollUrl}${rollUrl.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' })).json();
        console.log(`[identity] voter roll loaded: ${roll.records} records (${roll.state}), digest ${roll.digest}`);
      };
      await loadRoll().catch((e) => console.error(`[identity] could not load the voter roll: ${e.message}`));
      setInterval(() => loadRoll().catch(() => {}), 3600_000).unref();
    }
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
      clerkAnchor: () => anchor,
      appConfig: () => appCfg,
      askEnabled: !!clean(process.env.ANTHROPIC_API_KEY),
      mdl: await mdlFromEnv(),
      mailer: require('./mail').mailerFromEnv(),
      roll: () => roll,
      rollKey: clean(process.env.ROLL_KEY) || undefined,
      uploads: clean(process.env.PINATA_JWT)
        ? require('./uploads').createUploads({
          store: require('./uploads').pinata(clean(process.env.PINATA_JWT)),
          appConfig: () => appCfg,
          provider,
          perDay: Number(process.env.UPLOADS_PER_DAY || 10),
          minTier: Number(process.env.UPLOAD_MIN_TIER || 0),
          read: clean(process.env.ANTHROPIC_API_KEY) ? (bytes, type) => require('../explainer/explain').readUpload(bytes, type) : undefined,
          adminToken: clean(process.env.UPLOAD_ADMIN_TOKEN) || undefined,
          blocked: (process.env.UPLOAD_BLOCKLIST || '').split(',').map((x) => x.trim()).filter(Boolean),
          log: (m) => console.log(`[identity] ${m}`),
        })
        : undefined,
    });
    const port = Number(process.env.PORT || 8790);
    server.listen(port, () => console.log(`[identity] listening on :${port}; issuer ${signer.address}; providers: ${[...providers.map((p) => `${p.name}(${p.tier ? 'verified' : 'basic'})`), ...(process.env.EMAIL_PROVIDER ? [`Email via ${process.env.EMAIL_PROVIDER}(basic)`] : [])].join(', ')}`));
  })().catch((e) => {
    console.error(`[identity] ${e.message}`);
    process.exit(1);
  });
}
