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
  # Publish whatever was scanned even if the scan stopped early, so the next run continues
  # from there instead of starting over (then report the failure).
  scan_status=0
  (cd "$APP_DIR" && STATE_DIR="$WORK/data" node services/watchdog/server.js --once) || scan_status=$?
  # Every other community, each in its own folder (c/<slug>/), with its own contracts.
  if [ -n "${CONFIG_URL:-}" ]; then
    slugs="$(cd "$APP_DIR" && node -e "require('./services/lib/communities').loadCommunities(require('./services/lib/communities').indexUrlFrom(process.env.CONFIG_URL, process.env.COMMUNITIES_URL)).then((l) => console.log(l.map((c) => c.slug).join(' '))).catch(() => {})" || true)"
    for slug in $slugs; do
      mkdir -p "$WORK/data/c/$slug"
      community_url="$(dirname "$CONFIG_URL")/communities/$slug.json"
      (cd "$APP_DIR" && CONFIG_URL="$community_url" STATE_DIR="$WORK/data/c/$slug" node services/watchdog/server.js --once) || echo "[watchdog-cron] community $slug: scan stopped early"
    done
  fi
  cd "$WORK/data"
  git config user.name "mandate-watchdog"
  git config user.email "watchdog@users.noreply.github.com"
  git add -A
  if git diff --cached --quiet; then
    echo "[watchdog-cron] nothing new"
    exit "$scan_status"
  fi
  git commit -q -m "Watchdog scan $(date -u +%Y-%m-%dT%H:%MZ) (Render)"
  if git "${auth[@]}" push -q origin "$BRANCH"; then
    echo "[watchdog-cron] findings published"
    exit "$scan_status"
  fi
  # Someone else published first (another run): start again from their history.
  echo "[watchdog-cron] branch moved, retrying ($attempt)"
  cd "$APP_DIR"
  sleep $((attempt * 5))
done
echo "[watchdog-cron] could not publish after 3 attempts" >&2
exit 1
