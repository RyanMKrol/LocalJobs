#!/usr/bin/env bash
# on-exhausted.sh — runs when the loop STOPS WITHOUT draining the backlog: it hit MAX_ITERS, or gave up
# after a long usage/rate-limit wait. (The complement to on-drained, which is the clean finish.)
#
#   $1                     "max-iters" or "rate-limit"
#   $HARNESS_ROOT / $HARNESS_DIR / $HARNESS_MAIN_BRANCH   harness context
#
# CONTRACT: child process, non-fatal, fires once when the loop bails out early. Does NOT fire on a clean
# drain/idle (that's on-drained), nor on a prerequisite/config error exit.
#
# Pushes an ntfy notification reusing this project's own LOCALJOBS_NTFY_TOPIC/LOCALJOBS_NTFY_SERVER
# (from .env — the same topic src/core/notifier.ts uses for job-run alerts), so an exhausted loop run
# shows up alongside ordinary job alerts instead of needing a separate channel.
set -uo pipefail

REASON="${1:-unknown}"

set -a
[ -f "$HARNESS_ROOT/.env" ] && source "$HARNESS_ROOT/.env"
set +a

if [ -z "${LOCALJOBS_NTFY_TOPIC:-}" ]; then
  echo "[on-exhausted] LOCALJOBS_NTFY_TOPIC not set in .env — skipping push. reason=$REASON"
  exit 0
fi

curl -fsS \
  -H "Title: local-jobs harness: loop stopped early ($REASON)" \
  -H "Priority: default" \
  -H "Tags: hourglass" \
  -d "The harness loop stopped before draining the backlog (reason: $REASON). It will resume on the next supervise.sh cycle." \
  "${LOCALJOBS_NTFY_SERVER:-https://ntfy.sh}/$LOCALJOBS_NTFY_TOPIC" \
  >/dev/null || echo "[on-exhausted] ntfy push failed (non-fatal)"

exit 0
