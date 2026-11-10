/**
 * services/watchdog/feeds.js - public feeds anyone can subscribe to, with no account:
 *   feed.xml      Atom news feed of everything the watchdog records (polls, mandates, budget
 *                 rounds, petitions, council and rule changes), for readers, newsrooms,
 *                 libraries and social-media accounts to repost
 *   calendar.ics  iCalendar feed: when polls and budget rounds close, mandate deadlines
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
  return out.sort((x, y) => x.at - y.at);
}

function calendar(events, { appUrl }) {
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
      'BEGIN:VALARM',
      'TRIGGER:-PT24H',
      'ACTION:DISPLAY',
      fold(`DESCRIPTION:${ics(e.title)}`),
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

module.exports = { atom, calendar, deadlines };
