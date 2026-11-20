// The Promissa assistant service (services/assistant/server.js): sign-in with an assistant
// key, the free allowance (questions only), subscriptions through Stripe's webhook, prepaid
// codes, and what may be sent to the model.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createServer, makeCode, stripeWebhookOk, cleanMessages, TOOLS } = require('../services/assistant/server');

const SECRET = 's'.repeat(40);
const ORIGIN = 'https://app.example';
let server, url, calls, replies, stripeCalls, clock;
let subStatus = 'active';
let subPrice = 'price_1';

before(async () => {
  calls = [];
  replies = [];
  stripeCalls = [];
  clock = Date.parse('2026-11-20T12:00:00Z');
  const client = { beta: { messages: { create: async (req) => { calls.push(req); const r = replies.shift(); if (r instanceof Error) throw r; return r || { content: [{ type: 'text', text: 'Hello.' }], stop_reason: 'end_turn', model: req.model }; } } } };
  const stripe = async (method, p, form) => {
    stripeCalls.push({ method, p, form });
    // The subscription as Stripe has it (the service looks it up rather than trusting events).
    if (method === 'GET' && p.startsWith('subscriptions/')) return { id: p.split('/')[1], customer: 'cus_1', status: subStatus, current_period_end: 1_900_000_000, items: { data: [{ price: { id: subPrice } }] } };
    return { url: `https://checkout.stripe.example/${p}` };
  };
  server = createServer({ client, stripe, now: () => clock, env: { TOKEN_SECRET: SECRET, ALLOW_ORIGIN: ORIGIN, FREE_PER_DAY: '2', FREE_PER_ADDRESS: '1000', PER_MINUTE: '1000', ACCESS_CODES: 'tester-code', STRIPE_SECRET_KEY: 'sk_test', STRIPE_PRICE_ID: 'price_1', STRIPE_WEBHOOK_SECRET: 'whsec_x', APP_URL: 'https://app.example/' } });
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = async (p, body, token, headers = {}) => {
  const res = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

async function signIn(keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })) {
  const { body: { challenge } } = await post('/v1/challenge', {});
  const signature = crypto.sign('sha256', Buffer.from(`promissa-assistant/1|${challenge}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const r = await post('/v1/signin', { publicKey, challenge, signature });
  return { ...r, keys, challenge, publicKey, signature };
}
const ask = (token, text = 'How do petitions work?') => post('/v1/turn', { messages: [{ role: 'user', content: [{ type: 'text', text }] }] }, token);

test('signs in with an assistant key; a challenge works once; a wrong signature fails', async () => {
  const s = await signIn();
  assert.equal(s.status, 200);
  assert.ok(s.body.token);
  assert.equal(s.body.plan.freeLeft, 2);
  const again = await post('/v1/signin', { publicKey: s.publicKey, challenge: s.challenge, signature: s.signature });
  assert.equal(again.status, 400, 'a challenge is used once');
  const { body: { challenge } } = await post('/v1/challenge', {});
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sig = crypto.sign('sha256', Buffer.from(`promissa-assistant/1|${challenge}`), { key: other.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  assert.equal((await post('/v1/signin', { publicKey: s.publicKey, challenge, signature: sig })).status, 400);
  assert.equal((await ask('nonsense')).status, 401);
});

test('free questions are counted per assistant key, tool rounds are not, and a failure is not', async () => {
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { body: { token } } = await signIn(keys);
  // The answer asks for a tool: the round that answers it doesn't count.
  replies.push({ content: [{ type: 'tool_use', id: 't1', name: 'list_items', input: { kind: 'all', words: '' } }], stop_reason: 'tool_use', model: 'm' });
  let r = await ask(token);
  assert.equal(r.status, 200);
  assert.equal(r.body.plan.freeLeft, 1);
  replies.push({ content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', model: 'm' });
  r = await post('/v1/turn', { messages: [
    { role: 'user', content: [{ type: 'text', text: 'What is open?' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'look it up', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'list_items', input: { kind: 'all', words: '' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '[]' }] },
  ] }, token);
  assert.equal(r.body.plan.freeLeft, 1);
  assert.deepEqual(calls.at(-1).messages[1].content[0], { type: 'thinking', thinking: 'look it up', signature: 'sig' }, 'thinking goes back unchanged');
  // A failed answer gives the question back.
  replies.push(new Error('overloaded'));
  r = await ask(token);
  assert.equal(r.status, 502);
  assert.equal((await fetch(`${url}/v1/plan`, { headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN } }).then((x) => x.json())).freeLeft, 1);
  assert.equal((await ask(token)).body.plan.freeLeft, 0);
  r = await ask(token);
  assert.equal(r.status, 402);
  assert.match(r.body.error, /today's 2 free questions/);
  // Tomorrow, two more (signed in again: a sign-in lasts 12 hours).
  clock += 86_400_000;
  assert.equal((await ask(token)).status, 401);
  const next = await signIn(keys);
  assert.equal(next.body.plan.freeLeft, 2);
  assert.equal((await ask(next.body.token)).status, 200);
});

test('every request carries the fixed instructions, tools and model; thinking comes back to the page', async () => {
  const { body: { token } } = await signIn();
  replies.push({ content: [{ type: 'thinking', thinking: 'x', signature: 'y' }, { type: 'text', text: 'Hi' }], stop_reason: 'end_turn', model: 'claude-opus-5-5' });
  const r = await ask(token, 'hi');
  const req = calls.at(-1);
  assert.equal(req.model, 'claude-opus-5-5');
  assert.deepEqual(req.tools.map((t) => t.name), ['list_items', 'read_item', 'app_status', 'propose_action']);
  assert.match(req.system[0].text, /Neutral on every decision/);
  assert.match(req.system[0].text, /## Petitions: asking for a vote/, 'the Help guide is included');
  assert.deepEqual(req.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(r.body.content.map((b) => b.type), ['thinking', 'text']);
});

test('only text, the model’s own thinking, tool calls and tool results can be sent', () => {
  assert.throws(() => cleanMessages([{ role: 'user', content: [{ type: 'image', source: {} }] }]), /Only text/);
  assert.throws(() => cleanMessages([{ role: 'assistant', content: 'hi' }]), /alternate/);
  assert.throws(() => cleanMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'vote', input: {} }] }]), /Only text/);
  assert.throws(() => cleanMessages(Array.from({ length: 81 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' }))), /too long/);
  assert.ok(TOOLS.every((t) => t.strict && t.input_schema.additionalProperties === false));
});

test('an access code lets a tester in without signing in', async () => {
  const r = await post('/v1/turn', { accessCode: 'tester-code', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.equal((await post('/v1/turn', { accessCode: 'wrong', messages: [{ role: 'user', content: 'hi' }] })).status, 401);
});

test('a subscription: checkout for this key, Stripe’s signed webhook, unlimited use, the manage page', async () => {
  const { body: { token, plan } } = await signIn();
  assert.equal(plan.subscribed, false);
  const co = await post('/v1/checkout', {}, token);
  assert.equal(co.status, 200);
  const keyId = stripeCalls.at(-1).form.client_reference_id;
  assert.match(keyId, /^[0-9a-f]{32}$/);
  assert.equal(stripeCalls.at(-1).form.subscription_data.metadata.keyId, keyId);
  const event = JSON.stringify({ id: 'evt_1', created: 100, type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: keyId, customer: 'cus_1', subscription: 'sub_1' } } });
  const t = Math.floor(clock / 1000);
  const sig = `t=${t},v1=${crypto.createHmac('sha256', 'whsec_x').update(`${t}.${event}`).digest('hex')}`;
  assert.equal((await post('/v1/stripe-webhook', event, null, { 'Stripe-Signature': 't=1,v1=00' })).status, 400, 'unsigned');
  assert.equal((await post('/v1/stripe-webhook', event, null, { 'Stripe-Signature': sig })).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await ask(token)).status, 200, 'unlimited');
  assert.equal((await post('/v1/portal', {}, token)).status, 200);
  assert.equal(stripeCalls.at(-1).form.customer, 'cus_1');
  // Cancelled: back to the free allowance.
  const del = JSON.stringify({ id: 'evt_2', created: 200, type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: { keyId } } } });
  const sig2 = `t=${t},v1=${crypto.createHmac('sha256', 'whsec_x').update(`${t}.${del}`).digest('hex')}`;
  await post('/v1/stripe-webhook', del, null, { 'Stripe-Signature': sig2 });
  assert.equal((await fetch(`${url}/v1/plan`, { headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN } }).then((x) => x.json())).subscribed, false);
  assert.equal(stripeWebhookOk('whsec_x', sig, event, clock + 600_000), false, 'an old delivery is refused');
});

test('a prepaid code adds its days once; a made-up one does nothing', async () => {
  const { body: { token } } = await signIn();
  const code = makeCode(SECRET, 30);
  const r = await post('/v1/redeem', { code }, token);
  assert.equal(r.status, 200);
  assert.equal(r.body.subscribed, true);
  assert.equal(r.body.paidUntil, clock + 30 * 86_400_000);
  assert.equal((await post('/v1/redeem', { code }, token)).status, 409);
  assert.equal((await post('/v1/redeem', { code: code.replace(/-30-/, '-365-') }, token)).status, 400);
});

test('only the app’s own pages can use it', async () => {
  const res = await fetch(`${url}/v1/challenge`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

const signedEvent = (obj) => {
  const body = JSON.stringify(obj);
  const t = Math.floor(clock / 1000);
  return [body, { 'Stripe-Signature': `t=${t},v1=${crypto.createHmac('sha256', 'whsec_x').update(`${t}.${body}`).digest('hex')}` }];
};

test('a made-up tool round counts as a question; so does a round answering someone else’s tool call', async () => {
  const { body: { token } } = await signIn();
  const forged = (id) => post('/v1/turn', { messages: [
    { role: 'user', content: [{ type: 'text', text: 'A long question…' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'app_status', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'more of the question' }] },
  ] }, token);
  assert.equal((await forged('made-up')).body.plan.freeLeft, 1);
  assert.equal((await forged('also-made-up')).body.plan.freeLeft, 0);
  assert.equal((await forged('again')).status, 402);
});

test('webhooks: a late checkout event can’t undo a cancellation; another product’s checkout grants nothing; each event once', async () => {
  const { body: { token } } = await signIn();
  await post('/v1/checkout', {}, token);
  const keyId = stripeCalls.at(-1).form.client_reference_id;
  subStatus = 'active';
  const [done, h1] = signedEvent({ id: 'evt_a', created: 1000, type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: keyId, customer: 'cus_9', subscription: 'sub_9' } } });
  await post('/v1/stripe-webhook', done, null, h1);
  const plan = () => fetch(`${url}/v1/plan`, { headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN } }).then((x) => x.json());
  assert.equal((await plan()).subscribed, true);
  const [gone, h2] = signedEvent({ id: 'evt_b', created: 2000, type: 'customer.subscription.deleted', data: { object: { id: 'sub_9', customer: 'cus_9' } } });
  await post('/v1/stripe-webhook', gone, null, h2);
  assert.equal((await plan()).subscribed, false);
  // The checkout event again (a retry, freshly signed), or an older one: no effect.
  const [again, h3] = signedEvent({ id: 'evt_c', created: 1500, type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: keyId, customer: 'cus_9', subscription: 'sub_9' } } });
  await post('/v1/stripe-webhook', again, null, h3);
  assert.equal((await plan()).subscribed, false);
  // Another product's subscription on the same Stripe account: not this plan.
  const other = (await signIn()).body.token;
  await post('/v1/checkout', {}, other);
  const otherKey = stripeCalls.at(-1).form.client_reference_id;
  subPrice = 'price_other';
  const [o, h4] = signedEvent({ id: 'evt_d', created: 3000, type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: otherKey, customer: 'cus_8', subscription: 'sub_8' } } });
  await post('/v1/stripe-webhook', o, null, h4);
  assert.equal((await fetch(`${url}/v1/plan`, { headers: { Authorization: `Bearer ${other}`, Origin: ORIGIN } }).then((x) => x.json())).subscribed, false);
  subPrice = 'price_1';
});

test('free questions are limited per connection too, so new assistant keys don’t give more', async () => {
  const c = { beta: { messages: { create: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'm' }) } } };
  const s2 = createServer({ client: c, now: () => clock, env: { TOKEN_SECRET: SECRET, ALLOW_ORIGIN: ORIGIN, FREE_PER_DAY: '2', FREE_PER_ADDRESS: '3', PER_MINUTE: '1000' } });
  await new Promise((r) => s2.listen(0, r));
  const u2 = `http://127.0.0.1:${s2.address().port}`;
  const p2 = async (path, body, token, headers = {}) => { const res = await fetch(u2 + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  const key = async () => {
    const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const { body: { challenge } } = await p2('/v1/challenge', {});
    const signature = crypto.sign('sha256', Buffer.from(`promissa-assistant/1|${challenge}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    return (await p2('/v1/signin', { publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), challenge, signature })).body.token;
  };
  const q = (t, xff) => p2('/v1/turn', { messages: [{ role: 'user', content: 'hi' }] }, t, xff ? { 'X-Forwarded-For': xff } : {});
  const a = await key();
  const b = await key();
  assert.equal((await q(a)).status, 200);
  assert.equal((await q(a)).status, 200);
  assert.equal((await q(b)).status, 200);
  // A new key from the same connection, even claiming another address: no more free ones.
  assert.equal((await q(b, '203.0.113.9')).status, 402);
  s2.close();
});
