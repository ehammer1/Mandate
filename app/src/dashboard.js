/**
 * app/src/dashboard.js - the live public dashboard (app/dashboard.html).
 *
 * Read-only: everything comes from public contract views (no event-log scans, which
 * public RPCs limit) plus the watchdog's published alerts. No sign-in, no voter data.
 */

import { ethers } from 'ethers';
import { describeCall, COUNCIL_ABI } from './council.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;
const when = (secs) => new Date(Number(secs) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const day = (secs) => new Date(Number(secs) * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' });
const num = (n) => Number(n).toLocaleString();
const pct = (a, b) => (Number(b) ? Math.round((Number(a) / Number(b)) * 100) : 0);

const IDENTITY_ABI = [
  'function leafCount(uint8) view returns (uint256)',
  'function leaves(uint8, uint256, uint256) view returns (uint256[] commitments, uint64[] removedAt)',
  'function groupId(uint8) view returns (uint256)',
  'function getRoleMemberCount(bytes32) view returns (uint256)',
  'function getRoleMember(bytes32, uint256) view returns (address)',
  'function issuers(address) view returns (uint8 maxTier, bool active, string name)',
];
const VOTE_ABI = [
  'function pollCount() view returns (uint256)',
  'function getPoll(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 quorum, uint8 options, uint8 action, bool finalized, bool passed, address proposer, uint256 bond, string questionCID, bytes actionData))',
  'function tally(uint256) view returns (uint256[])',
];
const REGISTRY_ABI = [
  'function mandateCount() view returns (uint256)',
  'function getMandate(uint256) view returns (tuple(address responsible, uint64 createdAt, uint64 deadline, uint64 settledAt, uint16 threshold, uint8 status, uint32 round, uint32 approvals, uint32 rejections, bytes32 category, string specCID, string evidenceCID))',
  'function isOverdue(uint256) view returns (bool)',
];
const GROUP_NAMES = ['All members', 'ID-checked residents', 'Residents with full voting rights'];
const ACTIONS = ['Advisory', 'Binding: veto a market decision', 'Binding: create a mandate', 'Binding: repeal a mandate'];
const MANDATE_STATUS = ['', 'In progress', 'Under review', 'Fulfilled', 'Repealed'];
const COUNCIL_STATES = ['', 'Collecting approvals', 'Waiting period', 'Ready to run', 'Done', 'Cancelled', 'Expired'];
const SEV = { high: '▲ Urgent', medium: '● Notable', info: '○ Info' };
const ISSUER_ROLE = ethers.id('ISSUER_ROLE');

const state = { cfg: null, provider: null, alerts: [], sev: 'all' };

function link(kind, value, label) {
  const base = state.cfg.explorer;
  return base ? `<a href="${esc(base)}/${kind}/${esc(value)}" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label);
}

async function question(cid) {
  try {
    const res = await fetch(`${state.cfg.ipfsGateway.replace(/\/+$/, '')}/ipfs/${cid}`);
    if (!res.ok) throw new Error();
    const q = await res.json();
    return { title: String(q.title || 'Untitled question'), options: Array.isArray(q.options) ? q.options.map(String) : null };
  } catch {
    return { title: `Question ${cid.slice(0, 12)}…`, options: null };
  }
}

/** Active members per group, from the registry's leaf mirror (removed members excluded). */
async function activeCount(identity, tier) {
  const total = Number(await identity.leafCount(tier));
  let active = 0;
  for (let start = 0; start < total; start += 500) {
    const [, removedAt] = await identity.leaves(tier, start, Math.min(500, total - start));
    active += removedAt.filter((r) => r === 0n).length;
  }
  return active;
}

function tile(n, label, sub = '') {
  return `<div class="tile"><div class="n">${esc(n)}</div><div class="l">${esc(label)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`;
}

async function renderPolls(vote, groupIds, now) {
  const count = Number(await vote.pollCount());
  const box = $('polls');
  if (!count) {
    box.innerHTML = '<div class="card"><p class="muted">No polls yet.</p></div>';
    return { open: 0, total: 0 };
  }
  let open = 0;
  const cards = [];
  for (let id = count; id >= Math.max(1, count - 19); id--) {
    const [p, t] = await Promise.all([vote.getPoll(id), vote.tally(id)]);
    const q = await question(p.questionCID);
    const n = Number(p.options);
    const labels = q.options?.length === n ? q.options : n === 2 ? ['Yes', 'No'] : Array.from({ length: n }, (_, i) => `Choice ${i + 1}`);
    const ballots = t.reduce((a, b) => a + Number(b), 0);
    const isOpen = !p.finalized && Number(p.end) > now;
    if (isOpen) open++;
    const status = isOpen ? `Open until ${when(p.end)}` : p.finalized ? (p.passed ? 'Closed: passed' : 'Closed: did not pass') : 'Voting ended, result not yet recorded';
    const who = GROUP_NAMES[groupIds.indexOf(String(p.groupId))] || 'Members';
    const rows = labels
      .map((label, i) => {
        const v = Number(t[i] || 0);
        const share = pct(v, ballots);
        return `<span>${esc(label)}</span><span class="track" role="img" aria-label="${esc(label)}: ${v} votes, ${share}%" title="${esc(label)}: ${v} votes (${share}%)"><span class="fill" style="display:block;width:${share}%"></span></span><span class="v">${num(v)} · ${share}%</span>`;
      })
      .join('');
    cards.push(`<div class="card" id="dash-poll-${id}">
      <p class="eyebrow">Poll ${id} · ${esc(status)} · ${esc(who)}</p>
      <h3>${esc(q.title)}</h3>
      <p class="meta">${esc(ACTIONS[Number(p.action)] || 'Advisory')}</p>
      <div class="tally">${rows}</div>
      <p class="meta">${num(ballots)} of ${num(p.electorate)} eligible voted (${pct(ballots, p.electorate)}% turnout) · needs ${num(p.quorum)} to count</p>
    </div>`);
  }
  box.innerHTML = cards.join('');
  return { open, total: count };
}

async function renderCouncil() {
  const box = $('council');
  if (!state.cfg.councilAddress) {
    box.innerHTML = '<p class="muted">No council on this deployment.</p>';
    return 0;
  }
  const c = new ethers.Contract(state.cfg.councilAddress, COUNCIL_ABI, state.provider);
  const [members, threshold, delay, count] = await Promise.all([c.members(), c.threshold(), c.delay(), c.proposalCount()]);
  let pending = 0;
  const items = [];
  for (let id = Number(count); id >= Math.max(1, Number(count) - 9); id--) {
    const [p, s, approvals] = await c.proposal(id);
    const st = Number(s);
    if (st >= 1 && st <= 3) pending++;
    const timing = st === 2 ? ` · can run from ${when(p.readyAt)}` : st === 3 ? ' · can run now' : '';
    items.push(`<li><p class="eyebrow">#${id} · ${esc(COUNCIL_STATES[st])}${st >= 1 && st <= 3 ? ` · ${approvals} of ${threshold} approvals` : ''}${esc(timing)}</p>
      <p><strong>${esc(describeCall(state.cfg, p.target, p.data))}</strong></p>
      ${p.description ? `<p class="meta">Reason given: ${esc(p.description)}</p>` : ''}
      <p class="meta">Proposed ${esc(when(p.proposedAt))} by <span class="addr">${esc(short(p.proposer))}</span></p></li>`);
  }
  const hours = Number(delay) / 3600;
  box.innerHTML = `<p>${members.length} members · ${threshold} must approve each change · then a public wait of ${hours >= 1 ? `${hours} hour${hours === 1 ? '' : 's'}` : `${Math.round(Number(delay) / 60)} minutes`}</p>
    <details><summary>Members</summary><ul>${members.map((m) => `<li class="addr">${link('address', m, m)}</li>`).join('')}</ul></details>
    ${items.length ? `<ul class="list">${items.join('')}</ul>` : '<p class="muted">No changes proposed yet.</p>'}`;
  return pending;
}

async function renderMandates() {
  const box = $('mandates');
  if (!state.cfg.registryAddress) {
    box.innerHTML = '<p class="muted">Not deployed.</p>';
    return { active: 0, total: 0 };
  }
  const r = new ethers.Contract(state.cfg.registryAddress, REGISTRY_ABI, state.provider);
  const count = Number(await r.mandateCount());
  if (!count) {
    box.innerHTML = '<p class="muted">No mandates yet. A mandate is created when a binding poll passes or a decision market chooses one.</p>';
    return { active: 0, total: 0 };
  }
  let active = 0;
  const rows = [];
  for (let id = count; id >= Math.max(1, count - 19); id--) {
    const [m, overdue] = await Promise.all([r.getMandate(id), r.isOverdue(id)]);
    const st = Number(m.status);
    if (st === 1 || st === 2) active++;
    const label = overdue ? '▲ Overdue' : MANDATE_STATUS[st] || '';
    rows.push(`<tr><td>${id}</td><td class="addr">${link('address', m.responsible, short(m.responsible))}</td><td>${esc(day(m.deadline))}</td><td>${esc(label)}</td><td class="num">${m.approvals} / ${m.threshold}</td></tr>`);
  }
  box.innerHTML = `<table class="data"><thead><tr><th>#</th><th>Responsible</th><th>Deadline</th><th>Status</th><th class="num">Checks passed</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  return { active, total: count };
}

async function renderSources(identity) {
  const n = Number(await identity.getRoleMemberCount(ISSUER_ROLE));
  const items = [];
  for (let i = 0; i < n; i++) {
    const a = await identity.getRoleMember(ISSUER_ROLE, i);
    const iss = await identity.issuers(a);
    items.push(`<li><strong>${esc(iss.name || 'Unnamed')}</strong> · ${Number(iss.maxTier) >= 1 ? 'in-person or ID-proofed: can give full voting rights' : 'online sign-up: basic members only'}<br><span class="addr">${link('address', a, a)}</span></li>`);
  }
  $('sources').innerHTML = items.length ? `<ul class="list">${items.join('')}</ul>` : '<p class="muted">None approved yet.</p>';
}

function renderAlerts() {
  const box = $('alerts');
  const list = state.alerts.filter((a) => state.sev === 'all' || a.severity === state.sev).slice(0, 30);
  if (state.alertsError) {
    box.innerHTML = `<p class="muted">${esc(state.alertsError)}</p>`;
    return;
  }
  box.innerHTML = list.length
    ? list
        .map((a) => `<div class="alert"><span class="sev ${esc(a.severity)}">${esc(SEV[a.severity] || a.severity)}</span> <span class="meta">${esc(when(a.time))}${a.tx ? ` · ${link('tx', a.tx, 'transaction')}` : ''}</span><p>${esc(a.title)}</p></div>`)
        .join('')
    : '<p class="muted">No alerts.</p>';
}

async function loadAlerts() {
  state.alertsError = '';
  const url = state.cfg.watchdogAlertsUrl;
  if (!url) {
    state.alertsError = 'No watchdog feed configured.';
    return;
  }
  try {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error();
    const all = await res.json();
    state.alerts = all.filter((a) => a && a.title).sort((x, y) => Number(y.time) - Number(x.time));
  } catch {
    state.alertsError = 'The watchdog feed could not be loaded right now.';
  }
}

function renderContracts() {
  const c = state.cfg;
  const rows = [
    ['Voter list (identity registry)', c.identityAddress],
    ['Voting', c.voteAddress],
    ['Mandates', c.registryAddress],
    ['Decision markets', c.marketAddress],
    ['Council', c.councilAddress],
    ['Play credits', c.creditsAddress],
  ].filter(([, a]) => a);
  $('contracts').innerHTML = `<ul class="list">${rows.map(([l, a]) => `<li>${esc(l)}<br><span class="addr">${link('address', a, a)}</span></li>`).join('')}</ul>
    <p class="meta">Network: ${esc(c.chainName || c.chainId)}. The source code of every contract is public on GitHub.</p>`;
}

async function refresh() {
  const el = $('dash-status');
  el.textContent = 'Loading…';
  el.className = 'status';
  try {
    const identity = new ethers.Contract(state.cfg.identityAddress, IDENTITY_ABI, state.provider);
    const vote = new ethers.Contract(state.cfg.voteAddress, VOTE_ABI, state.provider);
    const now = (await state.provider.getBlock('latest')).timestamp;
    const groupIds = (await Promise.all([0, 1, 2].map((t) => identity.groupId(t)))).map(String);
    const [all, verified, full] = [await activeCount(identity, 0), await activeCount(identity, 1), await activeCount(identity, 2)];
    const [polls, pending, mandates] = [await renderPolls(vote, groupIds, now), await renderCouncil(), await renderMandates()];
    await renderSources(identity);
    await loadAlerts();
    renderAlerts();
    const urgentDay = state.alerts.filter((a) => a.severity === 'high' && now - Number(a.time) < 86_400).length;
    $('tiles').innerHTML = [
      tile(num(all), 'people on the voter list', `${num(full)} with full voting rights · ${num(verified - full)} in their new-resident wait · ${num(all - verified)} basic`),
      tile(num(polls.open), polls.open === 1 ? 'poll open now' : 'polls open now', `${num(polls.total)} in total`),
      tile(num(mandates.active), mandates.active === 1 ? 'mandate in progress' : 'mandates in progress', `${num(mandates.total)} in total`),
      tile(num(pending), pending === 1 ? 'council change pending' : 'council changes pending', 'proposed, not yet run'),
      tile(num(urgentDay), 'urgent watchdog alerts', 'in the last 24 hours'),
    ].join('');
    el.textContent = '';
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString(undefined, { timeStyle: 'short' })} · refreshes every minute`;
  } catch (e) {
    el.textContent = `Could not load everything: ${e.shortMessage || e.message}`;
    el.className = 'status error';
  }
}

async function boot() {
  const res = await fetch(`config.json?t=${Date.now()}`, { cache: 'no-store' });
  state.cfg = await res.json();
  state.provider = new ethers.JsonRpcProvider(state.cfg.rpcUrl, undefined, { staticNetwork: true, cacheTimeout: -1 });
  renderContracts();
  for (const b of document.querySelectorAll('#alert-filters button')) {
    b.onclick = () => {
      state.sev = b.dataset.sev;
      for (const x of document.querySelectorAll('#alert-filters button')) x.setAttribute('aria-pressed', String(x === b));
      renderAlerts();
    };
  }
  $('btn-refresh').onclick = refresh;
  await refresh();
  setInterval(() => document.visibilityState === 'visible' && refresh(), 60_000);
}

boot().catch((e) => {
  $('dash-status').textContent = `This dashboard is not configured yet: ${e.message}`;
  $('dash-status').className = 'status error';
});
