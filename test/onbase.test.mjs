// "📜 On Base": a published item is found on the chain: when, by whom, its block and transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { locate, blockAt } from '../app/src/onbase.js';

const require = createRequire(import.meta.url);
const ganache = require('ganache');
const { ethers } = require('ethers');
const { deploy } = require('../scripts/deploy');

test('a post is located by its reference: block, author and transaction; older boards by its time', async () => {
  const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' } }), undefined, { cacheTimeout: -1 });
  const signer = await provider.getSigner(0);
  const nb = await deploy(signer, 'NoticeBoard', {});
  for (let i = 0; i < 3; i++) await provider.send('evm_mine', []);
  await provider.send('evm_increaseTime', [10]); // on Base each block has its own time (2 seconds apart)
  const text = JSON.stringify({ title: 'Sample petition', attachments: [{ sha256: 'ab'.repeat(32) }] });
  const rc = await (await nb.post(text)).wait();
  const ref = `nb:${ethers.keccak256(ethers.toUtf8Bytes(text))}`;
  const r = await locate({ noticeBoardAddress: await nb.getAddress() }, provider, ref);
  assert.equal(r.block, rc.blockNumber);
  assert.equal(r.tx, rc.hash);
  assert.equal(r.author, signer.address);
  assert.equal(await blockAt(provider, r.at), rc.blockNumber); // the search older notice boards need
  assert.equal(await locate({ noticeBoardAddress: await nb.getAddress() }, provider, 'nb:0x' + '1'.repeat(64)), null);
  assert.equal(await locate({ noticeBoardAddress: await nb.getAddress() }, provider, 'Qm-not-a-board-ref'), null);
});
