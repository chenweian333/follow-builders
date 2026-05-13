#!/usr/bin/env bash
# Wraps the full digest pipeline for cron.
# On any step failure, sends a Telegram error notification.

set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE_BINARY:-$(command -v node 2>/dev/null || echo /opt/homebrew/bin/node)}"
LOG="/tmp/fb-cron.log"
RAW="/tmp/fb-raw.json"
DIGEST="/tmp/fb-digest.txt"

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
fail() {
  local reason="$1"
  log "FATAL: $reason"
  "$NODE" "$SCRIPTS_DIR/deliver.js" --error "Pipeline failed at: $reason" >> "$LOG" 2>&1 || true
  exit 1
}

log "=== Cron run starting ==="

cd "$SCRIPTS_DIR" || fail "Cannot cd to $SCRIPTS_DIR"

log "Step 1/4: prepare-user-digest.js"
"$NODE" prepare-user-digest.js > "$RAW" 2>>"$LOG" \
  || fail "prepare-user-digest.js (exit $?)"

log "Step 2/4: remix-digest.js"
"$NODE" remix-digest.js < "$RAW" > "$DIGEST" 2>>"$LOG" \
  || fail "remix-digest.js (exit $?)"

log "Step 3/4: db-store.js"
"$NODE" db-store.js --raw "$RAW" --digest "$DIGEST" >> "$LOG" 2>&1 \
  || fail "db-store.js (exit $?)"

log "Step 4/4: deliver.js"
"$NODE" deliver.js --file "$DIGEST" >> "$LOG" 2>&1 \
  || fail "deliver.js (exit $?)"

log "=== Cron run complete ==="
