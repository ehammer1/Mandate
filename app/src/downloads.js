/**
 * app/src/downloads.js - "Download the data": the public record as spreadsheets (CSV) or
 * JSON, for journalists, researchers, auditors and anyone checking the numbers themselves.
 *
 * Everything comes from public contract views (the same numbers the dashboard shows); nothing
 * about who voted how exists to download. Each download is built in the browser on demand.
 */

import { ethers } from 'ethers';
import { COUNCIL_ABI, readProposal, describeCall } from './council.js';
import { readDoc } from './notices.js';
import { TALLIES_ABI, KIND } from './tallies.js';
import { PROGRESS_ABI } from './progress.js';

const MAX = 500; // newest items per list, to keep a phone download quick
const VOTE_ABI = [
  'function pollCount() view returns (uint256)',
  'function getPoll(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 quorum, uint8 options, uint8 action, bool finalized, bool passed, address proposer, uint256 bond, string questionCID, bytes actionData))',
  'function tally(uint256) view returns (uint256[])',
  'function getCheck(uint256) view returns (tuple(uint256 groupId, uint256 root, uint256 electorate, uint32 quorum, bool disputed) ck, uint256[2] counts)',
];
const IDENTITY_ABI = ['function groupId(uint8) view returns (uint256)'];
const REGISTRY_ABI = [
  'function mandateCount() view returns (uint256)',
  'function getMandate(uint256) view returns (tuple(address responsible, uint64 createdAt, uint64 deadline, uint64 settledAt, uint16 threshold, uint8 status, uint32 round, uint32 approvals, uint32 rejections, bytes32 category, string specCID, string evidenceCID, uint64 pausedAt))',
  'function isOverdue(uint256) view returns (bool)',
];
const PETITION_ABI = [
  'function petitionCount() view returns (uint256)',
  'function getPetition(uint256) view returns (tuple(uint8 tier, uint8 action, uint32 needed, uint32 signatures, uint256 pollId, bytes actionData, string ref, address creator, uint64 createdAt))',
];
const GROUP_NAMES = ['All members', 'ID-checked residents', 'Residents with full voting rights'];
const ACTIONS = ['Advisory', 'Binding: veto a market decision', 'Binding: create a mandate', 'Binding: repeal a mandate'];
const MANDATE_STATUS = ['', 'In progress', 'Under review', 'Fulfilled', 'Repealed', 'Paused for review'];
const COUNCIL_STATES = ['', 'Collecting approvals', 'Waiting period', 'Ready to run', 'Done', 'Cancelled', 'Expired'];

const iso = (t) => (Number(t) ? new Date(Number(t) * 1000).toISOString() : '');
const newest = (count) => {
  const ids = [];
  for (let id = Number(count); id >= Math.max(1, Number(count) - MAX + 1); id--) ids.push(id);
  return ids;
};
const title = async (cfg, provider, ref) => (ref ? await readDoc(cfg, provider, ref).catch(() => null) : null);

/** The lists on offer: key → { label, what, load(cfg, provider) → rows }. */
export const DATASETS = {
  polls: {
    label: 'Polls and results',
    what: 'Every poll: question, who could vote, dates, online votes per choice, turnout, paper ballots, and the result.',
    async load(cfg, provider) {
      const vote = new ethers.Contract(cfg.voteAddress, VOTE_ABI, provider);
      const groups = cfg.identityAddress ? (await Promise.all([0, 1, 2].map((t) => new ethers.Contract(cfg.identityAddress, IDENTITY_ABI, provider).groupId(t)))).map(String) : [];
      const t = cfg.talliesAddress ? new ethers.Contract(cfg.talliesAddress, TALLIES_ABI, provider) : null;
      const now = (await provider.getBlock('latest')).timestamp;
      const rows = [];
      for (const id of newest(await vote.pollCount())) {
        const [p, counts] = await Promise.all([vote.getPoll(id), vote.tally(id)]);
        const [ck, ckCounts] = await vote.getCheck(id).catch(() => [{ root: 0n }, [0n, 0n]]);
        const q = await title(cfg, provider, p.questionCID);
        const n = Number(p.options);
        const labels = q?.options?.length === n ? q.options : n === 2 ? ['Yes', 'No'] : Array.from({ length: n }, (_, i) => `Choice ${i + 1}`);
        const ballots = counts.reduce((a, b) => a + Number(b), 0);
        let paper = null;
        if (t) {
          const c = Number(await t.contestOfPoll(id).catch(() => 0n));
          if (c) paper = await t.totals(c).catch(() => null);
        }
        const open = !p.finalized && Number(p.end) > now;
        rows.push({
          poll: id,
          question: q?.title || '',
          status: open ? 'open' : p.finalized ? (ck.disputed ? 'contested' : p.passed ? 'passed' : 'did not pass') : 'ended, result not recorded',
          type: ACTIONS[Number(p.action)] || 'Advisory',
          who_could_vote: GROUP_NAMES[groups.indexOf(String(p.groupId))] || 'Members',
          opens: iso(p.start),
          closes: iso(p.end),
          eligible: Number(p.electorate),
          quorum: Number(p.quorum),
          online_ballots: ballots,
          turnout_percent: Number(p.electorate) ? Math.round((ballots / Number(p.electorate)) * 1000) / 10 : '',
          online_results: labels.map((l, i) => `${l}: ${Number(counts[i] || 0)}`).join('; '),
          paper_ballots: paper ? Number(paper.ballots) : '',
          paper_results: paper ? labels.map((l, i) => `${l}: ${Number(paper.counts[i] || 0)}`).join('; ') : '',
          cross_check: ck.root ? `Yes: ${Number(ckCounts[0])}; No: ${Number(ckCounts[1])}${ck.disputed ? ' (disagreed)' : ''}` : '',
          question_ref: p.questionCID,
        });
      }
      return rows;
    },
  },
  petitions: {
    label: 'Petitions',
    what: 'Every petition: title, signatures against the number needed, when it started, and the poll it led to.',
    async load(cfg, provider) {
      if (!cfg.feedbackAddress) return [];
      const f = new ethers.Contract(cfg.feedbackAddress, PETITION_ABI, provider);
      const rows = [];
      for (const id of newest(await f.petitionCount())) {
        const p = await f.getPetition(id);
        const d = await title(cfg, provider, p.ref);
        rows.push({ petition: id, title: d?.title || '', signatures: Number(p.signatures), needed: Number(p.needed), percent: Math.min(100, Math.round((Number(p.signatures) / Math.max(1, Number(p.needed))) * 100)), led_to_poll: Number(p.pollId) || '', started: iso(p.createdAt), started_by: p.creator, ref: p.ref });
      }
      return rows;
    },
  },
  mandates: {
    label: 'Mandates and progress',
    what: 'Every mandate: the goal, who is responsible, deadline, status, verifier checks, and the latest progress report.',
    async load(cfg, provider) {
      if (!cfg.registryAddress) return [];
      const r = new ethers.Contract(cfg.registryAddress, REGISTRY_ABI, provider);
      const k = cfg.progressAddress ? new ethers.Contract(cfg.progressAddress, PROGRESS_ABI, provider) : null;
      const rows = [];
      for (const id of newest(await r.mandateCount())) {
        const [m, overdue] = await Promise.all([r.getMandate(id), r.isOverdue(id)]);
        const d = await title(cfg, provider, m.specCID);
        const s = k ? await k.summary(id).catch(() => null) : null;
        rows.push({
          mandate: id,
          goal: d?.title || '',
          status: MANDATE_STATUS[Number(m.status)] || '',
          overdue: overdue ? 'yes' : 'no',
          responsible: m.responsible,
          created: iso(m.createdAt),
          deadline: iso(m.deadline),
          settled: iso(m.settledAt),
          checks_passed: Number(m.approvals),
          checks_needed: Number(m.threshold),
          checks_failed: Number(m.rejections),
          progress_percent: s && Number(s.lastUpdate) ? Number(s.percent) : '',
          last_progress_report: s ? iso(s.lastUpdate) : '',
          milestones_done: s ? `${Number(s.done)} of ${Number(s.total)}` : '',
          goal_ref: m.specCID,
          evidence_ref: m.evidenceCID,
        });
      }
      return rows;
    },
  },
  council: {
    label: 'Council changes',
    what: 'Every change the council proposed: what it does, the reason given, approvals, and whether it ran.',
    async load(cfg, provider) {
      if (!cfg.councilAddress) return [];
      const c = new ethers.Contract(cfg.councilAddress, COUNCIL_ABI, provider);
      const rows = [];
      for (const id of newest(await c.proposalCount())) {
        const [p, s, approvals] = await readProposal(c, id);
        rows.push({ change: id, state: COUNCIL_STATES[Number(s)] || '', what_it_does: describeCall(cfg, p.target, p.data), reason_given: p.description || '', approvals: Number(approvals), proposed: iso(p.proposedAt), can_run_from: iso(p.readyAt), proposed_by: p.proposer, contract: p.target });
      }
      return rows;
    },
  },
  paper: {
    label: 'Paper and in-person counts',
    what: 'Every count a clerk recorded at a polling place or meeting, who recorded and confirmed it, and any corrections.',
    async load(cfg, provider) {
      if (!cfg.talliesAddress) return [];
      const t = new ethers.Contract(cfg.talliesAddress, TALLIES_ABI, provider);
      const rows = [];
      for (const cid of newest(await t.contestCount())) {
        const [c, places, ids] = await Promise.all([t.getContest(cid), t.placesOf(cid), t.talliesOf(cid)]);
        const d = await title(cfg, provider, c.ref);
        for (const tid of ids) {
          const x = await t.getTally(tid);
          rows.push({
            count: Number(tid),
            contest: cid,
            contest_type: KIND[Number(c.kind)] || '',
            poll: Number(c.pollId) || '',
            contest_title: d?.title || '',
            place: places[Number(x.place)] ?? `Place ${Number(x.place)}`,
            ballots: Number(x.ballots),
            counts: x.counts.map(Number).join('; '),
            recorded_by: x.recordedBy,
            recorded: iso(x.recordedAt),
            confirmed_by: Number(x.confirmedAt) ? x.confirmedBy : '',
            confirmed: iso(x.confirmedAt),
            corrected_by_count: Number(x.replacedBy) || '',
            correction_reason: x.reason,
            contest_closed: c.closed ? 'yes' : 'no',
          });
        }
      }
      return rows;
    },
  },
};

/** Rows → CSV text. Cells that a spreadsheet would run as a formula are made plain text. */
export function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

function save(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The download buttons, for the dashboard. */
export function downloadsHtml(esc) {
  return `<ul class="list">${Object.entries(DATASETS)
    .map(([k, d]) => `<li><p><strong>${esc(d.label)}</strong></p><p class="meta">${esc(d.what)}</p>
      <p class="actions"><button type="button" data-download="${k}" data-format="csv">Spreadsheet (CSV)</button> <button type="button" data-download="${k}" data-format="json">JSON</button></p></li>`)
    .join('')}</ul>
    <p><button type="button" data-download="all" data-format="json">Everything in one file (JSON)</button></p>
    <p class="meta">CSV opens in Excel, Numbers or Google Sheets. Ballots are anonymous, so no download can show who voted or how. Lists include the newest ${MAX} items each.</p>
    <p class="status" role="status" id="download-status"></p>`;
}

export function wireDownloads(root, cfg, provider) {
  const status = root.querySelector('#download-status');
  for (const b of root.querySelectorAll('[data-download]')) {
    b.onclick = async () => {
      const key = b.dataset.download;
      const stamp = new Date().toISOString().slice(0, 10);
      status.className = 'status';
      status.textContent = 'Gathering the data from the public record… (this can take a minute)';
      try {
        if (key === 'all') {
          const out = { network: cfg.chainName || cfg.chainId, downloaded: new Date().toISOString(), contracts: Object.fromEntries(Object.entries(cfg).filter(([k, v]) => /Address$/.test(k) && v)) };
          for (const [k, d] of Object.entries(DATASETS)) out[k] = await d.load(cfg, provider);
          save(`mandate-data-${stamp}.json`, JSON.stringify(out, null, 2), 'application/json');
        } else {
          const rows = await DATASETS[key].load(cfg, provider);
          if (b.dataset.format === 'csv') save(`mandate-${key}-${stamp}.csv`, `﻿${toCsv(rows)}`, 'text/csv;charset=utf-8');
          else save(`mandate-${key}-${stamp}.json`, JSON.stringify(rows, null, 2), 'application/json');
          if (!rows.length) return void ((status.textContent = 'Downloaded: the list is empty so far.'), (status.className = 'status ok'));
        }
        status.textContent = 'Downloaded.';
        status.className = 'status ok';
      } catch (e) {
        status.textContent = `Could not download: ${e.shortMessage || e.message}`;
        status.className = 'status error';
      }
    };
  }
}
