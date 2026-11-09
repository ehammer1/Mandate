/**
 * services/identity/email-policy.js - which email domains may join through online sign-in.
 *
 * Basic membership is spam control, so the bar is "a real, reputable mailbox":
 * the large providers that verify sign-ups and fight abuse, plus government and
 * education domains. Throwaway-mail services are always refused.
 *
 * Configure with EMAIL_DOMAINS_ALLOW / EMAIL_DOMAINS_BLOCK (comma-separated):
 *   reputable            the preset below
 *   example.org          one domain (and only that domain)
 *   *.example.org        any subdomain of example.org (and example.org itself)
 *   *.gov                any domain ending in .gov
 * Leaving EMAIL_DOMAINS_ALLOW empty allows any domain (blocklist still applies).
 */

'use strict';

/** Large consumer providers with sign-up verification and abuse controls, plus .gov/.edu. */
const REPUTABLE = [
  // Google
  'gmail.com', 'googlemail.com',
  // Microsoft
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  // Apple
  'icloud.com', 'me.com', 'mac.com',
  // Yahoo / AOL
  'yahoo.com', 'ymail.com', 'rocketmail.com', 'aol.com',
  // Privacy-focused paid or verified providers
  'proton.me', 'protonmail.com', 'pm.me', 'fastmail.com', 'fastmail.fm', 'tuta.com', 'tutanota.com',
  // Other established providers
  'zoho.com', 'gmx.com', 'gmx.us', 'mail.com',
  // US internet providers
  'comcast.net', 'att.net', 'sbcglobal.net', 'verizon.net', 'cox.net', 'charter.net', 'spectrum.net',
  // Public institutions
  '*.gov', '*.edu', '*.mil', '*.k12.*.us',
];

/** Well-known throwaway-mail services; always refused even if allowed elsewhere. */
const DISPOSABLE = [
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', 'grr.la', '10minutemail.com',
  'temp-mail.org', 'tempmail.com', 'tempmailo.com', 'yopmail.com', 'trashmail.com', 'getnada.com', 'nada.email',
  'dispostable.com', 'maildrop.cc', 'mailnesia.com', 'throwawaymail.com', 'fakeinbox.com', 'mohmal.com',
  'emailondeck.com', 'mintemail.com', 'spamgourmet.com', 'tmail.ws', 'tmpmail.org', 'burnermail.io',
];

function parseList(text) {
  const out = [];
  for (const raw of String(text || '').split(',')) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (t === 'reputable') out.push(...REPUTABLE);
    else out.push(t);
  }
  return out;
}

/** Does `domain` match a pattern? Exact, "*.suffix" (suffix and its subdomains), or "*.k12.*.us"-style. */
function matches(domain, pattern) {
  if (!pattern.includes('*')) return domain === pattern;
  const re = new RegExp(`^(?:[a-z0-9-]+\\.)*${pattern.replace(/^\*\./, '').split('.').map((p) => (p === '*' ? '[a-z0-9-]+' : p.replace(/[-]/g, '\\-'))).join('\\.')}$`);
  return re.test(domain);
}

/**
 * @param {{ allow?: string|string[], block?: string|string[] }} [opts]
 * @returns {{ check(email: string): { ok: boolean, reason?: string }, allow: string[], block: string[] }}
 */
function createEmailPolicy(opts = {}) {
  const allow = Array.isArray(opts.allow) ? opts.allow.map((s) => s.toLowerCase()) : parseList(opts.allow);
  const block = [...DISPOSABLE, ...(Array.isArray(opts.block) ? opts.block.map((s) => s.toLowerCase()) : parseList(opts.block))];
  return {
    allow,
    block,
    check(email) {
      const m = /^[^@\s]+@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(String(email || '').trim());
      if (!m) return { ok: false, reason: 'no valid email address was provided' };
      const domain = m[1].toLowerCase();
      if (block.some((p) => matches(domain, p))) return { ok: false, reason: `${domain} is a temporary-email service` };
      if (allow.length && !allow.some((p) => matches(domain, p))) return { ok: false, reason: `${domain} is not on the list of accepted email providers` };
      return { ok: true };
    },
  };
}

/**
 * One mailbox, one identity: fold the aliases that deliver to the same inbox.
 *   "+tags" are dropped everywhere (you+news@x.com -> you@x.com);
 *   Gmail also ignores dots, and googlemail.com is gmail.com.
 */
function normalizeEmail(email) {
  const m = /^([^@\s]+)@([a-z0-9.-]+)$/i.exec(String(email || '').trim());
  if (!m) return null;
  let [, local, domain] = m;
  local = local.toLowerCase().split('+')[0];
  domain = domain.toLowerCase();
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local ? `${local}@${domain}` : null;
}

module.exports = { createEmailPolicy, normalizeEmail, REPUTABLE, DISPOSABLE, matches };
