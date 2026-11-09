# Watchdog auditor

`services/watchdog/` watches every Mandate contract and reports what it finds. It holds
no keys and no power; it only reads public records. Fixed rules decide what counts as an
alert. AI (Claude) only writes the plain-language report, and if the AI is unavailable,
the rules still raise every alert.

## What it flags

| Severity | Rule | Examples |
| --- | --- | --- |
| high | role change (admin) | Someone gained or lost admin rights on any contract |
| high | identity source | An identity source was approved or removed |
| high | enrolment spike | One identity source enrolled more than `ENROL_PER_HOUR` people in an hour |
| high | action failed | A vote passed but its binding action failed |
| high | low balance | The relayer or another operational account is running out of fee money |
| medium | role change (other) | Clerk, poll-opener, verifier, veto and other roles |
| medium | revocation, repeal, veto | A member removed, a mandate repealed, a market decision vetoed |
| medium | binding poll, overdue mandate, metric resolved | Notable but expected events |
| info | polls, mandates, markets | The normal public record |

Each alert names the transaction behind it, so anyone can check it on the block explorer.

## Where it runs

- **GitHub Actions (default, free):** `.github/workflows/watchdog.yml` runs every 30
  minutes and commits `report.md`, `alerts.json` and its state to the `watchdog` branch.
  That branch's history is the permanent public audit trail.
- **Anywhere else:** `node services/watchdog/server.js` runs continuously with an HTTP
  feed (`/alerts`, `/report`, `/report.md`). Several independent organisations should
  each run one.

## Optional settings (GitHub: Settings -> Secrets and variables -> Actions)

- `WATCHDOG_WEBHOOK_URL`: urgent alerts are posted here (a Slack or Discord webhook URL).
- `ANTHROPIC_API_KEY`: the daily report is written in plain language by Claude.

## Limits

- It sees on-chain actions only. Off-chain problems (a clerk enrolling the wrong person)
  show up only as patterns, such as spikes.
- GitHub's scheduler can run late at busy times, so alerts may arrive later than 30 minutes.
- It reports; it doesn't stop anything. Stopping things is the job of multi-signature
  admin control and timelocks.
