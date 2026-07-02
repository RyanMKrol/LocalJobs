#!/usr/bin/env bash
# .harness/repo-lock.sh — shared mkdir-based repo lock, SOURCEABLE from a bash script.
#
# ⚠️ Lock path derivation MUST stay byte-identical to loop.sh's acquire_lock (GIT_COMMON/NAME/
# lock-dir-name) and src/core/repo-lock.ts's resolveRepoPaths — all three coordinate the SAME
# mutex so loop.sh, the daemon's reviews.json commits, and this script never write TASKS.json /
# push concurrently. If you change ROOT/GIT_COMMON/NAME/lock-dir-name here, change the other two
# in the same commit, and vice-versa. Unlike loop.sh (which exits if the lock is held — only one
# loop instance is ever wanted) this script WAITS/retries, since multiple idea-conversion shapers
# legitimately want to take turns.
#
# Usage — acquire and release MUST happen inside the SAME shell process / SAME Bash tool call as
# the critical section between them. The stale-holder reclaim is PID-liveness based: if you
# acquire in one Bash invocation and release in another, the acquiring process has already exited
# by the time anyone checks it, and the lock provides NO protection. Do the whole
# acquire → work → release sequence as ONE script:
#
#   source .harness/repo-lock.sh
#   acquire_lock || exit 1
#   trap release_lock EXIT          # always release, even on error/early exit
#   ...critical section: read/modify/write TASKS.json, tasks/*.md, IDEAS.md, git commit + push...
#   release_lock
#
# acquire_lock waits up to REPO_LOCK_MAX_WAIT_S (default 180s) before giving up.

_repo_lock_paths() {
  local self_dir root git_common
  # Anchor to THIS script's own location (like loop.sh anchors to HARNESS_DIR), not cwd — so the
  # derived lock path is correct regardless of where the caller `source`d this from.
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  root="$(git -C "$self_dir" rev-parse --show-toplevel)" || return 1
  git_common="$(git -C "$root" rev-parse --git-common-dir)" || return 1
  case "$git_common" in /*) ;; *) git_common="$root/$git_common" ;; esac
  LOCK="$git_common/$(basename "$root")-loop.lock"
}

acquire_lock() {
  _repo_lock_paths || return 1
  local max_wait="${REPO_LOCK_MAX_WAIT_S:-180}" waited=0
  while ! mkdir "$LOCK" 2>/dev/null; do
    local owner; owner="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      echo "repo-lock: stale lock (dead PID $owner) — reclaiming" >&2
      rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null || true
      continue
    fi
    if [ "$waited" -ge "$max_wait" ]; then
      echo "repo-lock: ERROR could not acquire $LOCK (held by PID ${owner:-?}) after ${max_wait}s" >&2
      return 1
    fi
    echo "repo-lock: waiting on lock (held by PID ${owner:-?})…" >&2
    sleep 2; waited=$((waited + 2))
  done
  echo "$$" >"$LOCK/pid"
  echo "repo-lock: acquired ($LOCK, pid $$)" >&2
}

release_lock() {
  [ -n "${LOCK:-}" ] && [ -f "$LOCK/pid" ] && [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] \
    && { rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null || true; echo "repo-lock: released ($LOCK)" >&2; } || true
}
