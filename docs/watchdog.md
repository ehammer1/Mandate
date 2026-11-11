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
| high | enrollment spike | One identity source enrolled more than `ENROL_PER_HOUR` people in an hour |
| high | action failed | A vote passed but its binding action failed |
| high | low balance | The relayer or another operational account is running out of fee money |
| medium / high | credential expiry | An outside credential (such as the Microsoft sign-in secret) expires within 30 days (medium) or 7 days, or has expired (high). Dates live in `WATCH_EXPIRY` in `.github/workflows/watchdog.yml`; change the date there after renewing. |
| medium | role change (other) | Clerk, poll-opener, verifier, veto and other roles |
| medium | revocation, repeal, veto | A member removed, a mandate repealed, a market decision vetoed |
| medium | binding poll, overdue mandate, metric resolved | Notable but expected events |
| info | polls, mandates, markets | The normal public record |

Each alert names the transaction behind it, so anyone can check it on the block explorer.

## Where it runs

- **Render cron job (main, about $1/month):** `mandate-watchdog` in `render.yaml` runs
  `scripts/watchdog-cron.sh` every 15 minutes: it loads the history from the `watchdog`
  branch, scans, and pushes `report.md`, `alerts.json` and its state back. That branch's
  history is the permanent public audit trail. Needs `GITHUB_TOKEN` (below).
- **GitHub Actions (backup, free):** `.github/workflows/watchdog.yml` does the same on
  GitHub's schedule, which runs only when GitHub has spare capacity (sometimes hours
  apart). The two take turns safely: a run that finds the branch moved starts again from
  the newer history.
- **Anywhere else:** `node services/watchdog/server.js` runs continuously with an HTTP
  feed (`/alerts`, `/report`, `/report.md`). Several independent organisations should
  each run one.

## What it watches besides events

`services/watchdog/watchlist.json`: operational accounts that must not run out of fee money,
and dates when outside credentials expire (renew, then update the date there).

## Render setup

1. GitHub (signed in as the repository owner): Settings -> Developer settings ->
   Personal access tokens -> Fine-grained tokens -> Generate new token. Repository access:
   only `ehammer1/Mandate`. Permissions: Contents -> Read and write. Copy the token.
2. Render: Blueprints -> the Mandate blueprint -> Manual sync. Render creates
   `mandate-watchdog` (a cron job needs a payment method on the account).
3. `mandate-watchdog` -> Environment: paste the token as `GITHUB_TOKEN` -> Save. Then
   Trigger Run to check: the log ends with "findings published" or "nothing new".

## Optional settings (GitHub: Settings -> Secrets and variables -> Actions)

- `WATCHDOG_WEBHOOK_URL`: urgent alerts are posted here (a Slack or Discord webhook URL).
- `ANTHROPIC_API_KEY`: the daily report is written in plain language by Claude.

## Limits

- It sees on-chain actions only. Off-chain problems (a clerk enrolling the wrong person)
  show up only as patterns, such as spikes.
- GitHub's scheduler can run late at busy times, so alerts may arrive later than 30 minutes.
- It reports; it doesn't stop anything. Stopping things is the job of multi-signature
  admin control and timelocks.
