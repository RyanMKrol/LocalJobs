#!/usr/bin/env bash
# on-blocked.sh — runs when the loop BLOCKS a task (needs-human: an agent-reported blocker, an unmet
# prereq, or a tripped pre-push guard).
#
#   $1                     the blocked task id (e.g. T042)
#   $2                     the block reason (free text)
#   $HARNESS_ROOT / $HARNESS_DIR / $HARNESS_MAIN_BRANCH   harness context
#
# CONTRACT: child process, non-fatal (a nonzero exit is logged + ignored), fires once per block.
#
# Pushes an ntfy notification reusing this project's own LOCALJOBS_NTFY_TOPIC/LOCALJOBS_NTFY_SERVER
# (from .env — the same topic src/core/notifier.ts uses for job-run alerts), so a blocked harness task
# shows up alongside ordinary job alerts instead of needing a separate channel.
set -uo pipefail

TASK_ID="${1:-?}"
REASON="${2:-no reason given}"

set -a
[ -f "$HARNESS_ROOT/.env" ] && source "$HARNESS_ROOT/.env"
set +a

if [ -z "${LOCALJOBS_NTFY_TOPIC:-}" ]; then
  echo "[on-blocked] LOCALJOBS_NTFY_TOPIC not set in .env — skipping push. task=$TASK_ID reason=$REASON"
  exit 0
fi

curl -fsS \
  -H "Title: local-jobs harness: $TASK_ID blocked" \
  -H "Priority: high" \
  -H "Tags: warning" \
  -d "$REASON" \
  "${LOCALJOBS_NTFY_SERVER:-https://ntfy.sh}/$LOCALJOBS_NTFY_TOPIC" \
  >/dev/null || echo "[on-blocked] ntfy push failed (non-fatal)"

exit 0
