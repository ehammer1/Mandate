/**
 * app/src/priority.js - topic categories, and one "Needs attention" list ranked by
 * urgency (time left) times importance (what a decision can change).
 *
 * Read-only: everything comes from the public contracts, so the app and the public
 * dashboard show the same ranking.
 */

import { ethers } from 'ethers';
import { readDoc } from './notices.js';
import { countdown } from './time.js';

export const CATEGORIES = [
  ['general', 'General'],
  ['safety', 'Public safety'],
  ['roads', 'Roads and transport'],
  ['housing', 'Housing'],
  ['budget', 'Budget and taxes'],
  ['environment', 'Environment and parks'],
  ['health', 'Health'],
  ['education', 'Schools and education'],
  ['services', 'Water, power and services'],
  ['economy', 'Jobs and business'],
  ['rights', 'Rights and justice'],
  ['governance', 'How decisions are made'],
];
const LABEL = Object.fromEntries(CATEGORIES);
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const BY_HASH = Object.fromEntries(CATEGORIES.map(([k]) => [ethers.id(k), k]));

export const categoryLabel = (key) => LABEL[key] || LABEL.general;
/** The category key of a published document (polls, petitions); "general" when not set. */
export const categoryOf = (doc) => (doc && LABEL[doc.category] ? doc.category : 'general');
/** A mandate stores its category as keccak256 of the key. */
export const categoryFromHash = (h) => BY_HASH[h] || 'general';
export const categoryOptions = (selected = 'general') =>
  CATEGORIES.map(([k, l]) => `<option value="${k}"${k === selected ? ' selected' : ''}>${l}</option>`).join('');
export const categoryChip = (key, esc) => `<span class="chip">${esc(categoryLabel(key))}</span>`;

const POLL_ABI = [
  'function pollCount() view returns (uint256)',
  'function getPoll(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 quorum, uint8 options, uint8 action, bool finalized, bool passed, address proposer, uint256 bond, string questionCID, bytes actionData))',
];
const COUNCIL = [
  'function proposalCount() view returns (uint256)',
  'function proposal(uint256) view returns (tuple(address target, uint256 value, bytes data, string description, address proposer, uint64 proposedAt, uint64 readyAt, bool fast, bool executed, bool cancelled, bool emergency, address undoTarget, bytes undoData, uint256 ratifyPoll, uint64 ratifyBy, bool lapsed) p, uint8 s, uint256 approvals)',
];
const COUNCIL_OLD = ['function proposal(uint256) view returns (tuple(address target, uint256 value, bytes data, string description, address proposer, uint64 proposedAt, uint64 readyAt, bool fast, bool executed, bool cancelled) p, uint8 s, uint256 approvals)'];
const REGISTRY = [
  'function mandateCount() view returns (uint256)',
  'function getMandate(uint256) view returns (tuple(address responsible, uint64 createdAt, uint64 deadline, uint64 settledAt, uint16 threshold, uint8 status, uint32 round, uint32 approvals, uint32 rejections, bytes32 category, string specCID, string evidenceCID, uint64 pausedAt))',
];
const FEEDBACK = [
  'function petitionCount() view returns (uint256)',
  'function getPetition(uint256) view returns (tuple(uint8 tier, uint8 action, uint32 needed, uint32 signatures, uint256 pollId, bytes actionData, string ref, address creator, uint64 createdAt))',
];
const BUDGET = [
  'function roundCount() view returns (uint256)',
  'function getRound(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 credits, uint256 budget, string ref, bool finalized, uint256 participants, uint256 spent, uint256 fundedMask))',
];
const BODIES = [
  'function motionCount() view returns (uint256)',
  'function getMotion(uint256) view returns (tuple(uint256 bodyId, string ref, bytes32 category, uint64 noticeAt, uint64 opensAt, uint64 closesAt, uint256 residentPoll, uint8 stage, uint64 executiveBy) m, uint32[3] counts)',
  'function getBody(uint256) view returns (tuple(string name, string kind, uint32 seats, uint16 quorumPct, uint16 passPct, uint16 overridePct, uint32 noticeMinutes, uint32 voteMinutes, uint32 executiveMinutes, address executive, bool residentPollRequired, bool explainDissent, bool active) b)',
];

/** How much a kind of decision can change (higher is more important). */
const WEIGHT = {
  emergency: 6,
  'rule-change': 5,
  council: 5,
  binding: 4,
  motion: 4,
  executive: 4,
  overdue: 3,
  budget: 3,
  mandate: 2.5,
  advisory: 2,
  petition: 2,
};
/** How soon it matters: overdue and the next day count most. */
function urgency(secondsLeft) {
  if (secondsLeft < 0) return 2.5;
  if (secondsLeft < 86_400) return 3;
  if (secondsLeft < 3 * 86_400) return 2;
  if (secondsLeft < 7 * 86_400) return 1.4;
  if (secondsLeft < 30 * 86_400) return 1;
  return 0.6;
}
export const levelOf = (score) => (score >= 12 ? 'urgent' : score >= 6 ? 'soon' : 'upcoming');
const LEVEL_LABEL = { urgent: '▲ Urgent', soon: '● Soon', upcoming: '○ Upcoming' };

const recent = (n, k = 30) => {
  const out = [];
  for (let id = Number(n); id >= Math.max(1, Number(n) - k + 1); id--) out.push(id);
  return out;
};

/**
 * Everything that is open and has a clock running, ranked. Each item:
 * { kind, title, what, category, at, score, level, href }. `opts.voted(pollId)` (optional)
 * marks polls this person already voted in, which drop down the list.
 */
export async function collectAttention(cfg, provider, opts = {}) {
  const now = Number((await provider.getBlock('latest')).timestamp);
  const items = [];
  const add = (it) => {
    const left = Number(it.at) - now;
    const score = Math.round(WEIGHT[it.weight] * urgency(left) * (it.boost || 1) * 10) / 10;
    items.push({ ...it, at: Number(it.at), score, level: levelOf(score) });
  };
  const doc = (ref) => readDoc(cfg, provider, ref).catch(() => ({ title: 'Text unavailable' }));
  const jobs = [];

  if (cfg.voteAddress) jobs.push((async () => {
    const v = new ethers.Contract(cfg.voteAddress, POLL_ABI, provider);
    for (const id of recent(await v.pollCount())) {
      const p = await v.getPoll(id);
      if (p.finalized || Number(p.end) <= now) continue;
      const d = await doc(p.questionCID);
      const action = Number(p.action);
      const voted = opts.voted ? await opts.voted(id).catch(() => false) : false;
      add({
        kind: 'poll', id, title: d.title, category: categoryOf(d), at: p.end,
        weight: action === 4 ? 'rule-change' : action === 0 ? 'advisory' : 'binding',
        what: `${action === 0 ? 'Advisory poll' : 'Binding poll'} ${id}${voted ? ' · you voted' : ''} · closes ${countdown(p.end)}`,
        boost: voted ? 0.3 : 1, href: `#poll-${id}`,
      });
    }
  })());

  if (cfg.councilAddress) jobs.push((async () => {
    const c = new ethers.Contract(cfg.councilAddress, COUNCIL, provider);
    const read = (id) => c.proposal(id).catch(async () => {
      const [p, s, a] = await new ethers.Contract(cfg.councilAddress, COUNCIL_OLD, provider).proposal(id);
      return [{ ...p.toObject(), emergency: false, lapsed: false, ratifyBy: 0n }, s, a];
    });
    for (const id of recent(await c.proposalCount(), 20)) {
      const [p, s] = await read(id);
      const st = Number(s);
      if (p.emergency && p.executed && !p.lapsed && Number(p.ratifyBy) > now) {
        add({ kind: 'council', id, title: p.description || `Council change ${id}`, category: 'governance', at: p.ratifyBy, weight: 'emergency',
          what: `Emergency council change ${id} · in effect · undone unless residents ratify it ${countdown(p.ratifyBy)}`, href: '#council' });
      } else if (st === 2 || st === 3) {
        add({ kind: 'council', id, title: p.description || `Council change ${id}`, category: 'governance', at: p.readyAt, weight: 'council',
          what: st === 2 ? `Council change ${id} · can run ${countdown(p.readyAt)} · any member can still cancel it` : `Council change ${id} · approved and ready to run`, href: '#council' });
      } else if (st === 1) {
        add({ kind: 'council', id, title: p.description || `Council change ${id}`, category: 'governance', at: now + 7 * 86_400, weight: 'council', boost: 0.5,
          what: `Council change ${id} · collecting approvals · proposed ${countdown(p.proposedAt)}`, href: '#council' });
      }
    }
  })());

  if (cfg.registryAddress) jobs.push((async () => {
    const r = new ethers.Contract(cfg.registryAddress, REGISTRY, provider);
    for (const id of recent(await r.mandateCount())) {
      const m = await r.getMandate(id);
      const st = Number(m.status);
      if (st !== 1 && st !== 2) continue;
      const d = await doc(m.specCID);
      const overdue = st === 1 && Number(m.deadline) < now;
      add({ kind: 'mandate', id, title: d.title, category: categoryFromHash(m.category), at: m.deadline, weight: overdue ? 'overdue' : 'mandate',
        what: overdue ? `Mandate ${id} · overdue · was due ${countdown(m.deadline)}` : st === 2 ? `Mandate ${id} · evidence under review` : `Mandate ${id} · due ${countdown(m.deadline)}`,
        href: `#mandate-${id}` });
    }
  })());

  if (cfg.feedbackAddress) jobs.push((async () => {
    const f = new ethers.Contract(cfg.feedbackAddress, FEEDBACK, provider);
    for (const id of recent(await f.petitionCount(), 60)) {
      const p = await f.getPetition(id);
      if (p.pollId > 0n) continue;
      const share = Number(p.signatures) / Math.max(1, Number(p.needed));
      if (share < 0.25) continue; // only petitions with real momentum
      const d = await doc(p.ref);
      // A petition has no deadline; rank by how close it is to opening its vote.
      add({ kind: 'petition', id, title: d.title, category: categoryOf(d), at: now + (1 - share) * 14 * 86_400, weight: 'petition', boost: 0.6 + share,
        what: `Petition ${id} · ${p.signatures} of ${p.needed} signatures (${Math.round(share * 100)}%)`, href: `#petition-${id}` });
    }
  })());

  if (cfg.budgetAddress) jobs.push((async () => {
    const b = new ethers.Contract(cfg.budgetAddress, BUDGET, provider);
    for (const id of recent(await b.roundCount(), 10)) {
      const r = await b.getRound(id);
      if (r.finalized || Number(r.end) <= now) continue;
      const d = await doc(r.ref);
      add({ kind: 'budget', id, title: d.title, category: 'budget', at: r.end, weight: 'budget', what: `Budget round ${id} · closes ${countdown(r.end)}`, href: '#budget' });
    }
  })());

  if (cfg.officialsAddress) jobs.push((async () => {
    const o = new ethers.Contract(cfg.officialsAddress, ['function measureCount() view returns (uint256)', 'function getMeasure(uint256) view returns (tuple(uint256 officialId, string ref, uint256 pollId, uint64 declaredAt) m, uint8 status)'], provider);
    const v = cfg.voteAddress ? new ethers.Contract(cfg.voteAddress, POLL_ABI, provider) : null;
    for (const id of recent(await o.measureCount(), 20)) {
      const [m, st] = await o.getMeasure(id);
      if (Number(st) !== 1 || !v) continue;
      const end = Number((await v.getPoll(m.pollId)).end);
      const d = await doc(m.ref);
      add({ kind: 'measure', id, title: d.title, category: categoryOf(d), at: end, weight: 'emergency',
        what: `Emergency measure ${id} · lapses unless residents ratify it ${countdown(end)} (poll ${m.pollId})`, href: `#poll-${m.pollId}` });
    }
  })());

  if (cfg.bodiesAddress) jobs.push((async () => {
    const g = new ethers.Contract(cfg.bodiesAddress, BODIES, provider);
    for (const id of recent(await g.motionCount())) {
      const [m] = await g.getMotion(id);
      const stage = Number(m.stage);
      if (stage > 3) continue; // decided
      const b = await g.getBody(m.bodyId);
      const d = await doc(m.ref);
      const [at, what, weight] = stage === 3
        ? [m.executiveBy, `${escape(b.name)} passed it · awaiting signature or veto ${countdown(m.executiveBy)}`, 'executive']
        : Number(m.opensAt) > now
          ? [m.opensAt, `${escape(b.name)} · on the agenda · voting opens ${countdown(m.opensAt)}`, 'motion']
          : [m.closesAt, `${escape(b.name)} · voting now · closes ${countdown(m.closesAt)}`, 'motion'];
      add({ kind: 'motion', id, title: d.title, category: categoryFromHash(m.category), at, weight, what, href: `#motion-${id}` });
    }
  })());

  await Promise.all(jobs.map((j) => j.catch(() => {})));
  return items.sort((a, b) => b.score - a.score || a.at - b.at);
}

/** The ranked list as HTML, with a category filter. */
export function attentionHtml(items, esc, { category = 'all', limit = 12, base = '' } = {}) {
  const shown = items.filter((i) => category === 'all' || i.category === category).slice(0, limit);
  if (!shown.length) return '<p class="muted">Nothing needs attention right now.</p>';
  return `<ol class="attention">${shown
    .map((i) => `<li class="attn ${i.level}"><p class="eyebrow"><span class="lvl">${LEVEL_LABEL[i.level]}</span> · ${esc(categoryLabel(i.category))}</p>
      <p><strong>${i.href ? `<a href="${esc(base + i.href)}" data-attn="${esc(i.kind)}:${i.id}">${esc(i.title)}</a>` : esc(i.title)}</strong></p>
      <p class="meta">${i.what}</p></li>`)
    .join('')}</ol>`;
}

/** Filter buttons for categories that appear in the list. */
export function categoryFilterHtml(items, current = 'all') {
  const present = new Set(items.map((i) => i.category));
  const btn = (k, l) => `<button data-cat="${k}" aria-pressed="${k === current}">${l}</button>`;
  return [btn('all', 'All topics'), ...CATEGORIES.filter(([k]) => present.has(k)).map(([k, l]) => btn(k, l))].join('');
}
