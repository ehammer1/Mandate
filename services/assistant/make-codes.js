#!/usr/bin/env node
// Prepaid codes for the Promissa assistant: TOKEN_SECRET=... node services/assistant/make-codes.js <days> <how many>
// Each code gives that many days of unlimited use, once, to whoever redeems it ("Have a code?").
'use strict';
const { makeCode } = require('./server');
const [days, n] = process.argv.slice(2).map(Number);
const secret = process.env.TOKEN_SECRET || '';
if (!(days > 0 && days < 10000) || !(n > 0) || secret.length < 32) {
  console.error('Usage: TOKEN_SECRET=<the service’s secret> node services/assistant/make-codes.js <days> <how many>');
  process.exit(1);
}
for (let i = 0; i < n; i++) console.log(makeCode(secret, days));
