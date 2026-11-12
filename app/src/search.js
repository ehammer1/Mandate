/**
 * app/src/search.js - one search for everything: type a number ("poll 12", "#12",
 * "council 4"), an address (0x…), a text reference (nb:0x…) or words, and get links to the
 * matching polls, petitions, mandates, council changes, agenda items, bodies, officials and
 * help topics.
 */

import { ethers } from 'ethers';
import { readDoc } from './notices.js';
import { readProposal, describeCall } from './council.js';
import { BODIES_ABI } from './bodies.js';
import { HELP } from './help-content.js';
import { t, translateHtml } from './i18n.js';
import { parseReceipt, receiptHtml } from './receipt.js';

const POLL = ['function pollCount() view returns (uint256)', 'function getPoll(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 quorum, uint8 options, uint8 action, bool finalized, bool passed, address proposer, uint256 bond, string questionCID, bytes actionData))'];
const PETITIONS = ['function petitionCount() view returns (uint256)', 'function getPetition(uint256) view returns (tuple(uint8 tier, uint8 action, uint32 needed, uint32 signatures, uint256 pollId, bytes actionData, string ref, address creator, uint64 createdAt))'];
const MANDATES = ['function mandateCount() view returns (uint256)', 'function getMandate(uint256) view returns (tuple(address responsible, uint64 createdAt, uint64 deadline, uint64 settledAt, uint16 threshold, uint8 status, uint32 round, uint32 approvals, uint32 rejections, bytes32 category, string specCID, string evidenceCID, uint64 pausedAt))'];
const COUNCIL = ['function proposalCount() view returns (uint256)', 'function members() view returns (address[])', 'function proposal(uint256) view returns (tuple(address target, uint256 value, bytes data, string description, address proposer, uint64 proposedAt, uint64 readyAt, bool fast, bool executed, bool cancelled, bool emergency, address undoTarget, bytes undoData, uint256 ratifyPoll, uint64 ratifyBy, bool lapsed) p, uint8 s, uint256 approvals)'];
const OFFICIALS = ['function count() view returns (uint256)', 'function getOfficial(uint256) view returns (tuple(address account, string name, string office, string jurisdiction, uint64 termEnd, bool official, bool delegate, bool active, string statementRef))'];

const CONTRACTS = {
  voteAddress: 'Voting contract', identityAddress: 'Voter list', registryAddress: 'Mandates', marketAddress: 'Decision markets', councilAddress: 'Council',
  previousCouncilAddress: 'Previous council', charterAddress: 'Voting rules (charter)', budgetAddress: 'Civic budget', feedbackAddress: 'Petitions and comments',
  noticeBoardAddress: 'Notice board (published text)', escrowFactoryAddress: 'Mandate budgets', officialsAddress: 'Officials registry', bodiesAddress: 'Government bodies',
  bodyRecordsAddress: 'Drafts and closed sessions', creditsAddress: 'Play credits',
};
const POLL_STATE = (p, now) => (p.finalized ? (p.passed ? 'passed' : 'did not pass') : Number(p.end) > now ? 'open' : 'voting ended');
const COUNCIL_STATE = ['', 'collecting approvals', 'waiting period', 'ready to run', 'done', 'cancelled', 'expired'];
const MANDATE_STATE = ['', 'in progress', 'evidence under review', 'done and verified', 'repealed', 'paused'];
const STAGE = ['', 'on the agenda', 'voting', 'awaiting the executive', 'adopted', 'did not pass', 'vetoed', 'override vote', 'lapsed', 'withdrawn'];

const recent = (n, k = 60) => Array.from({ length: Math.min(Number(n), k) }, (_, i) => Number(n) - i);

/** Everything searchable, built on first use and kept for a minute. */
let cache = { at: 0, items: null };
async function buildIndex(state) {
  if (cache.items && Date.now() - cache.at < 60_000) return cache.items;
  const cfg = state.config;
  const p = state.provider;
  const now = Number((await p.getBlock('latest')).timestamp);
  const items = [];
  const add = (it) => items.push({ ...it, hay: `${it.kind} ${it.id} ${it.title} ${it.extra || ''} ${(it.addresses || []).join(' ')} ${it.ref || ''}`.toLowerCase() });
  const doc = (ref) => readDoc(cfg, p, ref).catch(() => ({ title: '(text unavailable)', body: '' }));
  const jobs = [];
  if (cfg.voteAddress) jobs.push((async () => {
    const v = new ethers.Contract(cfg.voteAddress, POLL, p);
    for (const id of recent(await v.pollCount())) {
      const x = await v.getPoll(id);
      const d = await doc(x.questionCID);
      add({ kind: 'poll', id, title: d.title, extra: d.body, status: POLL_STATE(x, now), ref: x.questionCID, addresses: [x.proposer], hash: `#poll-${id}` });
    }
  })());
  if (cfg.feedbackAddress) jobs.push((async () => {
    const f = new ethers.Contract(cfg.feedbackAddress, PETITIONS, p);
    for (const id of recent(await f.petitionCount())) {
      const x = await f.getPetition(id);
      const d = await doc(x.ref);
      add({ kind: 'petition', id, title: d.title, extra: d.body, status: x.pollId > 0n ? `opened poll ${x.pollId}` : `${x.signatures} of ${x.needed} signatures`, ref: x.ref, addresses: [x.creator], hash: `#petition-${id}` });
    }
  })());
  if (cfg.registryAddress) jobs.push((async () => {
    const r = new ethers.Contract(cfg.registryAddress, MANDATES, p);
    for (const id of recent(await r.mandateCount())) {
      const m = await r.getMandate(id);
      const d = await doc(m.specCID);
      add({ kind: 'mandate', id, title: d.title, extra: d.body, status: MANDATE_STATE[Number(m.status)] || '', ref: m.specCID, addresses: [m.responsible], hash: `#mandate-${id}` });
    }
  })());
  for (const [key, kind, label] of [['councilAddress', 'council', 'Council change'], ['previousCouncilAddress', 'prevcouncil', 'Previous council change']]) {
    if (!cfg[key]) continue;
    jobs.push((async () => {
      const c = new ethers.Contract(cfg[key], COUNCIL, p);
      const members = await c.members().catch(() => []);
      add({ kind: `${kind}-members`, id: '', label: kind === 'council' ? 'Council' : 'Previous council', title: `${members.length} members`, addresses: [...members, cfg[key]], hash: `#${kind}-0`, status: '' });
      for (const id of recent(await c.proposalCount(), 40)) {
        const [x, s] = await readProposal(c, id);
        add({ kind, id, label, title: describeCall(cfg, x.target, x.data), extra: x.description, status: COUNCIL_STATE[Number(s)] || '', addresses: [x.proposer, x.target], hash: `#${kind}-${id}` });
      }
    })());
  }
  if (cfg.bodiesAddress) jobs.push((async () => {
    const g = new ethers.Contract(cfg.bodiesAddress, BODIES_ABI, p);
    const n = Number(await g.bodyCount());
    const names = {};
    for (let b = 1; b <= n; b++) {
      const [r, , members] = await g.getBody(b);
      names[b] = r.name;
      add({ kind: 'body', id: b, title: r.name, extra: r.kind, status: `${members.length} of ${r.seats} seats`, addresses: [...members, r.executive, r.clerk].filter((a) => a !== ethers.ZeroAddress), hash: `#body-${b}` });
    }
    for (const id of recent(await g.motionCount())) {
      const [m] = await g.getMotion(id);
      const d = await doc(m.ref);
      add({ kind: 'motion', id, label: 'Agenda item', title: d.title, extra: `${names[Number(m.bodyId)] || ''} ${d.body}`, status: `${names[Number(m.bodyId)] || 'body'} · ${STAGE[Number(m.stage)] || ''}`, ref: m.ref, addresses: [m.proposer], hash: `#motion-${id}` });
    }
  })());
  if (cfg.officialsAddress) jobs.push((async () => {
    const o = new ethers.Contract(cfg.officialsAddress, OFFICIALS, p);
    for (let i = 1; i <= Math.min(Number(await o.count()), 200); i++) {
      const x = await o.getOfficial(i);
      if (x.active) add({ kind: 'official', id: i, label: x.official ? 'Official' : 'Public delegate', title: `${x.name}${x.office ? `, ${x.office}` : ''}`, extra: x.jurisdiction, status: '', addresses: [x.account], hash: '#dashboard-officials' });
    }
  })());
  await Promise.all(jobs.map((j) => j.catch(() => {})));
  for (const h of HELP) add({ kind: 'help', id: h.id, label: 'Help', title: t(h.title), extra: `${translateHtml(h.html)} ${h.html}`.replace(/<[^>]+>/g, ' '), status: '', hash: `#help-${h.id}` });
  cache = { at: Date.now(), items };
  return items;
}

const KIND_WORDS = {
  poll: 'poll', polls: 'poll', petition: 'petition', petitions: 'petition', mandate: 'mandate', mandates: 'mandate',
  council: 'council', change: 'council', proposal: 'council', previous: 'prevcouncil', motion: 'motion', item: 'motion', agenda: 'motion', body: 'body', board: 'body',
};

/** Matches for a query, best first. */
export async function search(state, query) {
  const q = String(query || '').trim();
  if (!q) return { results: [], note: '' };
  // A ballot receipt ("12:<code>"): was it counted?
  const receipt = parseReceipt(q);
  if (receipt) return { results: [], receipt, note: '' };
  const items = await buildIndex(state);
  const cfg = state.config;
  // An address: which contract it is, and everywhere it appears.
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
    const a = q.toLowerCase();
    const results = [];
    for (const [key, label] of Object.entries(CONTRACTS)) if (String(cfg[key] || '').toLowerCase() === a) results.push({ kind: 'contract', label: 'Contract', title: label, status: 'part of this deployment', hash: '', explorer: true });
    results.push(...items.filter((i) => (i.addresses || []).some((x) => String(x).toLowerCase() === a)));
    return { results, note: results.length ? '' : 'This address does not appear in recent polls, petitions, mandates, council changes, bodies or officials.', address: q };
  }
  // A text reference (nb:0x…) or a bare 32-byte hash.
  if (/^(nb:)?0x[0-9a-fA-F]{64}$/.test(q)) {
    const ref = q.startsWith('nb:') ? q.toLowerCase() : `nb:${q.toLowerCase()}`;
    const results = items.filter((i) => String(i.ref || '').toLowerCase() === ref);
    if (!results.length) {
      const d = await readDoc(cfg, state.provider, ref).catch(() => null);
      if (d && !d.missing) results.push({ kind: 'text', label: 'Published text', title: d.title, extra: d.body, status: 'not linked to a recent item', hash: '' });
    }
    return { results, note: results.length ? '' : 'No published text with that reference.' };
  }
  // A number, with or without a kind: "poll 12", "#12", "council change 4", "12".
  const num = /^(?:([a-z]+)(?:\s+[a-z]+)?\s*)?#?\s*(\d+)$/i.exec(q);
  if (num) {
    const id = Number(num[2]);
    const kind = num[1] ? KIND_WORDS[num[1].toLowerCase()] : null;
    const results = items.filter((i) => i.id === id && (!kind || i.kind === kind));
    if (results.length) return { results, note: '' };
  }
  // Words: every word must appear; titles count more.
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = items
    .filter((i) => words.every((w) => i.hay.includes(w)))
    .map((i) => ({ i, score: words.reduce((s, w) => s + (String(i.title).toLowerCase().includes(w) ? 3 : 1), 0) + (i.kind === 'help' ? -1 : 0) }))
    .sort((a, b) => b.score - a.score || (Number(b.i.id) || 0) - (Number(a.i.id) || 0));
  return { results: scored.slice(0, 40).map((x) => x.i), note: scored.length ? '' : 'Nothing found. Try fewer words, a number like "poll 12", or an address (0x…).' };
}

const LABEL = { poll: 'Poll', petition: 'Petition', mandate: 'Mandate', council: 'Council change', prevcouncil: 'Previous council change', motion: 'Agenda item', body: 'Body', official: 'Official', help: 'Help' };

/** The results as HTML: each a link that opens the item. */
export async function receiptResult(state, out, esc) {
  return `<div class="card stack"><p class="eyebrow">Ballot receipt · poll ${out.receipt.pollId}</p>${await receiptHtml(state, esc, out.receipt.pollId, out.receipt.nullifier)}<p><a href="#poll-${out.receipt.pollId}" data-open="#poll-${out.receipt.pollId}">Open poll ${out.receipt.pollId}</a></p></div>`;
}

export function resultsHtml(cfg, out, esc) {
  if (!out.results.length) return `<p class="muted">${esc(out.note)}</p>`;
  const explorer = cfg.explorer && out.address ? `<p><a href="${esc(`${cfg.explorer.replace(/\/+$/, '')}/address/${out.address}`)}" target="_blank" rel="noopener">View this address on the blockchain</a></p>` : '';
  return `${explorer}<ul class="list search-results">${out.results
    .map((r) => {
      const head = `${esc(r.label || LABEL[r.kind] || r.kind)}${r.id !== '' && r.id !== undefined && r.kind !== 'help' ? ` ${esc(String(r.id))}` : ''}`;
      const title = r.hash ? `<a href="${esc(r.hash)}" data-open="${esc(r.hash)}">${esc(r.title)}</a>` : esc(r.title);
      return `<li><p class="eyebrow">${head}${r.status ? ` · ${esc(r.status)}` : ''}</p><p><strong>${title}</strong></p></li>`;
    })
    .join('')}</ul>`;
}
