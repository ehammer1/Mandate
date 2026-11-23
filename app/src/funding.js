/**
 * app/src/funding.js - "Support this": a campaign's or proposal's own crypto address on Base and
 * its own fundraising links (GoFundMe, Open Collective, Stripe payment link…). Promissa only
 * shows them: it never holds, converts, forwards or takes a cut of any money, and payments go
 * straight from the supporter to the campaign. Off unless the community's config sets
 * fundingLinks: true (pending legal review before real use).
 */

import { ethers } from 'ethers';

const enabled = (cfg) => cfg?.fundingLinks === true;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Form fields (inside a creation form); `p` prefixes the data attributes. */
export function fundingFields(cfg, p) {
  if (!enabled(cfg)) return '';
  return `<details><summary>Accept support for this (optional)</summary><div class="stack">
    <p class="note">Supporters pay you directly; Promissa never holds or forwards money. If this is a political campaign, you are responsible for following campaign-finance law (limits, donor disclosure, no foreign contributions).</p>
    <label>Your crypto address on Base (0x…), for ETH or USDC <input type="text" data-${p}-fund-addr spellcheck="false" autocomplete="off" /></label>
    <label>Fundraising link (https://…), e.g. GoFundMe, Open Collective, a Stripe payment link <input type="url" data-${p}-fund-link /></label>
    <label>Another link (optional) <input type="url" data-${p}-fund-link2 /></label>
  </div></details>`;
}

/** The funding part of a published document, or undefined; throws a plain message if invalid. */
export function readFunding(cfg, root, p) {
  if (!enabled(cfg)) return undefined;
  const v = (a) => root.querySelector(`[data-${p}-${a}]`)?.value.trim() || '';
  const address = v('fund-addr');
  const links = [v('fund-link'), v('fund-link2')].filter(Boolean);
  if (!address && !links.length) return undefined;
  if (address && !ethers.isAddress(address)) throw new Error('The crypto address should be 0x followed by 40 characters.');
  for (const l of links) if (!/^https:\/\/[^\s]+$/.test(l)) throw new Error('Fundraising links must start with https://');
  return { ...(address ? { address: ethers.getAddress(address) } : {}), ...(links.length ? { links } : {}) };
}

/** "Support this" box for a document with funding details. */
export function fundingHtml(cfg, funding) {
  if (!enabled(cfg) || !funding || (!funding.address && !funding.links?.length)) return '';
  const chain = Number(cfg.chainId || 8453);
  const addr = funding.address && ethers.isAddress(funding.address) ? ethers.getAddress(funding.address) : null;
  const links = (funding.links || []).filter((l) => /^https:\/\/[^\s]+$/.test(l)).slice(0, 3);
  const host = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch {
      return 'link';
    }
  };
  return `<details class="card"><summary><strong>💛 Support this</strong></summary><div class="stack">
    ${addr ? `<p>Crypto on ${chain === 8453 ? 'Base' : `network ${chain}`} (ETH or USDC): <span class="addr">${esc(addr)}</span> <button type="button" class="copy" data-copy="${esc(addr)}">Copy</button>${cfg.explorer ? ` <a href="${esc(`${cfg.explorer.replace(/\/+$/, '')}/address/${addr}`)}" target="_blank" rel="noopener">See every payment it received</a>` : ''}</p>` : ''}
    ${links.map((l) => `<p><a href="${esc(l)}" target="_blank" rel="noopener">Give through ${esc(host(l))}</a></p>`).join('')}
    <p class="note">Payments go straight to the organizers; Promissa never holds, forwards or takes a cut of any money. Check who you are giving to. Political campaigns must follow campaign-finance law. Crypto sent to the wrong network or address can't be recovered.</p>
  </div></details>`;
}
