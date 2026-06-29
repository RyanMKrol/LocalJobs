#!/usr/bin/env bash
#
# supervise.sh — run loop.sh on a fixed cadence, in the FOREGROUND, so you can watch it.
#
# Leave it in a terminal for days. Each cycle runs the single sequential loop (loop.sh),
# which builds tasks one at a time directly on main until the backlog is done, a human gate
# is hit, or tokens run out. The loop's lock makes a fresh cycle a no-op if a previous loop
# is somehow still running, so overlap is harmless. Stop with Ctrl-C (cleanest between cycles
# — the banner tells you when it's idle).
#
# Cadence is measured from the START of each cycle, so cycles line up with the token-refresh
# window no matter how long a cycle takes. Default 5h + 15m buffer (tokens refresh ~5h after
# first use; the buffer avoids firing just before reset). Tune for your own quota window.
#
# Usage:  .harness/supervise.sh [interval_seconds] [max_cycles]
#   interval_seconds  default 18900 (5h15m)
#   max_cycles        default 0 (run forever)
# Tip: the loop streams its own progress; this just paces and re-launches it.
set -uo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOOP="${LOOP:-$HARNESS_DIR/loop.sh}"
INTERVAL="${1:-18900}"
MAX_CYCLES="${2:-0}"

stamp() { date '+%Y-%m-%d %H:%M:%S'; }
cycle=0
trap 'echo; echo "[supervise $(stamp)] stopped (after ${cycle} cycle(s))."; exit 0' INT TERM

echo "[supervise $(stamp)] starting — run loop.sh every ${INTERVAL}s (from each cycle's start). Ctrl-C to stop."
while :; do
  cycle=$((cycle + 1))
  start=$(date +%s)
  echo "======================================================================"
  echo "[supervise $(stamp)] cycle ${cycle}: launching loop.sh"
  echo "======================================================================"
  "$LOOP"; loop_rc=$?
  [ "$loop_rc" -ne 0 ] && echo "[supervise $(stamp)] loop exited non-zero (rc=${loop_rc})"

  if [ "$MAX_CYCLES" -gt 0 ] && [ "$cycle" -ge "$MAX_CYCLES" ]; then
    echo "[supervise $(stamp)] reached max cycles (${MAX_CYCLES}); exiting."
    exit 0
  fi

  elapsed=$(( $(date +%s) - start ))
  printf '\a'   # terminal bell: cycle finished, loop idle
  if [ "$loop_rc" -ne 0 ]; then
    # Abnormal / early exit (crash, dirty-tree refusal, etc.). The loop now OWNS its usage-limit waits
    # (it sleeps to the reset INTERNALLY and keeps working), so a non-zero exit is NOT "quota window
    # exhausted" — don't park the whole INTERVAL. Short backoff, then relaunch. (Previously supervise
    # parked the full 5h15m from cycle start regardless, wasting hours after an early exit.)
    short="${SUPERVISE_ERROR_BACKOFF:-300}"
    echo "══════════════════════════════════════════════════════════════════════"
    echo "🔔 [supervise $(stamp)] cycle ${cycle} exited abnormally (rc=${loop_rc}, ran ${elapsed}s)."
    echo "   Short backoff ${short}s, then relaunch — NOT the full ${INTERVAL}s window."
    echo "   ✅ SAFE TO Ctrl-C NOW — nothing is running."
    echo "══════════════════════════════════════════════════════════════════════"
    sleep "$short"
    continue
  fi
  remain=$(( INTERVAL - elapsed ))
  if [ "$remain" -gt 0 ]; then
    next=$(date -v+"${remain}"S '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "in ${remain}s")
    echo "══════════════════════════════════════════════════════════════════════"
    echo "🔔 [supervise $(stamp)] cycle ${cycle} complete (ran ${elapsed}s)."
    echo "   The loop is idle until the next cycle ~${next}."
    echo "   ✅ SAFE TO Ctrl-C NOW — nothing is running. Re-run supervise.sh to resume."
    echo "══════════════════════════════════════════════════════════════════════"
    sleep "$remain"
  else
    echo "🔔 [supervise $(stamp)] cycle ${cycle} ran ${elapsed}s (≥ interval) — launching next now."
  fi
done
