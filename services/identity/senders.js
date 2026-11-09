/**
 * services/identity/senders.js - send sign-up codes by email.
 *
 * EMAIL_PROVIDER = resend | sendgrid | postmark   (EMAIL_API_KEY, EMAIL_FROM)
 * Tests use createMemorySender(), which keeps messages in memory.
 */

'use strict';

const APIS = {
  resend: (key, from, to, subject, text) => ({
    url: 'https://api.resend.com/emails',
    headers: { Authorization: `Bearer ${key}` },
    body: { from, to: [to], subject, text },
  }),
  sendgrid: (key, from, to, subject, text) => ({
    url: 'https://api.sendgrid.com/v3/mail/send',
    headers: { Authorization: `Bearer ${key}` },
    body: { personalizations: [{ to: [{ email: to }] }], from: { email: from }, subject, content: [{ type: 'text/plain', value: text }] },
  }),
  postmark: (key, from, to, subject, text) => ({
    url: 'https://api.postmarkapp.com/email',
    headers: { 'X-Postmark-Server-Token': key, Accept: 'application/json' },
    body: { From: from, To: to, Subject: subject, TextBody: text, MessageStream: 'outbound' },
  }),
};

/** @returns {{ name: string, send(to: string, subject: string, text: string): Promise<void> }} */
function createApiSender({ provider, apiKey, from }) {
  const build = APIS[provider];
  if (!build) throw new Error(`EMAIL_PROVIDER must be one of ${Object.keys(APIS).join(', ')}`);
  if (!apiKey || !from) throw new Error('EMAIL_API_KEY and EMAIL_FROM are required');
  return {
    name: provider,
    async send(to, subject, text) {
      const req = build(apiKey, from, to, subject, text);
      const res = await fetch(req.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...req.headers }, body: JSON.stringify(req.body) });
      if (!res.ok) throw new Error(`${provider} refused the message (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    },
  };
}

function createMemorySender() {
  const outbox = [];
  return {
    name: 'memory',
    outbox,
    async send(to, subject, text) {
      outbox.push({ to, subject, text, at: Date.now() });
    },
    lastCodeFor(to) {
      const m = [...outbox].reverse().find((x) => x.to === to);
      return m && /\b(\d{6})\b/.exec(m.text)?.[1];
    },
  };
}

function senderFromEnv(env = process.env) {
  const provider = String(env.EMAIL_PROVIDER || '').trim().toLowerCase();
  if (!provider) return null;
  return createApiSender({ provider, apiKey: String(env.EMAIL_API_KEY || '').trim(), from: String(env.EMAIL_FROM || '').trim() });
}

module.exports = { createApiSender, createMemorySender, senderFromEnv };
