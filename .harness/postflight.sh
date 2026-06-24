#!/usr/bin/env bash
#
# postflight.sh — read-only, ZERO-TOKEN status board for the in-place loop.
#
# Counterpart to loop.sh: it reports what the backlog looks like, reading the SAME local
# sources the loop uses — .harness/TASKS.json + .harness/worklog/. It never invokes Claude,
# so it's fast, reliable, and free to run every cycle.
#
# Output goes to stdout AND to .harness/worklog/STATUS.md (overwritten each run).
# Usage:  .harness/postflight.sh     Exit: 0 always (informational; never fails a cycle).
set -uo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$HARNESS_DIR" rev-parse --show-toplevel)"
NAME="$(basename "$ROOT")"
BACKLOG="$HARNESS_DIR/TASKS.json"
WORKLOG="$HARNESS_DIR/worklog"
STATUS_FILE="$WORKLOG/STATUS.md"
mkdir -p "$WORKLOG"

command -v jq >/dev/null 2>&1 || { echo "[postflight] jq required to parse TASKS.json" >&2; exit 0; }
[ -f "$BACKLOG" ] || { echo "[postflight] no .harness/TASKS.json" >&2; exit 0; }

tj()           { jq "$@" "$BACKLOG" 2>/dev/null; }
all_tasks()    { tj -r '.tasks[].id'; }
task_done()    { tj -e --arg id "$1" '.tasks[]|select(.id==$id)|.status=="done"' >/dev/null; }
task_title()   { tj -r --arg id "$1" '.tasks[]|select(.id==$id)|.title'; }
deps_for()     { tj -r --arg id "$1" '.tasks[]|select(.id==$id)|.dependsOn[]?' | tr '\n' ' '; }
is_gate()      { tj -e --arg id "$1" '.tasks[]|select(.id==$id)|.gate=="gate"' >/dev/null; }
needs_human()  { tj -e --arg id "$1" '.tasks[]|select(.id==$id)|.gate=="needs-human"' >/dev/null; }
task_blocked() { [ -f "$WORKLOG/$1.md" ] && grep -qiE 'failed:blocked|needs-human' "$WORKLOG/$1.md"; }

board=(); needs=(); ready=0; done_all=1
for t in $(all_tasks); do
  task_done "$t" && continue
  done_all=0
  title="$(task_title "$t")"
  if is_gate "$t"; then
    board+=("  🚦 gate         $t  $title")
    needs+=("$t — 🚦 gate: review the deliverable before dependents proceed ($title)")
  elif needs_human "$t" || task_blocked "$t"; then
    board+=("  🔒 needs you     $t  $title")
    needs+=("$t — 🔒 needs-human: $title")
  else
    unmet=""
    for d in $(deps_for "$t"); do task_done "$d" || unmet="$unmet $d"; done
    if [ -n "$unmet" ]; then
      board+=("  ⏳ waiting deps  $t  (needs:${unmet} )")
    else
      board+=("  ▶︎  ready         $t  $title")
      ready=$((ready + 1))
    fi
  fi
done

dirty=""; [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ] && dirty="yes"
: >"$STATUS_FILE"
out() { printf '%s\n' "$*"; printf '%s\n' "$*" >>"$STATUS_FILE"; }

out "# $NAME — loop status ($(date '+%Y-%m-%d %H:%M:%S'))"
out ""
if [ -n "$dirty" ]; then out "🔨 Working tree is DIRTY (a task is mid-build / partial work present)."
else out "(working tree clean — the loop is between tasks or idle)"; fi
out ""
if [ "$done_all" -eq 1 ]; then
  out "✅ Every task in the backlog is done."
else
  out "## Backlog (not-done)"
  for l in ${board[@]+"${board[@]}"}; do out "$l"; done
  out ""
  out "$ready task(s) ready to build now."
fi
out ""
out "## Needs you"
if [ "${#needs[@]}" -eq 0 ]; then
  out "  (nothing — all clear)"
else
  for n in ${needs[@]+"${needs[@]}"}; do out "  $n"; done
fi

echo
echo "   (saved to .harness/worklog/STATUS.md)"
exit 0
