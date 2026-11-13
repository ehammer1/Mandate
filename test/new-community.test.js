// Many communities on one platform: each gets its own contracts and council, the deployer keeps
// no power, and one running relay serves each community under /c/<slug> without mixing them.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { createCommunity, communityConfig, addToIndex, normalizeSpec, normalizeDomain, setDomain } = require('../scripts/new-community');
const { createRelayer } = require('../broker/relayer');
const { createRouter, syncCommunities } = require('../services/lib/communities');

let provider, deployer, members, clerk, relayerSigner;
const ADMIN = ethers.ZeroHash;
const made = {};

before(async () => {
  provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai', allowUnlimitedContractSize: true } }), undefined, { cacheTimeout: -1 });
  const s = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => provider.getSigner(i)));
  [deployer, , , , clerk, relayerSigner] = s;
  members = [s[1].address, s[2].address, s[3].address];
  for (const [slug, name] of [['lincoln-high', 'Lincoln High School PTA'], ['ward-3', 'Ward 3 Residents']]) {
    made[slug] = await createCommunity(deployer, { slug, name, council: { members, threshold: 2, delayHours: 1 }, clerks: [{ address: clerk.address, name: 'Front office' }], pollOpeners: [clerk.address], groupCreators: [clerk.address], seasoningDays: 1, rules: { MIN_POLL_MINUTES: 10, BINDING_QUORUM_PCT: 0 } }, { signupIssuer: relayerSigner.address });
  }
});

test('a spec is checked before anything is spent', () => {
  assert.throws(() => normalizeSpec({ slug: 'Bad Slug', name: 'x', council: { members } }), /slug/);
  assert.throws(() => normalizeSpec({ slug: 'ok-one', name: '', council: { members } }), /name/);
  assert.throws(() => normalizeSpec({ slug: 'ok-one', name: 'X', council: { members: [] } }), /council member/);
  assert.throws(() => normalizeSpec({ slug: 'ok-one', name: 'X', council: { members, threshold: 9 } }), /threshold/);
  assert.throws(() => normalizeSpec({ slug: 'ok-one', name: 'X', council: { members }, seasoningDays: 0 }), /1 to 365/);
  assert.equal(normalizeSpec({ slug: 'ok-one', name: 'X', council: { members } }).council.threshold, 2);
});

test('each community has its own contracts, run by its own council; the deployer keeps nothing', async () => {
  const a = made['lincoln-high'].addresses;
  const b = made['ward-3'].addresses;
  for (const k of ['vote', 'identity', 'council', 'tallies', 'voterGroups']) assert.notEqual(a[k], b[k], `${k} is shared`);
  const abi = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'build', `${n}.json`), 'utf8')).abi;
  const at = (n, x) => new ethers.Contract(x, abi(n), provider);
  for (const [name, key] of [['IdentityRegistry', 'identity'], ['MandateVote', 'vote'], ['Tallies', 'tallies'], ['VoterGroups', 'voterGroups'], ['Bodies', 'bodies'], ['Officials', 'officials'], ['Charter', 'charter']]) {
    const k = at(name, a[key]);
    assert.equal(await k.hasRole(ADMIN, a.council), true, `council not admin of ${key}`);
    assert.equal(await k.hasRole(ADMIN, deployer.address), false, `deployer still admin of ${key}`);
  }
  const vote = at('MandateVote', a.vote);
  assert.equal(await vote.hasRole(await vote.PROPOSER_ROLE(), deployer.address), false);
  assert.equal(await vote.hasRole(await vote.PROPOSER_ROLE(), clerk.address), true);
  const identity = at('IdentityRegistry', a.identity);
  assert.equal((await identity.issuers(clerk.address)).active, true);
  assert.equal((await identity.issuers(relayerSigner.address)).name, 'Online sign-up');
  const council = at('Council', a.council);
  assert.deepEqual([...(await council.members())], members);
  assert.equal(Number(await council.threshold()), 2);
});

test('the app config and the community list point at the right community', () => {
  const spec = normalizeSpec({ slug: 'ward-3', name: 'Ward 3 Residents', council: { members } });
  const cfg = communityConfig(spec, made['ward-3'].addresses, 7, { chainId: 1337, rpcUrl: 'http://x', chainName: 'test' }, { relayers: ['https://relay.example/'], identity: 'https://id.example', watchdogBase: 'https://raw.example/watchdog' });
  assert.equal(cfg.voteAddress, made['ward-3'].addresses.vote);
  assert.deepEqual(cfg.relayers, ['https://relay.example/c/ward-3']);
  assert.equal(cfg.identityService, 'https://id.example/c/ward-3');
  assert.equal(cfg.watchdogAlertsUrl, 'https://raw.example/watchdog/c/ward-3/alerts.json');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'communities-'));
  addToIndex(path.join(dir, 'index.json'), spec);
  addToIndex(path.join(dir, 'index.json'), { slug: 'lincoln-high', name: 'Lincoln High School PTA' });
  addToIndex(path.join(dir, 'index.json'), spec); // again: replaced, not duplicated
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).communities.map((c) => c.slug), ['lincoln-high', 'ward-3']);
});

test('a community can have its own web address', () => {
  assert.equal(normalizeDomain('https://Vote.LincolnHigh.org/'), 'vote.lincolnhigh.org');
  assert.equal(normalizeDomain(''), '');
  for (const bad of ['lincolnhigh', 'vote lincoln.org', 'me.github.io', 'http://']) assert.throws(() => normalizeDomain(bad), /web address/);
  const spec = normalizeSpec({ slug: 'lincoln-high', name: 'Lincoln High School PTA', council: { members }, domain: 'vote.lincolnhigh.org' });
  assert.equal(communityConfig(spec, made['lincoln-high'].addresses, 1).appUrl, 'https://vote.lincolnhigh.org/');
  assert.equal(communityConfig({ ...spec, domain: '' }, made['lincoln-high'].addresses, 1).appUrl, 'https://ehammer1.github.io/Mandate/?org=lincoln-high');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domains-'));
  const index = () => JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).communities;
  fs.writeFileSync(path.join(dir, 'ward-3.json'), JSON.stringify({ communityName: 'Ward 3 Residents', appUrl: 'https://ehammer1.github.io/Mandate/?org=ward-3' }));
  addToIndex(path.join(dir, 'index.json'), spec);
  assert.equal(index()[0].domain, 'vote.lincolnhigh.org');
  addToIndex(path.join(dir, 'index.json'), { slug: 'lincoln-high', name: 'Lincoln High School PTA' }); // no domain given: kept
  assert.equal(index()[0].domain, 'vote.lincolnhigh.org');
  assert.throws(() => addToIndex(path.join(dir, 'index.json'), { slug: 'ward-3', name: 'Ward 3', domain: 'vote.lincolnhigh.org' }), /already used/);
  assert.equal(setDomain(dir, 'ward-3', 'ward3.example.org'), 'https://ward3.example.org/');
  assert.equal(index().find((c) => c.slug === 'ward-3').domain, 'ward3.example.org');
  assert.equal(setDomain(dir, 'ward-3', ''), 'https://ehammer1.github.io/Mandate/?org=ward-3'); // and back
  assert.equal(index().find((c) => c.slug === 'ward-3').domain, undefined);
  assert.throws(() => setDomain(dir, 'nobody', 'x.example.org'), /no community/);
});

test('one relay serves every community under its own path, without mixing them', async () => {
  const a = made['lincoln-high'].addresses;
  const b = made['ward-3'].addresses;
  // A poll exists only in Lincoln High.
  const vote = new ethers.Contract(a.vote, JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'build', 'MandateVote.json'), 'utf8')).abi, clerk);
  const identity = new ethers.Contract(a.identity, JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'build', 'IdentityRegistry.json'), 'utf8')).abi, clerk);
  await (await identity.enroll(123456789n, 1, ethers.id('doc-1'), 0)).wait();
  await (await vote.createPoll(await identity.groupId(1), 86_400, 1, 2, 0, '0x', 'Later start time?', 0)).wait();
  const relay = (v) => createRelayer({ provider, signer: relayerSigner, voteAddress: v, log: () => {} }).listeners('request')[0];
  const router = createRouter(relay(a.vote));
  const configs = { 'https://app.example/communities/index.json': { communities: [{ slug: 'lincoln-high' }, { slug: 'ward-3' }, { slug: 'Bad Slug' }] }, 'https://app.example/communities/lincoln-high.json': { voteAddress: a.vote, identityAddress: a.identity }, 'https://app.example/communities/ward-3.json': { voteAddress: b.vote, identityAddress: b.identity } };
  const list = await syncCommunities(router, 'https://app.example/communities/index.json', (c) => relay(c.voteAddress), { fetchJson: async (u) => configs[u] });
  assert.deepEqual(list.map((c) => c.slug), ['lincoln-high', 'ward-3']);
  const server = http.createServer(router);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await fetch(base + p)).status;
  try {
    assert.equal(await get('/c/lincoln-high/poll/1'), 200);
    assert.notEqual(await get('/c/ward-3/poll/1'), 200); // Ward 3 has no poll 1
    assert.equal(await get('/c/nowhere/poll/1'), 404);
    assert.equal(await get('/poll/1'), 200); // the default community
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
