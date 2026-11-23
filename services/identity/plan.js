/**
 * services/identity/plan.js - is this person a Promissa Plus subscriber? Asks the assistant
 * service (which handles the subscription through Stripe) with the token the app sends in the
 * X-Promissa-Plan header. That token comes from the separate assistant key, never the voter key,
 * so a subscription can't be linked to a vote. Answers are cached for 10 minutes.
 */
'use strict';

function createPlanCheck({ url, fetch: doFetch = fetch, ttlMs = 600_000, now = () => Date.now() } = {}) {
  const cache = new Map();
  return async function isPlus(token) {
    const t = String(token || '').trim();
    if (!url || !t || t.length > 2000) return false;
    const hit = cache.get(t);
    if (hit && now() - hit.at < ttlMs) return hit.plus;
    let plus = false;
    try {
      const res = await doFetch(`${url.replace(/\/+$/, '')}/v1/plan`, { headers: { Authorization: `Bearer ${t}` } });
      plus = res.ok ? !!(await res.json()).subscribed : false;
    } catch {
      plus = false;
    }
    if (cache.size > 5000) cache.clear();
    cache.set(t, { plus, at: now() });
    return plus;
  };
}

module.exports = { createPlanCheck };
