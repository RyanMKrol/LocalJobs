#!/usr/bin/env bash
#
# consolidate-ideas.sh — Stage 3 of /local-jobs-convert-ideas: the ONE locked consolidation pass.
#
# Runs consolidate-ideas.mjs (id allocation, dependsOn resolution, tasks/TNNN.md spec files copied
# verbatim from each task's real markdown specFile, TASKS.json merge, IDEAS.md bullet removal) under
# the shared repo lock, then commits + pushes the result and cleans up the consumed
# .harness/.pending-tasks/*.json unit files AND the per-task *.md specFile scratch files they
# referenced. This is the ONLY step in the whole ideas->tasks flow that touches the repo lock or git —
# every per-idea agent in Stage 2 writes to its own pending files (a .json unit file + one real .md
# spec file per task) with zero shared-resource contention, so there's nothing to serialize until this
# single pass runs, once, after every launched unit has reported back.
#
# ⚠️ Run this via `bash .harness/scripts/consolidate-ideas.sh` (not `source` it, not run it under
# zsh) — repo-lock.sh derives its lock path from ${BASH_SOURCE[0]}, which only resolves correctly
# when the script is actually executed by bash.
#
# Usage:
#   .harness/scripts/consolidate-ideas.sh              # consolidate + commit + push
#   NO_PUSH=1 .harness/scripts/consolidate-ideas.sh     # consolidate + commit but don't push (offline)
#
# Safe to re-run: it only ever processes whatever .pending-tasks/*.json files still exist on disk
# (a straggler unit that reports back after a prior consolidation just gets picked up next run).
set -euo pipefail

# Anchor to THIS script's own location (self-relative — T327 normalized this off the old
# cwd-relative `source .harness/repo-lock.sh`, which broke the moment this script no longer lived
# directly at the repo-root-relative ".harness/" depth it assumed), then cd to the repo root so
# every ".harness/..." path below (tracking/TASKS.json, tasks/, .pending-tasks/) still resolves as before.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
cd "$ROOT"

source "$HERE/repo-lock.sh"
acquire_lock || exit 1
trap release_lock EXIT

# --- everything below runs while holding the lock ---

node "$HERE/consolidate-ideas.mjs"

SUMMARY=.harness/.pending-tasks/.consolidation-summary.json
if [ ! -f "$SUMMARY" ]; then
  echo "no pending files were consolidated — nothing to commit"
  exit 0
fi

jq empty .harness/tracking/TASKS.json

NEW_MD_FILES=$(jq -r '.allocatedTasks[].realId' "$SUMMARY" | sed 's#^#.harness/tasks/#; s#$#.md#')
git add .harness/tracking/TASKS.json
for f in $NEW_MD_FILES; do
  git add "$f"
done

echo "--- staged ---"
git status --short

if git diff --cached --quiet; then
  echo "no changes staged (already up to date) — cleaning up pending files anyway"
else
  MSG="$(jq -r '.suggestedCommitMessage' "$SUMMARY")"
  git commit -m "$MSG"

  if [ -z "${NO_PUSH:-}" ]; then
    if ! git push; then
      echo "push failed, attempting fetch+rebase+retry"
      git fetch origin
      git rebase origin/main
      git push
    fi
  else
    echo "NO_PUSH set — committed locally only"
  fi
fi

echo "--- cleaning up consumed pending files ---"
for f in $(jq -r '.pendingFilesConsumed[]' "$SUMMARY"); do
  rm -f ".harness/.pending-tasks/$f"
done
for f in $(jq -r '.specFilesConsumed[]?' "$SUMMARY"); do
  rm -f ".harness/.pending-tasks/$f"
done
rm -f "$SUMMARY"

release_lock
echo "--- DONE ---"
