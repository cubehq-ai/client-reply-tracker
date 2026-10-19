#!/usr/bin/env bash
# Installs the ReplyQueue worker as a launchd agent for the current user.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.cubehq.replyqueue.worker"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

# Check the configuration before installing. A launchd agent that cannot
# reach the database crash-loops silently in a log file nobody is reading.
echo "checking configuration..."
if ! (cd "$ROOT" && npx tsx scripts/check-db.ts >/dev/null 2>&1); then
  echo
  echo "FAILED: cannot connect to DATABASE_URL from .env" >&2
  echo "Fix .env first, then re-run this script. Required keys:" >&2
  echo "  DATABASE_URL, GOOGLE_SERVICE_ACCOUNT_FILE, GOOGLE_BACKEND=real, BACKFILL_DAYS" >&2
  exit 1
fi
echo "database reachable."

mkdir -p "$HOME/Library/LaunchAgents"
sed "s|__WORKING_DIRECTORY__|$ROOT|" "$ROOT/deploy/$LABEL.plist" > "$TARGET"

launchctl unload -w "$TARGET" 2>/dev/null || true
launchctl load -w "$TARGET"

echo "installed: $TARGET"
echo "working directory: $ROOT"
echo
launchctl list | grep replyqueue || echo "not listed yet — check /tmp/replyqueue-worker.log"
echo
echo "logs:  tail -f /tmp/replyqueue-worker.log"
echo "stop:  launchctl unload -w $TARGET"
