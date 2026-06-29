#!/usr/bin/env bash
#
# mark-failed.sh — manually mark a DONE task as FAILED (the owner's "this was not actually done"
# signal), or undo it. This is the PORTABLE interface to the manual-fail overlay
# (.harness/manual-fail.json): it works in ANY project that has this harness, with NO dashboard and
# NO daemon required. (Projects that DO have the dashboard get the same thing via a "Mark failed"
# button, which writes the same file.) See designs/manual-fail-signal.md for the why.
#
# What it does: writes/removes an entry in .harness/manual-fail.json, then commits + pushes it
# `[skip ci]` under the SAME repo lock the loop uses (so it never races the loop's git ops). The
# loop never writes this file; it only READS it to CORRECT calibration — a falsely-recorded success
# is re-counted as a failure for difficulty tuning AND dropped from its (layer×workType) cell's
# confirmed-audited count, so that category gets BUILT WITH A STRONGER MODEL and AUDITED MORE often
# going forward. It does NOT change the task's status or re-open it (the loop owns status); fix the
# work yourself or author a follow-up task.
#
# Usage:
#   .harness/mark-failed.sh <TNNN> "<reason>"     # mark T<NNN> failed, with a short reason
#   .harness/mark-failed.sh --undo <TNNN>         # clear a previous manual-fail
#   NO_PUSH=1 .harness/mark-failed.sh <TNNN> ...  # write+commit but don't push (offline)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Reuse the loop's lock + path vars (acquire_lock/release_lock, $ROOT, $MAIN_BRANCH, $BACKLOG,
# $MANUAL_FAIL, tj). LOOP_SOURCE_ONLY=1 returns from loop.sh BEFORE it runs the loop or takes the
# lock, so this is side-effect-free; the lock path therefore stays byte-identical to the loop's.
LOOP_SOURCE_ONLY=1 source "$HERE/loop.sh"

die() { echo "error: $*" >&2; exit 1; }

undo=0
if [ "${1:-}" = "--undo" ]; then undo=1; shift; fi
id="${1:-}"; shift || true
reason="${*:-}"

[ -n "$id" ] || die "usage: mark-failed.sh <TNNN> \"<reason>\"   |   mark-failed.sh --undo <TNNN>"
[[ "$id" =~ ^T[0-9]+$ ]] || die "task id must look like T123 (got '$id')"
tj -e --arg id "$id" '.tasks[]|select(.id==$id)' >/dev/null 2>&1 || die "$id is not a task in $BACKLOG"

if [ "$undo" = 0 ]; then
  status="$(tj -r --arg id "$id" '.tasks[]|select(.id==$id)|.status // "pending"')"
  [ "$status" = "done" ] || die "$id is '$status', not 'done' — manual-fail overturns a RECORDED SUCCESS, so it only applies to done tasks"
  [ -n "$reason" ] || die "a reason is required (what was actually wrong) — e.g. mark-failed.sh $id \"padlock never renders\""
fi

[ -f "$MANUAL_FAIL" ] || printf '{}\n' >"$MANUAL_FAIL"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
tmp="$MANUAL_FAIL.tmp"   # same-dir temp → mv is an atomic rename

if [ "$undo" = 1 ]; then
  jq --arg id "$id" 'del(.[$id])' "$MANUAL_FAIL" >"$tmp" && mv "$tmp" "$MANUAL_FAIL" || { rm -f "$tmp"; die "failed to update $MANUAL_FAIL"; }
  msg="manual-fail: clear $id [skip ci]"
  echo "cleared manual-fail for $id"
else
  jq --arg id "$id" --arg r "$reason" --arg at "$ts" \
     '.[$id] = {failed:true, reason:$r, at:$at}' "$MANUAL_FAIL" >"$tmp" && mv "$tmp" "$MANUAL_FAIL" || { rm -f "$tmp"; die "failed to update $MANUAL_FAIL"; }
  msg="manual-fail: $id [skip ci]"
  echo "marked $id failed: $reason"
fi

# Commit + push the overlay under the loop's lock so we never race its git operations.
rel="${MANUAL_FAIL#"$ROOT"/}"
acquire_lock
trap 'release_lock' EXIT INT TERM
git -C "$ROOT" add -- "$rel"
if git -C "$ROOT" diff --cached --quiet -- "$rel"; then
  echo "no change to commit (overlay already in that state)"; exit 0
fi
git -C "$ROOT" commit -q --no-gpg-sign -m "$msg" || die "commit failed"
if [ -n "${NO_PUSH:-}" ]; then echo "committed (NO_PUSH set — not pushed)"; exit 0; fi
ok=0
for _ in 1 2 3; do
  git -C "$ROOT" fetch origin >/dev/null 2>&1 || true
  git -C "$ROOT" rebase "origin/$MAIN_BRANCH" >/dev/null 2>&1 || git -C "$ROOT" rebase --abort >/dev/null 2>&1 || true
  if git -C "$ROOT" push origin "HEAD:$MAIN_BRANCH" >/dev/null 2>&1; then ok=1; break; fi
done
[ "$ok" = 1 ] && echo "committed + pushed to $MAIN_BRANCH" || echo "WARN: committed locally but push failed — push $MAIN_BRANCH manually"
