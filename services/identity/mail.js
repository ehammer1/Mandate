/**
 * services/identity/mail.js - letters with verification codes, sent to a voter's registered
 * address. Lob (print-and-mail API) sends them in a sealed envelope; nothing is stored here.
 *
 *   MAIL_PROVIDER=lob  LOB_API_KEY=...  MAIL_FROM_NAME, MAIL_FROM_LINE1, MAIL_FROM_CITY,
 *   MAIL_FROM_STATE, MAIL_FROM_ZIP (the city's return address)
 */
'use strict';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function letterHtml({ name, code, community }) {
  return `<html><body style="font-family: Helvetica, Arial, sans-serif; font-size: 13pt; padding: 1in;">
<p>Dear ${esc(name)},</p>
<p>Someone asked to verify your voter registration for <strong>${esc(community)}</strong> in the Mandate app.</p>
<p>If it was you, enter this code in the app, under your membership, within about a month:</p>
<p style="font-size: 26pt; letter-spacing: 4px; font-family: Courier, monospace;"><strong>${esc(code)}</strong></p>
<p>If it wasn't you, do nothing: nobody can verify with your registration without this code. You may wish to tell the city clerk.</p>
</body></html>`;
}

function createLobMailer({ apiKey, from, community, fetchImpl = fetch }) {
  if (!apiKey || !from?.address_line1) throw new Error('LOB_API_KEY and the MAIL_FROM_* return address are required');
  return {
    name: 'lob',
    async send(to, code) {
      const res = await fetchImpl('https://api.lob.com/v1/letters', {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Mandate voter verification', to: { ...to, address_country: 'US' }, from: { ...from, address_country: 'US' }, file: letterHtml({ name: to.name, code, community }), color: false, use_type: 'operational' }),
      });
      if (!res.ok) throw new Error(`lob refused the letter (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    },
  };
}

function createMemoryMailer() {
  const outbox = [];
  return { name: 'memory', outbox, async send(to, code) { outbox.push({ to, code, at: Date.now() }); } };
}

function mailerFromEnv(env = process.env) {
  const p = String(env.MAIL_PROVIDER || '').trim().toLowerCase();
  if (p !== 'lob') return null;
  return createLobMailer({
    apiKey: String(env.LOB_API_KEY || '').trim(),
    community: String(env.MAIL_COMMUNITY || 'your community').trim(),
    from: { name: env.MAIL_FROM_NAME, address_line1: env.MAIL_FROM_LINE1, address_city: env.MAIL_FROM_CITY, address_state: env.MAIL_FROM_STATE, address_zip: env.MAIL_FROM_ZIP },
  });
}

module.exports = { createLobMailer, createMemoryMailer, mailerFromEnv, letterHtml };
