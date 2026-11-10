// Mobile ID (mDL) sign-up: requests, decryption and verification against a simulated wallet.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { createMdlVerifier } = require('../services/identity/mdl');
const { createIssuer, issueLicence, answer } = require('./helpers/mock-wallet');

const ORIGIN = 'https://city.example';
let state, otherState, licence;
const values = (over = {}) => ({
  family_name: 'Example', given_name: 'Pat', portrait: Buffer.from([1, 2, 3]), // never requested
  document_number: 'D1234567', issuing_jurisdiction: 'US-OR', issuing_country: 'US',
  expiry_date: '2031-01-01', age_over_18: true, resident_postal_code: '97201', resident_city: 'Portland', ...over,
});

before(async () => {
  state = await createIssuer('Oregon DMV (test)');
  otherState = await createIssuer('Somewhere Else (test)');
  licence = await issueLicence(state, values());
});

test('a resident shares their mobile ID: verified, only the asked-for fields, no name or photo', async () => {
  const mdl = createMdlVerifier({ roots: [state.rootPem], zips: ['972'] });
  const { session, request } = await mdl.start(123n);
  assert.equal(request.protocol, 'org-iso-mdoc');
  const r = await mdl.finish(session, await answer(licence, request, ORIGIN), ORIGIN);
  assert.equal(r.commitment, 123n);
  assert.equal(r.jurisdiction, 'OR');
  assert.equal(r.documentNumber, 'D1234567');
  assert.equal(r.postalCode, '97201');
  assert.equal(Object.hasOwn(r, 'family_name'), false);
  // A request is used once.
  await assert.rejects(mdl.finish(session, await answer(licence, request, ORIGIN), ORIGIN), /expired/);
});

test('refused: another state not trusted, the wrong website, outside the community, under 18, expired', async () => {
  const strict = createMdlVerifier({ roots: [otherState.rootPem] });
  let s = await strict.start(1n);
  await assert.rejects(strict.finish(s.session, await answer(licence, s.request, ORIGIN), ORIGIN), (e) => /not from an accepted issuer/.test(e.userMessage));

  const mdl = createMdlVerifier({ roots: [state.rootPem], zips: ['972'] });
  s = await mdl.start(1n);
  // Answer made for a different website: the session transcript differs, so it can't be opened.
  await assert.rejects(mdl.finish(s.session, await answer(licence, s.request, 'https://evil.example'), ORIGIN), (e) => /not made for this request/.test(e.userMessage));

  const elsewhere = createMdlVerifier({ roots: [state.rootPem], zips: ['10001'] });
  s = await elsewhere.start(1n);
  await assert.rejects(elsewhere.finish(s.session, await answer(licence, s.request, ORIGIN), ORIGIN), (e) => /not in this community/.test(e.userMessage));

  const minor = await issueLicence(state, values({ age_over_18: false }));
  s = await mdl.start(1n);
  await assert.rejects(mdl.finish(s.session, await answer(minor, s.request, ORIGIN), ORIGIN), (e) => /adults/.test(e.userMessage));

  const old = await issueLicence(state, values({ expiry_date: '2020-01-01' }));
  s = await mdl.start(1n);
  await assert.rejects(mdl.finish(s.session, await answer(old, s.request, ORIGIN), ORIGIN), (e) => /expired/.test(e.userMessage));

  // Withholding the document number is refused (it is what makes one person one voter code).
  s = await mdl.start(1n);
  await assert.rejects(mdl.finish(s.session, await answer(licence, s.request, ORIGIN, { fields: ['age_over_18', 'resident_postal_code'] }), ORIGIN), (e) => /document number/.test(e.userMessage));
});
