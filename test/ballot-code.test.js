// A sealed ballot survives the trip through a QR code, and damaged or foreign codes are refused.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeBallotCode, decodeBallotCode } = require('../client/ballot-code');

const big = (n) => (2n ** 250n + BigInt(n)).toString();
const ballot = { merkleTreeDepth: 3, merkleTreeRoot: big(1), nullifier: big(2), message: '1', scope: big(4), points: Array.from({ length: 8 }, (_, i) => big(10 + i)) };
const vote = '0xbAcc4af511f00165453399f885C73a79224a18ac';

test('a ballot code round-trips, and is short enough for a QR code', () => {
  const code = encodeBallotCode({ chainId: 84532, voteAddress: vote, pollId: 7n, ballot });
  assert.match(code, /^PB1:[A-Za-z0-9_-]+$/);
  assert.ok(code.length < 600, `code is ${code.length} characters`);
  const back = decodeBallotCode(code);
  assert.equal(back.chainId, 84532);
  assert.equal(back.voteAddress, vote);
  assert.equal(back.pollId, '7');
  assert.deepEqual(back.ballot, { ...ballot, message: '1' });
});

test('damaged, foreign and incomplete codes are refused with a plain message', () => {
  const code = encodeBallotCode({ chainId: 84532, voteAddress: vote, pollId: 1, ballot });
  assert.throws(() => decodeBallotCode('hello'), /not a Promissa ballot/);
  assert.throws(() => decodeBallotCode(code.slice(0, -10)), /damaged/);
  assert.throws(() => decodeBallotCode('PB1:@@@'), /damaged/);
  assert.throws(() => encodeBallotCode({ chainId: 1, voteAddress: vote, pollId: 1, ballot: { ...ballot, points: [] } }), /not a ballot/);
});
