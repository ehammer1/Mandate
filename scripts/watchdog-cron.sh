#!/usr/bin/env bash
# One watchdog scan for a scheduler (Render cron job): load the audit history from the
# watchdog branch, scan, publish the findings back to that branch.
#
#   GITHUB_TOKEN   fine-grained token with Contents: read and write on the repository
#   GITHUB_REPO    owner/name (default ehammer1/Mandate); REPO_URL overrides the full URL
#   WATCHDOG_BRANCH default watchdog
# Everything else (CONFIG_URL, WEBHOOK_URL, ANTHROPIC_API_KEY, ...) goes to the scanner.
set -euo pipefail

REPO="${GITHUB_REPO:-ehammer1/Mandate}"
BRANCH="${WATCHDOG_BRANCH:-watchdog}"
URL="${REPO_URL:-https://github.com/${REPO}.git}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The token travels in a header for this command only: never in the URL, logs or .git/config.
auth=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  auth=(-c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')")
elif [[ "$URL" == https://* ]]; then
  echo "[watchdog-cron] GITHUB_TOKEN is not set: cannot publish findings" >&2
  exit 1
fi

for attempt in 1 2 3; do
  rm -rf "$WORK/data"
  git "${auth[@]}" clone -q --depth 5 --branch "$BRANCH" "$URL" "$WORK/data"
  (cd "$APP_DIR" && STATE_DIR="$WORK/data" node services/watchdog/server.js --once)
  cd "$WORK/data"
  git config user.name "mandate-watchdog"
  git config user.email "watchdog@users.noreply.github.com"
  git add -A
  if git diff --cached --quiet; then
    echo "[watchdog-cron] nothing new"
    exit 0
  fi
  git commit -q -m "Watchdog scan $(date -u +%Y-%m-%dT%H:%MZ) (Render)"
  if git "${auth[@]}" push -q origin "$BRANCH"; then
    echo "[watchdog-cron] findings published"
    exit 0
  fi
  # Someone else published first (another run): start again from their history.
  echo "[watchdog-cron] branch moved, retrying ($attempt)"
  cd "$APP_DIR"
  sleep $((attempt * 5))
done
echo "[watchdog-cron] could not publish after 3 attempts" >&2
exit 1
