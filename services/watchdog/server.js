#!/usr/bin/env node
/**
 * services/watchdog/server.js - independent auditor for a Mandate deployment.
 *
 * Watches every Mandate contract, applies fixed rules (rules.js), runs periodic
 * checks (overdue mandates, operational balances), and publishes:
 *
 *   GET /alerts            newest first; ?severity=high&limit=50
 *   GET /report            the latest daily report (JSON)
 *   GET /report.md         the same, as text for people
 *   GET /health
 *
 * High-severity alerts are also POSTed to WEBHOOK_URL (Slack, Discord or any
 * service that accepts JSON with "text" / "content").
 *
 * The watchdog holds no keys and no power: it only reads public records and
 * reports. Several independent organisations should each run one.
 *
 * Environment
 *   CONFIG_URL            the voter app's published config.json (contract addresses, RPC)
 *   RPC_URL               optional override
 *   START_BLOCK           first block to scan (default: latest - LOOKBACK_BLOCKS)
 *   LOOKBACK_BLOCKS       default 43200 (about one day on Base)
 *   LOG_BLOCK_SPAN        blocks per log query, default 200 (public RPC limit)
 *   POLL_INTERVAL_MS      default 60000
 *   ENROL_PER_HOUR        enrolments per identity source per hour before alerting, default 50
 *   WATCH_BALANCES        JSON [{"label":"Relayer","address":"0x…","minEth":"0.0005"}]
 *   WATCH_EXPIRY          JSON [{"label":"Microsoft sign-in secret","expires":"2028-11-08","fix":"…"}]
 *   WATCH_FILE            JSON file with { balances, expiry } used when the two above are unset
 *                         (default services/watchdog/watchlist.json)
 *                         warns 30 days ahead (medium), 7 days ahead (high), and once expired (high)
 *   WEBHOOK_URL           optional, receives high-severity alerts
 *   ANTHROPIC_API_KEY     optional, plain-language reports by Claude (rules work without it)
 *   REPORT_HOUR_UTC       hour of the daily report, default 6
 *   STATE_DIR             with --once: where state.json, alerts.json and report.md live
 *
 * Modes
 *   node services/watchdog/server.js          long-running service with the HTTP feed
 *   node services/watchdog/server.js --once   one scan, resuming from STATE_DIR (for schedulers)
 */

'use strict';

require('dotenv').config();

const http = require('http');
const { ethers } = require('ethers');
const { rulesForEvent, short } = require('./rules');
const { summarize } = require('./summarize');

const ABIS = {
  identity: [
    'event IssuerSet(address indexed issuer, uint8 maxTier, bool active, string name)',
    'event Enrolled(uint256 indexed commitment, address indexed issuer, uint8 tier, uint64 residentSince)',
    'event Revoked(uint256 indexed commitment, address indexed by)',
  ],
  vote: [
    'event PollCreated(uint256 indexed id, uint256 indexed groupId, uint256 snapshotRoot, uint8 action, uint64 end, string questionCID)',
    'event PollFinalized(uint256 indexed id, bool passed, uint256 totalBallots)',
    'event ActionFailed(uint256 indexed id, uint8 action, bytes reason)',
    'event PollCrossChecked(uint256 indexed id, uint256 indexed checkGroupId, uint256 checkRoot, uint32 checkQuorum)',
    'event PollDisputed(uint256 indexed id, uint256 yes, uint256 no, uint256 checkYes, uint256 checkNo)',
  ],
  registry: [
    'event MandateCreated(uint256 indexed id, address indexed responsible, bytes32 indexed category, uint64 deadline, uint16 threshold, string specCID)',
    'event MandateFulfilled(uint256 indexed id, uint32 round, string evidenceCID)',
    'event MandateCancelled(uint256 indexed id, string reasonCID)',
    'function mandateCount() view returns (uint256)',
    'function isOverdue(uint256) view returns (bool)',
  ],
  charter: [
    'event RuleChanged(bytes32 indexed key, string name, uint256 oldValue, uint256 newValue)',
  ],
  budget: [
    'event RoundCreated(uint256 indexed id, uint256 indexed groupId, uint64 end, uint32 credits, uint256 budget, uint256 proposals, string ref)',
    'event RoundFinalized(uint256 indexed id, uint256 fundedMask, uint256 spent, uint256 participants)',
  ],
  council: [
    'event Proposed(uint256 indexed id, address indexed proposer, address target, uint256 value, bytes data, string description, bool fast)',
    'event Queued(uint256 indexed id, uint64 readyAt)',
    'event Executed(uint256 indexed id)',
    'event Cancelled(uint256 indexed id, address indexed by)',
    'event MemberAdded(address indexed member)',
    'event MemberRemoved(address indexed member)',
    'event ThresholdChanged(uint256 threshold)',
    'event DelayChanged(uint64 delay)',
  ],
  market: [
    'event Decided(uint256 indexed id, uint8 chosen, uint256 twapPass, uint256 twapFail, uint64 vetoEnd)',
    'event Vetoed(uint256 indexed id, address indexed by)',
    'event MetricResolved(uint256 indexed id, bool met)',
  ],
};
const ROLE_EVENTS = [
  'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
  'event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)',
];
const CONTRACT_LABEL = { identity: 'identity registry', vote: 'voting', registry: 'mandate registry', market: 'decision markets', council: 'council', charter: 'charter (voting rules)', budget: 'civic budget' };

/**
 * @param {object} o
 * @param {ethers.Provider} o.provider
 * @param {{identity:string, vote:string, registry?:string, market?:string}} o.addresses
 * @param {number} o.startBlock
 */
function createWatchdog(o) {
  const log = o.log || ((m) => console.log(`${new Date().toISOString()} [watchdog] ${m}`));
  const span = o.blockSpan || 200;
  const contracts = Object.entries(o.addresses).filter(([, a]) => a && ethers.isAddress(a));
  const byAddress = new Map(contracts.map(([k, a]) => [a.toLowerCase(), { key: k, iface: new ethers.Interface([...(ABIS[k] || []), ...ROLE_EVENTS]) }]));
  const registry = o.addresses.registry ? new ethers.Contract(o.addresses.registry, ABIS.registry, o.provider) : null;

  const ctx = {
    thresholds: { enrolPerHour: o.enrolPerHour ?? 50 },
    enrolWindows: new Map(),
    spikeFlagged: new Map(),
    issuerNames: new Map(),
    proposals: new Map(), // council proposal id -> summary, to name it in later alerts
    contractNames: Object.fromEntries(contracts.map(([k, a]) => [a.toLowerCase(), CONTRACT_LABEL[k] || k])),
  };
  const alerts = [];
  const flaggedOnce = new Set(); // periodic checks: alert once until the condition clears
  const blockTimes = new Map();
  let nextBlock = o.startBlock;
  let lastReport = null;

  // Public RPCs rate-limit (Base Sepolia: 25 requests/second). Pace calls and retry
  // politely on rate-limit or transient errors instead of failing the scan.
  const minGapMs = o.minGapMs ?? 80;
  let lastCall = 0;
  async function rpc(fn) {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCall = Date.now();
      try {
        return await fn();
      } catch (e) {
        const text = `${e?.message || ''} ${JSON.stringify(e?.error || e?.info || '')}`;
        const transient = /rate|limit|429|-32007|timeout|ECONNRESET|503|502/i.test(text);
        if (!transient || attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }

  async function timeOf(n) {
    if (!blockTimes.has(n)) {
      blockTimes.set(n, (await rpc(() => o.provider.getBlock(n))).timestamp);
      if (blockTimes.size > 5000) blockTimes.delete(blockTimes.keys().next().value);
    }
    return blockTimes.get(n);
  }

  async function raise(list) {
    for (const a of list) {
      a.id = `${a.rule}:${a.tx || a.key}:${a.time}`;
      alerts.unshift(a);
      log(`[${a.severity}] ${a.title}`);
      if (a.severity === 'high' && o.webhookUrl) {
        const text = `Mandate watchdog: ${a.title}${a.tx && o.explorer ? `\n${o.explorer}/tx/${a.tx}` : ''}`;
        fetch(o.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, content: text, alert: a }) })
          .catch((e) => log(`webhook failed: ${e.message}`));
      }
    }
    if (alerts.length > 2000) alerts.length = 2000;
  }

  /** Read new events in small block ranges; returns the alerts raised. */
  async function scanEvents() {
    const head = await rpc(() => o.provider.getBlockNumber());
    const raised = [];
    while (nextBlock <= head) {
      const to = Math.min(nextBlock + span - 1, head);
      let logs;
      try {
        logs = await rpc(() => o.provider.getLogs({ address: contracts.map(([, a]) => a), fromBlock: nextBlock, toBlock: to }));
      } catch (e) {
        await raise(raised); // keep what was found before the failure
        throw e;
      }
      logs.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
      for (const l of logs) {
        const src = byAddress.get(l.address.toLowerCase());
        let parsed;
        try {
          parsed = src.iface.parseLog(l);
        } catch {
          continue;
        }
        if (!parsed) continue;
        const ev = { contract: CONTRACT_LABEL[src.key] || src.key, name: parsed.name, args: parsed.args, tx: l.transactionHash, block: l.blockNumber, time: await timeOf(l.blockNumber) };
        const found = rulesForEvent(ev, ctx);
        raised.push(...found);
      }
      nextBlock = to + 1;
    }
    await raise(raised);
    return raised;
  }

  /** Conditions that are true over time rather than events. */
  async function periodicChecks() {
    const now = (await rpc(() => o.provider.getBlock('latest'))).timestamp;
    const raised = [];
    for (const w of o.watchBalances || []) {
      const bal = await rpc(() => o.provider.getBalance(w.address));
      const key = `balance:${w.address.toLowerCase()}`;
      const min = ethers.parseEther(String(w.minEth ?? '0.0005'));
      if (bal < min && !flaggedOnce.has(key)) {
        flaggedOnce.add(key);
        raised.push({ rule: 'low-balance', severity: 'high', key, time: now, title: `${w.label} (${short(w.address)}) is low on fee money: ${ethers.formatEther(bal)} ETH left`, facts: { address: w.address, balance: ethers.formatEther(bal), minimum: ethers.formatEther(min) } });
      } else if (bal >= min) flaggedOnce.delete(key);
    }
    for (const x of o.watchExpiry || []) {
      const expires = Date.parse(x.expires);
      if (!Number.isFinite(expires)) continue;
      const days = Math.floor((expires - (o.now ? o.now() : Date.now())) / 86_400_000);
      const stage = days < 0 ? 'expired' : days <= 7 ? '7d' : days <= 30 ? '30d' : null;
      const base = `expiry:${x.label}`;
      if (!stage) {
        for (const st of ['30d', '7d', 'expired']) flaggedOnce.delete(`${base}:${st}`);
        continue;
      }
      const key = `${base}:${stage}`;
      if (flaggedOnce.has(key)) continue;
      flaggedOnce.add(key);
      const when = new Date(expires).toISOString().slice(0, 10);
      raised.push({
        rule: 'credential-expiry',
        severity: stage === '30d' ? 'medium' : 'high',
        key,
        time: now,
        title: stage === 'expired'
          ? `${x.label} expired on ${when}: renew it now${x.fix ? ` (${x.fix})` : ''}`
          : `${x.label} expires on ${when}, in ${days} day${days === 1 ? '' : 's'}${x.fix ? `: ${x.fix}` : ''}`,
        facts: { label: x.label, expires: when, daysLeft: days },
      });
    }
    if (registry) {
      const n = Number(await rpc(() => registry.mandateCount()));
      for (let id = 1; id <= n; id++) {
        const key = `overdue:${id}`;
        if (await rpc(() => registry.isOverdue(id))) {
          if (!flaggedOnce.has(key)) {
            flaggedOnce.add(key);
            raised.push({ rule: 'mandate-overdue', severity: 'medium', key, time: now, title: `Mandate ${id} is past its deadline and not fulfilled; anyone may now trigger clawbacks on its escrow`, facts: { mandate: String(id) } });
          }
        } else flaggedOnce.delete(key);
      }
    }
    await raise(raised);
    return raised;
  }

  async function scanOnce() {
    const a = await scanEvents();
    const b = await periodicChecks();
    return [...a, ...b];
  }

  /** Report over the last `hours` of alerts. */
  async function buildReport({ hours = 24, client } = {}) {
    const latestTime = (await o.provider.getBlock('latest')).timestamp;
    const recent = alerts.filter((a) => latestTime - a.time <= hours * 3600).slice().reverse();
    const counts = { high: 0, medium: 0, info: 0 };
    for (const a of recent) counts[a.severity] = (counts[a.severity] || 0) + 1;
    const summary = await summarize(recent, { client: client ?? o.aiClient, log });
    lastReport = { generatedAt: new Date(latestTime * 1000).toISOString(), periodHours: hours, counts, summary: summary.text, summaryBy: summary.by, alerts: recent };
    return lastReport;
  }

  function reportMarkdown(r) {
    if (!r) return 'No report yet.';
    const lines = [`# Mandate audit report`, '', `Generated ${r.generatedAt} · last ${r.periodHours} hours · ${r.counts.high} high, ${r.counts.medium} medium, ${r.counts.info} info`, '', r.summary, '', '## All alerts', ''];
    for (const a of r.alerts) lines.push(`- **${a.severity}** ${a.title}${a.tx && o.explorer ? ` ([tx](${o.explorer}/tx/${a.tx}))` : ''}`);
    if (!r.alerts.length) lines.push('- none');
    lines.push('', `Summary written by: ${r.summaryBy === 'rules' ? 'fixed rules' : `AI (${r.summaryBy}); the alerts themselves come from fixed rules`}.`);
    return lines.join('\n');
  }

  function server() {
    return http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const send = (code, body, type = 'application/json') => {
        res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        res.end(type === 'application/json' ? JSON.stringify(body) : body);
      };
      if (url.pathname === '/health') return send(200, { ok: true, nextBlock });
      if (url.pathname === '/alerts') {
        const sev = url.searchParams.get('severity');
        const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
        return send(200, alerts.filter((a) => !sev || a.severity === sev).slice(0, limit));
      }
      if (url.pathname === '/report') return send(200, lastReport || { message: 'No report yet' });
      if (url.pathname === '/report.md') return send(200, reportMarkdown(lastReport), 'text/markdown; charset=utf-8');
      send(404, { error: 'not found' });
    });
  }

  /** Everything needed to resume after a restart (the scheduled runner saves this between runs). */
  function exportState() {
    return {
      nextBlock,
      alerts,
      lastReport,
      flaggedOnce: [...flaggedOnce],
      enrolWindows: [...ctx.enrolWindows],
      spikeFlagged: [...ctx.spikeFlagged],
      issuerNames: [...ctx.issuerNames],
      proposals: [...ctx.proposals],
    };
  }
  function importState(st) {
    if (!st) return;
    nextBlock = st.nextBlock ?? nextBlock;
    alerts.splice(0, alerts.length, ...(st.alerts || []));
    lastReport = st.lastReport || null;
    for (const k of st.flaggedOnce || []) flaggedOnce.add(k);
    for (const [k, v] of st.enrolWindows || []) ctx.enrolWindows.set(k, v);
    for (const [k, v] of st.spikeFlagged || []) ctx.spikeFlagged.set(k, v);
    for (const [k, v] of st.issuerNames || []) ctx.issuerNames.set(k, v);
    for (const [k, v] of st.proposals || []) ctx.proposals.set(k, v);
  }

  return { scanOnce, scanEvents, periodicChecks, buildReport, reportMarkdown, server, alerts, exportState, importState, get nextBlock() { return nextBlock; } };
}

module.exports = { createWatchdog };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const once = process.argv.includes('--once');
  const watchFile = String(process.env.WATCH_FILE || '').trim() || path.join(__dirname, 'watchlist.json');
  const watchList = fs.existsSync(watchFile) ? JSON.parse(fs.readFileSync(watchFile, 'utf8')) : {};
  (async () => {
    const env = (n) => String(process.env[n] || '').trim();
    let cfg = {};
    if (env('CONFIG_URL')) cfg = await (await fetch(`${env('CONFIG_URL')}?t=${Date.now()}`, { cache: 'no-store' })).json();
    const rpcUrl = env('RPC_URL') || cfg.rpcUrl;
    if (!rpcUrl) throw new Error('set CONFIG_URL or RPC_URL');
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const head = await provider.getBlockNumber();
    const startBlock = env('START_BLOCK') ? Number(env('START_BLOCK')) : cfg.startBlock ? Number(cfg.startBlock) : Math.max(0, head - Number(env('LOOKBACK_BLOCKS') || 43_200));
    const dog = createWatchdog({
      provider,
      addresses: { identity: cfg.identityAddress, vote: cfg.voteAddress, registry: cfg.registryAddress, market: cfg.marketAddress, council: cfg.councilAddress, charter: cfg.charterAddress, budget: cfg.budgetAddress },
      startBlock,
      blockSpan: Number(env('LOG_BLOCK_SPAN') || 200),
      enrolPerHour: Number(env('ENROL_PER_HOUR') || 50),
      watchBalances: env('WATCH_BALANCES') ? JSON.parse(env('WATCH_BALANCES')) : watchList.balances || [],
      watchExpiry: env('WATCH_EXPIRY') ? JSON.parse(env('WATCH_EXPIRY')) : watchList.expiry || [],
      webhookUrl: env('WEBHOOK_URL') || undefined,
      explorer: cfg.explorer,
    });

    if (once) {
      // Scheduled mode (GitHub Actions): resume from STATE_DIR, scan, write the public files, exit.
      const dir = env('STATE_DIR') || 'watchdog-data';
      fs.mkdirSync(dir, { recursive: true });
      const stateFile = path.join(dir, 'state.json');
      let st = null;
      try {
        st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch {
        /* first run */
      }
      // A redeploy changes the contracts: start a fresh history for the new addresses.
      const watched = [cfg.identityAddress, cfg.voteAddress, cfg.registryAddress, cfg.marketAddress].join(',');
      if (st && st.watched === watched) dog.importState(st);
      let raised = [];
      let scanError = null;
      try {
        raised = await dog.scanOnce();
      } catch (e) {
        scanError = e; // save progress anyway; the next run continues from here
      }
      const prev = st?.lastReport;
      const needSummary = raised.length > 0 || !prev || Date.now() - Date.parse(prev.writtenAt || 0) > 24 * 3600 * 1000;
      const report = needSummary ? await dog.buildReport({ hours: 24 }) : prev;
      if (needSummary) report.writtenAt = new Date().toISOString();
      const state = { ...dog.exportState(), lastReport: report, watched };
      fs.writeFileSync(stateFile, JSON.stringify(state, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
      fs.writeFileSync(path.join(dir, 'alerts.json'), JSON.stringify(dog.alerts.slice(0, 500), (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
      fs.writeFileSync(path.join(dir, 'report.md'), dog.reportMarkdown(report) + '\n');
      console.log(`[watchdog] scanned to block ${dog.nextBlock - 1}; ${raised.length} new alert(s); report ${needSummary ? 'updated' : 'unchanged'}`);
      if (scanError) {
        console.error(`[watchdog] scan stopped early (${scanError.shortMessage || scanError.message}); progress saved`);
        process.exitCode = 1;
      }
      return;
    }

    const port = Number(env('PORT') || 8791);
    dog.server().listen(port, () => console.log(`[watchdog] listening on :${port}; scanning from block ${startBlock} (head ${head})`));
    const reportHour = Number(env('REPORT_HOUR_UTC') || 6);
    let lastReportDay = '';
    const tick = async () => {
      try {
        await dog.scanOnce();
        const now = new Date();
        const day = now.toISOString().slice(0, 10);
        if (!lastReportDay || (now.getUTCHours() === reportHour && day !== lastReportDay)) {
          lastReportDay = day;
          const r = await dog.buildReport({ hours: 24 });
          console.log(`[watchdog] report: ${r.counts.high} high, ${r.counts.medium} medium, ${r.counts.info} info`);
        }
      } catch (e) {
        console.error(`[watchdog] scan error: ${e.shortMessage || e.message}`);
      }
      setTimeout(tick, Number(env('POLL_INTERVAL_MS') || 60_000));
    };
    tick();
  })().catch((e) => {
    console.error(`[watchdog] ${e.message}`);
    process.exit(1);
  });
}
