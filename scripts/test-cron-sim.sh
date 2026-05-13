#!/usr/bin/env bash
# Simulates the exact cron execution environment to reproduce cron failures.
# Strips the PATH down to what cron uses, clears TERM/COLORTERM/etc.,
# then runs cron-run.sh exactly as cron would.
#
# Usage: ./test-cron-sim.sh

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Cron simulation ==="
echo "Stripping PATH to: /usr/bin:/bin:/usr/sbin:/sbin"
echo "Running cron-run.sh via /opt/homebrew/bin/node path..."
echo ""

# Clear the cron log so we can see fresh output
> /tmp/fb-cron.log

# Run with a cron-like environment:
# - Minimal PATH (no /opt/homebrew/bin or user customizations)
# - HOME preserved (dotenv reads ~/.follow-builders/.env via absolute path)
# - USER/LOGNAME preserved (needed by some system calls)
exec env -i \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  HOME="$HOME" \
  USER="${USER:-$(whoami)}" \
  LOGNAME="${USER:-$(whoami)}" \
  /bin/bash "$SCRIPTS_DIR/cron-run.sh"
