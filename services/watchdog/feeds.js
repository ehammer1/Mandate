/**
 * services/watchdog/feeds.js - public feeds anyone can subscribe to, with no account:
 *   feed.xml      Atom news feed of everything the watchdog records (polls, mandates, budget
 *                 rounds, petitions, council and rule changes), for readers, newsrooms,
 *                 libraries and social-media accounts to repost
 *   calendar.ics  iCalendar feed: when polls, budget rounds and agenda votes close, when
 *                 emergency changes must be ratified, mandate deadlines; each with alerts
 *                 1 day, 8 hours and 1 hour before (ALARM_HOURS changes them)
 */
'use strict';

const { ethers } = require('ethers');

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const ics = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (secs) => new Date(Number(secs) * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** iCalendar lines are folded at 75 octets. */
const fold = (line) => (line.length <= 74 ? line : line.match(/.{1,73}/g).join('\r\n '));

function atom(alerts, { appUrl, explorer, title = 'Mandate: public record' }) {
  const items = alerts.slice(0, 100);
  const updated = new Date((items[0]?.time || Date.now() / 1000) * 1000).toISOString();
  const entries = items
    .map((a) => {
      const link = a.tx && explorer ? `${explorer}/tx/${a.tx}` : appUrl;
      return `  <entry>
    <id>urn:mandate:${xml(a.id || `${a.rule}:${a.tx}:${a.time}`)}</id>
    <title>${xml(a.title)}</title>
    <updated>${new Date(a.time * 1000).toISOString()}</updated>
    <link href="${xml(link)}"/>
    <category term="${xml(a.severity)}"/>
    <summary>${xml(`${a.severity === 'high' ? 'Urgent: ' : ''}${a.title}`)}</summary>
  </entry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${xml(title)}</title>
  <subtitle>Every poll, mandate, budget round, petition and change of power, from the public blockchain record.</subtitle>
  <id>urn:mandate:feed</id>
  <link href="${xml(appUrl)}"/>
  <updated>${updated}</updated>
${entries}
</feed>
`;
}

/** Upcoming deadlines read from the contracts. */
async function deadlines(cfg, provider, readDoc) {
  const out = [];
  const now = Math.floor(Date.now() / 1000);
  if (cfg.voteAddress) {
    const vote = new ethers.Contract(cfg.voteAddress, ['function pollCount() view returns (uint256)', 'function getPoll(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 quorum, uint8 options, uint8 action, bool finalized, bool passed, address proposer, uint256 bond, string questionCID, bytes actionData))'], provider);
    const n = Number(await vote.pollCount());
    for (let id = n; id >= Math.max(1, n - 30); id--) {
      const p = await vote.getPoll(id);
      if (p.finalized || Number(p.end) < now - 86_400) continue;
      const d = await readDoc(cfg, provider, p.questionCID);
      out.push({ uid: `poll-${cfg.voteAddress}-${id}`, at: Number(p.end), title: `Poll ${id} closes: ${d?.title || 'see the app'}`, body: 'Last chance to vote. Open the Mandate app.' });
    }
  }
  if (cfg.registryAddress) {
    const reg = new ethers.Contract(cfg.registryAddress, ['function mandateCount() view returns (uint256)', 'function getMandate(uint256) view returns (tuple(address responsible, uint64 createdAt, uint64 deadline, uint64 settledAt, uint16 threshold, uint8 status, uint32 round, uint32 approvals, uint32 rejections, bytes32 category, string specCID, string evidenceCID, uint64 pausedAt))'], provider);
    const n = Number(await reg.mandateCount());
    for (let id = n; id >= Math.max(1, n - 30); id--) {
      const m = await reg.getMandate(id);
      if (Number(m.status) !== 1 && Number(m.status) !== 2) continue;
      const d = await readDoc(cfg, provider, m.specCID);
      out.push({ uid: `mandate-${cfg.registryAddress}-${id}`, at: Number(m.deadline), title: `Mandate ${id} due: ${d?.title || 'see the app'}`, body: 'The deadline set by public vote. Check whether it was done in the app.' });
    }
  }
  if (cfg.budgetAddress) {
    const b = new ethers.Contract(cfg.budgetAddress, ['function roundCount() view returns (uint256)', 'function getRound(uint256) view returns (tuple(uint256 groupId, uint256 snapshotRoot, uint256 electorate, uint64 start, uint64 end, uint32 credits, uint256 budget, string ref, bool finalized, uint256 participants, uint256 spent, uint256 fundedMask))'], provider);
    const n = Number(await b.roundCount());
    for (let id = n; id >= Math.max(1, n - 10); id--) {
      const r = await b.getRound(id);
      if (r.finalized || Number(r.end) < now - 86_400) continue;
      const d = await readDoc(cfg, provider, r.ref);
      out.push({ uid: `round-${cfg.budgetAddress}-${id}`, at: Number(r.end), title: `Budget round closes: ${d?.title || 'see the app'}`, body: 'Spend your civic credits before it closes.' });
    }
  }
  if (cfg.bodiesAddress) {
    const g = new ethers.Contract(cfg.bodiesAddress, [
      'function motionCount() view returns (uint256)',
      'function getMotion(uint256) view returns (tuple(uint256 bodyId, string ref, bytes32 category, address proposer, uint64 noticeAt, uint64 opensAt, uint64 closesAt, uint256 residentPoll, uint8 stage, uint64 executiveBy, uint64 overrideBy, uint32 version, uint32 electorate, bool overridden, string executiveRef) m, uint32[5] counts)',
      'function getBody(uint256) view returns (tuple(string name, string kind, uint32 seats, uint16 quorumPct, uint16 passPct, bool passOfSeats, uint16 overridePct, uint32 noticeMinutes, uint32 voteMinutes, uint32 executiveMinutes, address executive, bool silenceApproves, uint8 residentTier, bool explainDissent, bool reasonsRequired, address clerk, bool active, bool allowAlternates, bool selfGoverned) r, uint32 version, address[] members)',
    ], provider);
    const n = Number(await g.motionCount());
    for (let id = n; id >= Math.max(1, n - 30); id--) {
      const [m] = await g.getMotion(id);
      const stage = Number(m.stage);
      if (![1, 2, 3, 7].includes(stage)) continue;
      const [r] = await g.getBody(m.bodyId);
      const d = await readDoc(cfg, provider, m.ref);
      const t = d?.title || 'see the app';
      if (stage === 1 || stage === 2) {
        if (Number(m.opensAt) > now) out.push({ uid: `motion-open-${cfg.bodiesAddress}-${id}`, at: Number(m.opensAt), title: `${r.name} votes on: ${t}`, body: 'Voting opens. Residents\' vote on it closes now; see where members stand in the app.' });
        if (Number(m.closesAt) > now - 86_400) out.push({ uid: `motion-close-${cfg.bodiesAddress}-${id}`, at: Number(m.closesAt), title: `${r.name} vote closes: ${t}`, body: 'Every member\'s vote and reason is on the public record.' });
      }
      if (stage === 3) out.push({ uid: `motion-exec-${cfg.bodiesAddress}-${id}`, at: Number(m.executiveBy), title: `Sign-or-veto deadline (${r.name}): ${t}`, body: 'The executive must sign or veto by now.' });
      if (stage === 7) out.push({ uid: `motion-override-${cfg.bodiesAddress}-${id}`, at: Number(m.overrideBy), title: `Veto override vote closes (${r.name}): ${t}`, body: 'Members vote on overriding the veto.' });
    }
  }
  if (cfg.councilAddress) {
    const c = new ethers.Contract(cfg.councilAddress, ['function proposalCount() view returns (uint256)', 'function proposal(uint256) view returns (tuple(address target, uint256 value, bytes data, string description, address proposer, uint64 proposedAt, uint64 readyAt, bool fast, bool executed, bool cancelled, bool emergency, address undoTarget, bytes undoData, uint256 ratifyPoll, uint64 ratifyBy, bool lapsed) p, uint8 s, uint256 approvals)'], provider);
    const n = Number(await c.proposalCount().catch(() => 0n));
    for (let id = n; id >= Math.max(1, n - 20); id--) {
      const r = await c.proposal(id).then((x) => (void x[0].lapsed, x)).catch(() => null); // older councils have no emergency lane
      if (!r) break;
      const [p, s] = r;
      if (p.emergency && p.executed && !p.lapsed && Number(p.ratifyBy) > now) out.push({ uid: `emergency-${cfg.councilAddress}-${id}`, at: Number(p.ratifyBy), title: `Ratify or it lapses: council emergency change #${id}`, body: `${p.description}. Vote in poll ${p.ratifyPoll} or it is undone.` });
      else if (Number(s) === 2 && Number(p.readyAt) > now) out.push({ uid: `council-${cfg.councilAddress}-${id}`, at: Number(p.readyAt), title: `Council change #${id} can run`, body: `${p.description}. Any member can still cancel it before then.` });
    }
  }
  return out.sort((x, y) => x.at - y.at);
}

/** "-P1D", "-PT8H", "-PT15M" */
const trigger = (secs) => (secs % 86_400 === 0 ? `-P${secs / 86_400}D` : secs % 3600 === 0 ? `-PT${secs / 3600}H` : `-PT${Math.round(secs / 60)}M`);
const ALARM_WORD = (secs) => (secs % 86_400 === 0 ? `${secs / 86_400} day${secs === 86_400 ? '' : 's'}` : secs % 3600 === 0 ? `${secs / 3600} hour${secs === 3600 ? '' : 's'}` : `${Math.round(secs / 60)} minutes`);

function calendar(events, { appUrl, alarms = [86_400, 8 * 3600, 3600] }) {
  const now = stamp(Math.floor(Date.now() / 1000));
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mandate//Public deadlines//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Mandate: votes and deadlines'];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${ics(e.uid)}@mandate`,
      `DTSTAMP:${now}`,
      `DTSTART:${stamp(e.at - 1800)}`,
      `DTEND:${stamp(e.at)}`,
      fold(`SUMMARY:${ics(e.title)}`),
      fold(`DESCRIPTION:${ics(`${e.body} ${appUrl}`)}`),
      `URL:${ics(appUrl)}`,
      ...alarms.flatMap((a) => ['BEGIN:VALARM', `TRIGGER;RELATED=END:${trigger(a)}`, 'ACTION:DISPLAY', fold(`DESCRIPTION:${ics(`${ALARM_WORD(a)} left: ${e.title}`)}`), 'END:VALARM']),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

module.exports = { atom, calendar, deadlines };
