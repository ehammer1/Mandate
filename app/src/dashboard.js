/**
 * app/src/dashboard.js - the live public dashboard (app/dashboard.html).
 *
 * Read-only: everything comes from public contract views (no event-log scans, which
 * public RPCs limit) plus the watchdog's published alerts. No sign-in, no voter data.
 */

import { ethers } from 'ethers';
import { describeCall, COUNCIL_ABI } from './council.js';
import { readDoc } from './notices.js';
import { loadRules } from './rules.js';

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
  'function getCheck(uint256) view returns (tuple(uint256 groupId, uint256 root, uint256 electorate, uint32 quorum, bool disputed) ck, uint256[2] counts)',
];
const REGISTRY_ABI = [
  'function mandateCount() view returns (uint256)',
  'function getMandate(uint256) view returns (tuple(address responsible, uint64 createdAt, uint64 deadline, uint64 settledAt, uint16 threshold, uint8 status, uint32 round, uint32 approvals, uint32 rejections, bytes32 category, string specCID, string evidenceCID, uint64 pausedAt))',
  'function isOverdue(uint256) view returns (bool)',
];
const GROUP_NAMES = ['All members', 'ID-checked residents', 'Residents with full voting rights'];
const ACTIONS = ['Advisory', 'Binding: veto a market decision', 'Binding: create a mandate', 'Binding: repeal a mandate'];
const MANDATE_STATUS = ['', 'In progress', 'Under review', 'Fulfilled', 'Repealed', 'Paused for review'];
const COUNCIL_STATES = ['', 'Collecting approvals', 'Waiting period', 'Ready to run', 'Done', 'Cancelled', 'Expired'];
const SEV = { high: '▲ Urgent', medium: '● Notable', info: '○ Info' };
const ISSUER_ROLE = ethers.id('ISSUER_ROLE');

const state = { cfg: null, provider: null, alerts: [], sev: 'all' };

function link(kind, value, label) {
  const base = state.cfg.explorer;
  return base ? `<a href="${esc(base)}/${kind}/${esc(value)}" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label);
}

async function question(cid) {
  const d = await readDoc(state.cfg, state.provider, cid);
  return d.missing ? { title: `Question ${cid.slice(0, 12)}…`, options: null } : d;
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
    const [ck, ckCounts] = await vote.getCheck(id).catch(() => [{ root: 0n }, [0n, 0n]]);
    const q = await question(p.questionCID);
    const n = Number(p.options);
    const labels = q.options?.length === n ? q.options : n === 2 ? ['Yes', 'No'] : Array.from({ length: n }, (_, i) => `Choice ${i + 1}`);
    const ballots = t.reduce((a, b) => a + Number(b), 0);
    const isOpen = !p.finalized && Number(p.end) > now;
    if (isOpen) open++;
    const status = isOpen ? `Open until ${when(p.end)}` : p.finalized ? (ck.disputed ? 'Closed: contested' : p.passed ? 'Closed: passed' : 'Closed: did not pass') : 'Voting ended, result not yet recorded';
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
      ${ck.root ? `<p class="meta">Cross-check, ${esc(GROUP_NAMES[groupIds.indexOf(String(ck.groupId))] || 'ID-checked residents')} only: Yes ${num(ckCounts[0])}, No ${num(ckCounts[1])}${ck.disputed ? ' · <strong>▲ they chose the other side, so the result was held</strong>' : ''}</p>` : ''}
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
    return { active: 0, total: 0, held: 0n };
  }
  const r = new ethers.Contract(state.cfg.registryAddress, REGISTRY_ABI, state.provider);
  const count = Number(await r.mandateCount());
  if (!count) {
    box.innerHTML = '<p class="muted">No mandates yet. A mandate is created when a binding poll passes or a decision market chooses one.</p>';
    $('scorecard').innerHTML = '<p class="muted">No mandates yet.</p>';
    return { active: 0, total: 0, held: 0n };
  }
  let active = 0;
  let held = 0n;
  const f = state.cfg.escrowFactoryAddress ? new ethers.Contract(state.cfg.escrowFactoryAddress, ['function escrowOf(uint256) view returns (address)'], state.provider) : null;
  const items = [];
  for (let id = count; id >= Math.max(1, count - 19); id--) {
    const [m, overdue] = await Promise.all([r.getMandate(id), r.isOverdue(id)]);
    const goal = await readDoc(state.cfg, state.provider, m.specCID);
    const st = Number(m.status);
    if (st === 1 || st === 2) active++;
    const escrow = f ? await f.escrowOf(id) : ethers.ZeroAddress;
    const locked = escrow !== ethers.ZeroAddress ? await new ethers.Contract(escrow, ['function lockedBalance() view returns (uint256)'], state.provider).lockedBalance() : 0n;
    held += locked;
    const label = overdue ? '▲ Overdue' : MANDATE_STATUS[st] || '';
    items.push(`<li id="dash-mandate-${id}"><p class="eyebrow">Mandate ${id} · ${esc(label)} · due ${esc(day(m.deadline))}</p>
      <p><strong>${esc(goal.title)}</strong></p>
      <p class="meta">Responsible: <span class="addr">${link('address', m.responsible, short(m.responsible))}</span> · checks passed ${m.approvals} of ${m.threshold} · budget held: ${escrow !== ethers.ZeroAddress ? `${link('address', escrow, `${ethers.formatEther(locked)} ETH`)}` : 'none yet'}</p></li>`);
  }
  box.innerHTML = `<ul class="list">${items.join('')}</ul>`;
  // Scorecard: per responsible party.
  const score = new Map();
  for (let id = 1; id <= count; id++) {
    const [m, overdue] = await Promise.all([r.getMandate(id), r.isOverdue(id)]);
    const k = m.responsible.toLowerCase();
    const s = score.get(k) || { who: m.responsible, total: 0, done: 0, late: 0, overdue: 0, paused: 0, repealed: 0 };
    s.total++;
    const st = Number(m.status);
    if (st === 3) {
      s.done++;
      if (Number(m.settledAt) > Number(m.deadline)) s.late++;
    }
    if (overdue) s.overdue++;
    if (st === 5) s.paused++;
    if (st === 4) s.repealed++;
    score.set(k, s);
  }
  $('scorecard').innerHTML = score.size
    ? `<table class="data"><thead><tr><th>Responsible</th><th class="num">Mandates</th><th class="num">Done</th><th class="num">Done late</th><th class="num">Overdue</th><th class="num">Paused</th><th class="num">Repealed</th></tr></thead><tbody>${[...score.values()].map((s) => `<tr><td class="addr">${link('address', s.who, short(s.who))}</td><td class="num">${s.total}</td><td class="num">${s.done}</td><td class="num">${s.late}</td><td class="num">${s.overdue ? `▲ ${s.overdue}` : 0}</td><td class="num">${s.paused}</td><td class="num">${s.repealed}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No mandates yet.</p>';
  return { active, total: count, held };
}

async function renderBudget() {
  const box = $('budget');
  if (!state.cfg.budgetAddress) return (box.innerHTML = '<div class="card"><p class="muted">Not set up on this deployment.</p></div>');
  const b = new ethers.Contract(state.cfg.budgetAddress, [
    'function roundCount() view returns (uint256)',
    'function getRound(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 credits, uint256 budget, string ref, bool finalized, uint256 participants, uint256 spent, uint256 fundedMask))',
    'function getProposals(uint256) view returns (string[] refs, uint256[] costs, uint256[] votes)',
  ], state.provider);
  const n = Number(await b.roundCount());
  if (!n) return (box.innerHTML = '<div class="card"><p class="muted">No budget rounds yet.</p></div>');
  const cards = [];
  for (let id = n; id >= Math.max(1, n - 4); id--) {
    const [r, [refs, costs, votes]] = await Promise.all([b.getRound(id), b.getProposals(id)]);
    const doc = await readDoc(state.cfg, state.provider, r.ref);
    const max = votes.reduce((m, v) => (v > m ? v : m), 0n) || 1n;
    const rows = refs.map((t, i) => {
      const funded = r.finalized && (r.fundedMask >> BigInt(i)) & 1n;
      const share = Math.round((Number(votes[i]) / Number(max)) * 100);
      return `<span>${esc(t)} <span class="meta">$${num(costs[i])}${r.finalized ? (funded ? ' · ✓ funded' : ' · not funded') : ''}</span></span><span class="track" role="img" aria-label="${esc(t)}: ${votes[i]} votes"><span class="fill" style="display:block;width:${share}%"></span></span><span class="v">${num(votes[i])}</span>`;
    }).join('');
    cards.push(`<div class="card"><p class="eyebrow">Round ${id} · ${r.finalized ? `closed · $${num(r.spent)} of $${num(r.budget)} allocated` : `open until ${esc(when(r.end))}`} · ${num(r.participants)} of ${num(r.electorate)} took part</p><h3>${esc(doc.title)}</h3><div class="tally">${rows}</div></div>`);
  }
  box.innerHTML = cards.join('');
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
    await renderBudget();
    await renderSources(identity);
    const rules = await loadRules(state.cfg, state.provider).catch(() => []);
    $('rules').innerHTML = rules.length ? `<ul class="list">${rules.map((r) => `<li><strong>${esc(r.label)}</strong><br>${esc(r.shown)} <span class="meta">(limits: ${esc(r.range)})</span></li>`).join('')}</ul>` : '<p class="muted">No charter on this deployment.</p>';
    await loadAlerts();
    renderAlerts();
    const urgentDay = state.alerts.filter((a) => a.severity === 'high' && now - Number(a.time) < 86_400).length;
    $('tiles').innerHTML = [
      tile(num(all), 'people on the voter list', `${num(full)} with full voting rights · ${num(verified - full)} in their new-resident wait · ${num(all - verified)} basic`),
      tile(num(polls.open), polls.open === 1 ? 'poll open now' : 'polls open now', `${num(polls.total)} in total`),
      tile(num(mandates.active), mandates.active === 1 ? 'mandate in progress' : 'mandates in progress', `${num(mandates.total)} in total · ${Number(ethers.formatEther(mandates.held)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ETH held in their budgets`),
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
