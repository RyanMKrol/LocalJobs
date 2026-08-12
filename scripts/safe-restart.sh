#!/bin/bash
# safe-restart.sh — restart the local-jobs daemon, but refuse while any workflow run is active.
#
# A daemon restart hard-kills every in-flight child process; the fresh daemon then reaps the
# orphaned workflow runs as "cancelled". That has now interrupted three real runs (twice from
# the autonomous loop, once from a parallel session deploying an unrelated workflow). Use this
# script instead of calling `launchctl kickstart` directly, in every session and every doc.
#
# Usage:
#   scripts/safe-restart.sh            # restart, or refuse (exit 1) if a run is active
#   scripts/safe-restart.sh --force    # restart anyway, killing in-flight runs deliberately
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB="$REPO_DIR/data/jobs.db"
FORCE=0
if [ "${1:-}" = "--force" ]; then FORCE=1; fi

if [ -f "$DB" ]; then
  ACTIVE=$(/usr/bin/sqlite3 "$DB" \
    "SELECT '  ' || workflow_name || '  (run ' || id || ', started ' || started_at || ' UTC)' \
     FROM workflow_runs WHERE status='running' ORDER BY started_at;")
  if [ -n "$ACTIVE" ] && [ "$FORCE" -ne 1 ]; then
    echo "REFUSING to restart the daemon: workflow run(s) are active:" >&2
    echo "$ACTIVE" >&2
    echo "" >&2
    echo "A restart hard-kills in-flight runs (they get reaped as 'cancelled')." >&2
    echo "Wait for the run(s) to settle, cancel them via the dashboard first," >&2
    echo "or re-run with --force if interrupting them is the intent." >&2
    exit 1
  fi
fi

launchctl kickstart -k "gui/$(id -u)/com.ryankrol.localjobs"
echo "daemon restarted (com.ryankrol.localjobs)"
