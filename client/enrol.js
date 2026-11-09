/**
 * client/enrol.js - shared by the voter app and the sign-in identity service.
 *
 * Before an identity service enrols a voter code, the person proves the code is
 * theirs by signing (service origin, code, time) with their voter key. That stops
 * anyone from attaching their own sign-in account to someone else's code.
 */
'use strict';

const { ethers } = require('ethers');

function enrolMessage(serviceUrl, commitment, ts) {
  const text = `mandate-enrol:${new URL(serviceUrl).origin}:${commitment}:${ts}`;
  return BigInt(ethers.keccak256(ethers.toUtf8Bytes(text))) >> 8n;
}

const toJson = (o) => JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** base64url(JSON) that works in browsers and Node alike. */
function encodeProof(obj) {
  const bytes = new TextEncoder().encode(toJson(obj));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeProof(s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

/** "This voter code is mine": { commitment, ts, proof } signed with the voter key. */
function ownershipProof({ serviceUrl, identity, now = Date.now() }) {
  const sig = identity.signMessage(enrolMessage(serviceUrl, identity.commitment, now));
  return { commitment: identity.commitment.toString(), ts: String(now), proof: encodeProof({ pk: identity.publicKey, sig }) };
}

/** Build the /start URL for a sign-in provider. */
function enrolStartUrl({ serviceUrl, providerId, identity, returnUrl, now = Date.now() }) {
  const q = new URLSearchParams({ provider: providerId, ...ownershipProof({ serviceUrl, identity, now }), return: returnUrl });
  return `${serviceUrl.replace(/\/+$/, '')}/start?${q}`;
}

module.exports = { enrolMessage, encodeProof, decodeProof, enrolStartUrl, ownershipProof };
