// "Support this": shown only where the community turns it on; addresses and links checked;
// Promissa never handles the money (links and an address only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fundingFields, readFunding, fundingHtml } from '../app/src/funding.js';

const root = (values) => ({ querySelector: (sel) => ({ value: values[sel.match(/data-[a-z]+-([a-z0-9-]+)/)[1]] ?? '' }) });
const on = { fundingLinks: true, chainId: 84532, explorer: 'https://sepolia.basescan.org' };

test('off unless the community turns it on', () => {
  assert.equal(fundingFields({}, 'pet'), '');
  assert.equal(readFunding({}, root({ 'fund-addr': '0x' + '1'.repeat(40) }), 'pet'), undefined);
  assert.equal(fundingHtml({}, { address: '0x' + '1'.repeat(40) }), '');
});

test('valid address and https links only; shown with the no-custody note', () => {
  assert.throws(() => readFunding(on, root({ 'fund-addr': '0x123' }), 'pet'), /0x followed by 40/);
  assert.throws(() => readFunding(on, root({ 'fund-link': 'http://example.org' }), 'pet'), /https/);
  assert.equal(readFunding(on, root({}), 'pet'), undefined);
  const f = readFunding(on, root({ 'fund-addr': '0x' + 'ab'.repeat(20), 'fund-link': 'https://opencollective.com/oak-street' }), 'pet');
  assert.deepEqual(Object.keys(f), ['address', 'links']);
  const html = fundingHtml(on, f);
  assert.match(html, /Give through opencollective\.com/);
  assert.match(html, /never holds, forwards or takes a cut/);
  assert.match(html, /See every payment it received/);
  assert.doesNotMatch(fundingHtml(on, { links: ['javascript:alert(1)'] }), /javascript:/);
});
