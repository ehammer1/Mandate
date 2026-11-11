// Every organization template produces bodies the Bodies contract accepts (with and without an executive).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ORG_TEMPLATES } from '../app/src/org-templates.js';
import { TEMPLATES } from '../app/src/bodies.js';

const require = createRequire(import.meta.url);
const ganache = require('ganache');
const { ethers } = require('ethers');
const { deployAll } = require('../scripts/deploy.js');

test('organization templates: every body is valid, executives get a deadline, chains point forward', async () => {
  const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  const admin = await provider.getSigner(0);
  const { contracts: c } = await deployAll(admin, {});
  let n = 0;
  for (const [key, t] of Object.entries(ORG_TEMPLATES)) {
    assert.ok(t.label && t.about && t.bodies.length, key);
    for (const [i, b] of t.bodies.entries()) {
      assert.ok(TEMPLATES[b.base], `${key}: unknown base ${b.base}`);
      if (b.then !== undefined) assert.ok(b.then > i && b.then < t.bodies.length, `${key}: "then" must point to a later body`);
      const { label, ...base } = TEMPLATES[b.base];
      const r = { ...base, ...Object.fromEntries(Object.entries(b).filter(([k]) => k in base)) };
      for (const executive of b.executive ? [ethers.ZeroAddress, admin.address] : [ethers.ZeroAddress]) {
        const rules = {
          ...r, name: b.name.replace('{org}', 'Test'), kind: base.kind || b.base, executive,
          executiveMinutes: executive === ethers.ZeroAddress ? 0 : r.executiveMinutes || 14400, overridePct: executive === ethers.ZeroAddress ? 0 : r.overridePct,
          explainDissent: r.explainDissent && r.residentTier !== 255, clerk: ethers.ZeroAddress, active: true,
        };
        await c.bodies.createBody.staticCall(rules).catch((e) => assert.fail(`${key} / ${rules.name} (${label}): ${c.bodies.interface.parseError(e.data)?.name || e.message}`));
        n++;
      }
    }
  }
  assert.ok(n > 20);
});
