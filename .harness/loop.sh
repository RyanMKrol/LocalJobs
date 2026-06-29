#!/usr/bin/env bash
#
# loop.sh — single SEQUENTIAL "Ralph loop" that builds the .harness/TASKS.json backlog, ONE
# fully-verified task at a time, working DIRECTLY ON `main` in this checkout.
#
# This is the IN-PLACE variant of the Ralph harness (no git worktree, no per-task branches),
# living entirely under .harness/ to keep it separate from the project source. It was chosen
# because the real jobs (places/perfumes) + their data live UNTRACKED in this checkout, so an
# isolated worktree off origin/main couldn't see them; the safety model is git itself (every
# task is a commit on main, trivially reverted). See .harness/HARNESS.md for the full design.
#
# Each iteration:
#   SELECT (shell)  — from .harness/TASKS.json: the next not-done task whose dependsOn are all
#                     done and which is NOT a 🚦 gate / 🔒 needs-human / blocked task. None → stop.
#   WORK   (claude) — one `claude -p` (per-task model/effort) builds the task IN THIS CHECKOUT
#                     on main, runs the Definition of Done, and COMMITS (does NOT push).
#   GATE   (shell)  — pre-push guard (refuse if anything sensitive is staged) → push main →
#                     watch GitHub CI → green: mark the task done; red: STOP for a human.
#
# Usage:  .harness/loop.sh [TNNN]          # optional: force a specific task id this run
#         DRY_RUN=1 .harness/loop.sh       # print the task it WOULD build, then exit
# Config: .harness/harness.env (sourced if present) and/or the environment.
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$HARNESS_DIR" rev-parse --show-toplevel)"
GIT_COMMON="$(git -C "$ROOT" rev-parse --git-common-dir)"
case "$GIT_COMMON" in /*) ;; *) GIT_COMMON="$ROOT/$GIT_COMMON" ;; esac   # make absolute

[ -f "$HARNESS_DIR/harness.env" ] && . "$HARNESS_DIR/harness.env"

BACKLOG="$HARNESS_DIR/TASKS.json"
WORKLOG="$HARNESS_DIR/worklog"
OUTCOMES="$HARNESS_DIR/outcomes.jsonl"             # append-only escalation ledger — the SOLE input to difficulty calibration (forward-only); ONE terminal row per task
FAILURES="$HARNESS_DIR/failures.jsonl"             # append-only PER-ATTEMPT failure ledger — ONE row per failed attempt (kind+cause). Diagnostics only, NOT calibration; committed so causes are queryable across tasks
FAILBUF="$WORKLOG/.failures.buf"                   # gitignored scratch buffer for the current task's failures: survives cold_reset (git clean -fd keeps ignored files), flushed into FAILURES at each terminal event
MANUAL_FAIL="$HARNESS_DIR/manual-fail.json"        # owner-owned overlay (id → {failed,reason,at}); committed, dashboard/command-written, NEVER written by the loop. Read-only correction the calibration readers honor (designs/manual-fail-signal.md)
NAME="$(basename "$ROOT")"
MODEL="${MODEL:-claude-sonnet-4-6}"               # COLD-START FLOOR — cheapest tier; the policy tunes UP from here (pin the full id; the bare alias drifts)
EFFORT="${EFFORT:-low}"                            # low|medium|high|xhigh|max — cheapest by default (bias-cheap; the ladder escalates on failure)
MAX_ATTEMPTS="${MAX_ATTEMPTS:-2}"                  # soft failures per rung before escalating (2: with the 4-tier ladder this caps a doomed task at 4×2=8 attempts before it BLOCKS to a human)
MAX_ITERS="${MAX_ITERS:-100}"                      # global iteration backstop
WAIT_SECONDS="${WAIT_SECONDS:-30}"                 # backoff between retries / CI polls
CI_TIMEOUT="${CI_TIMEOUT:-1200}"                   # max seconds to wait for a CI run
CI_WORKFLOW="${CI_WORKFLOW:-CI}"                   # MUST match `name:` in the CI workflow yaml
REQUIRE_CI="${REQUIRE_CI:-1}"                      # 1 = never mark done without green CI
MAIN_BRANCH="${MAIN_BRANCH:-main}"
INTEGRATE_HOOK="${INTEGRATE_HOOK:-}"               # optional cmd run after each task integrates (deploy/restart)
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
CLAUDE_FLAGS="${CLAUDE_FLAGS:---dangerously-skip-permissions}"
# Rate-limit-aware backoff: when Claude hits the usage limit, sleep and resume the SAME task.
RL_BACKOFF_MIN="${RL_BACKOFF_MIN:-300}"            # first backoff (5 min)
RL_BACKOFF_MAX="${RL_BACKOFF_MAX:-18000}"          # cap (~5h = the quota window)
RL_BUFFER="${RL_BUFFER:-120}"                      # extra wait after a parsed reset
FORCE_TASK="${1:-}"
POSTFLIGHT="$HARNESS_DIR/postflight.sh"

read -r -a FLAGS <<<"$CLAUDE_FLAGS"
log() { printf '[loop] %s\n' "$*" >&2; }
board() { [ -x "$POSTFLIGHT" ] && "$POSTFLIGHT" >/dev/null 2>&1 || true; }

command -v jq >/dev/null 2>&1 || { log "jq is required to parse TASKS.json — install it (brew install jq)"; exit 3; }
[ -f "$BACKLOG" ] || { log "no .harness/TASKS.json — nothing to build"; exit 3; }

# Paths that must NEVER be pushed (data, secrets, browser profiles). TASKS.json + worklog ARE
# committed intentionally, so they are NOT blocked here.
SENSITIVE_RE='(^|/)data/|(^|/)\.env($|\.)|chrome-profile|\.pem$|\.key$|\.p12$|service-account|credentials\.json'

# --- Concurrency guard: only one loop at a time (exit, don't queue) ----------
# ⚠️ The lock path below ($GIT_COMMON/${NAME}-loop.lock + a `pid` file + stale-pid
# reclaim) MUST stay byte-identical to src/core/repo-lock.ts, which the daemon uses
# to serialize its `.harness/reviews.json` commit+push against this loop (T136). If
# you change the derivation here (GIT_COMMON / NAME / lock name / pid protocol),
# change repo-lock.ts in the same commit, and vice-versa.
acquire_lock() {
  LOCK="$GIT_COMMON/${NAME}-loop.lock"
  while ! mkdir "$LOCK" 2>/dev/null; do
    local owner; owner="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      log "stale loop lock (dead PID $owner) — reclaiming"; rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null || true
    else
      log "another loop is already running (PID ${owner:-?}) — exiting."; exit 0
    fi
  done
  echo "$$" >"$LOCK/pid"
}
release_lock() {
  [ -n "${LOCK:-}" ] && [ -f "$LOCK/pid" ] && [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] \
    && { rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null || true; } || true
}

# --- TASKS.json helpers (read from the local backlog file) ------------------
tj()           { jq "$@" "$BACKLOG" 2>/dev/null; }
all_tasks()    { tj -r '.tasks[].id'; }
task_done()    { tj -e --arg id "$1" '.tasks[]|select(.id==$id)|.status=="done"' >/dev/null; }
deps_for()     { tj -r --arg id "$1" '.tasks[]|select(.id==$id)|.dependsOn[]?' | tr '\n' ' '; }
task_gated()   { tj -e --arg id "$1" '.tasks[]|select(.id==$id)|.gate!=null' >/dev/null; }
task_blocked() { [ -f "$WORKLOG/$1.md" ] && grep -qiE 'failed:blocked|needs-human' "$WORKLOG/$1.md"; }
# A task's do/doneWhen live in a per-task Markdown spec (T131), referenced by the
# JSON `spec` field (path relative to the repo root, e.g. .harness/tasks/T001.md).
task_spec_rel() { tj -r --arg id "$1" '.tasks[]|select(.id==$id)|.spec // empty'; }

# manual_fail_ids — the JSON array of task ids the OWNER manually marked FAILED via the
# .harness/manual-fail.json overlay (designs/manual-fail-signal.md). The loop NEVER writes this file
# (it's owner-owned, like reviews.json/human-done.json); it only READS it to CORRECT calibration: a
# falsely-recorded success is re-counted as a failure for tier selection AND dropped from a cell's
# confirmed-audited count so auditing of that cell rises again. Robust: missing/garbled file → [].
manual_fail_ids() {
  [ -f "$MANUAL_FAIL" ] || { echo '[]'; return; }
  jq -c '[to_entries[] | select(.value.failed == true) | .key]' "$MANUAL_FAIL" 2>/dev/null || echo '[]'
}

# record_outcome <id> <blocked:true|false> [reason] — append ONE escalation-outcome row to the
# ledger (the sole input to difficulty calibration). FORWARD-ONLY: only fires for tasks the loop
# actually builds, so gated/needs-human tasks (never selected) are excluded by construction.
# cur_rung/cur_attempts are the live success (or top) rung at call time; each escalation = exactly
# MAX_ATTEMPTS soft failures, so totalSoftFails is derivable. Best-effort — never fails the caller.
record_outcome() {
  local id="$1" blocked="$2" reason="${3:-}" line ts sm se fm fe
  local total=$(( cur_rung * MAX_ATTEMPTS + cur_attempts ))
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  read -r sm se <<<"$(rung_at "$id" 0)"             # authored start rung (the prior)
  read -r fm fe <<<"$(rung_at "$id" "$cur_rung")"   # final rung actually used
  line="$(tj --arg id "$id" --argjson blocked "$blocked" --arg reason "$reason" \
      --argjson rung "$cur_rung" --argjson atr "$cur_attempts" --argjson total "$total" \
      --arg sm "$sm" --arg se "$se" --arg fm "$fm" --arg fe "$fe" --arg ts "$ts" \
      --arg verif "${cur_verification:-ci-only}" \
      -c '.tasks[]|select(.id==$id)|{
        id:$id, ts:$ts, facets:(.facets // null), scopeSize:(.scope|length),
        startModel:$sm, startEffort:$se, finalModel:$fm, finalEffort:$fe,
        succeededRung:(if $blocked then null else $rung end), topRung:$rung,
        attemptsAtRung:$atr, totalSoftFails:$total, blocked:$blocked, reason:$reason,
        verification:$verif
      }')"
  if [ -n "$line" ]; then printf '%s\n' "$line" >>"$OUTCOMES"; else log "WARN: couldn't record outcome for $id"; fi
}

# record_failure <id> <kind> [detail] — append ONE per-attempt failure row to the gitignored buffer
# (FAILBUF). Unlike record_outcome (one terminal row per task), this captures the CAUSE of EVERY
# failed attempt along the way — scope-creep / audit-fail / ci-red / … — so you can see the full
# escalation history, not just where a task ended up. The buffer is gitignored so it survives the
# cold_reset between attempts; flush_failures folds it into the committed FAILURES ledger at a
# terminal event (mark_done / block_task). Best-effort — never fails the caller. kinds:
#   scope-creep | empty-diff | test-missing | local-dod | audit-fail | push-fail | ci-red |
#   agent-soft | agent-blocked | guard
record_failure() {
  local id="$1" kind="$2" detail="${3:-}" line ts m e
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  read -r m e <<<"$(rung_at "$id" "$cur_rung")"
  line="$(tj --arg id "$id" --arg ts "$ts" --arg kind "$kind" --arg detail "$detail" \
      --argjson rung "$cur_rung" --argjson attempt "$cur_attempts" --arg m "$m" --arg e "$e" \
      -c '.tasks[]|select(.id==$id)|{
        id:$id, ts:$ts, kind:$kind, rung:$rung, attempt:$attempt,
        model:$m, effort:$e, facets:(.facets // null), detail:$detail
      }' 2>/dev/null)"
  if [ -n "$line" ]; then printf '%s\n' "$line" >>"$FAILBUF"; else log "WARN: couldn't record failure for $id"; fi
}

# flush_failures — fold the current task's buffered per-attempt failures into the committed FAILURES
# ledger, then clear the buffer. Called at every terminal event so the buffer never spans tasks.
flush_failures() {
  [ -s "$FAILBUF" ] || return 0
  cat "$FAILBUF" >>"$FAILURES" && : >"$FAILBUF"
}

# Shell owns task status: set it done, then commit+push the one-line change (no CI needed).
mark_done() {
  local id="$1" tmp="$BACKLOG.tmp"   # same-dir temp → mv is an atomic rename (no cross-fs partial reads)
  jq --arg id "$id" '(.tasks[]|select(.id==$id)|.status)="done"' "$BACKLOG" >"$tmp" \
    && mv "$tmp" "$BACKLOG" || { rm -f "$tmp"; log "WARN: failed to mark $id done"; return 1; }
  record_outcome "$id" false                        # success → ledger row (succeededRung=cur_rung)
  flush_failures                                     # fold any soft-failures-along-the-way into the committed FAILURES ledger
  # Stage the always-present files FIRST, then FAILURES only if it exists. (A single `git add … $FAILURES`
  # would fail ATOMICALLY when failures.jsonl is absent — the common case — staging NOTHING, so the
  # commit silently no-ops and the status=done never persists → orphaned task. Do NOT recombine these.)
  git -C "$ROOT" add "$BACKLOG" "$WORKLOG" "$OUTCOMES" 2>/dev/null || true
  if [ -f "$FAILURES" ]; then git -C "$ROOT" add "$FAILURES" 2>/dev/null || true; fi
  git -C "$ROOT" commit -q -m "$id: mark done [skip ci]" 2>/dev/null || true
  git -C "$ROOT" push origin "HEAD:$MAIN_BRANCH" 2>/dev/null || log "WARN: couldn't push status update for $id"
}

# Optional post-integration hook (deploy/restart so the running product matches main).
run_integrate_hook() {
  [ -n "$INTEGRATE_HOOK" ] || return 0
  log "integrate hook: $INTEGRATE_HOOK"
  ( cd "$ROOT" && eval "$INTEGRATE_HOOK" ) || log "WARN: integrate hook failed (non-fatal)"
}

# --- Difficulty auto-tuning: global tier ladder + the calibration policy --------------------------
# The loop rides ONE global difficulty ladder (facets.json .tiers.ladder, cheapest→priciest) offset
# by a policy-chosen START tier (cur_base). rung 0 = the policy's start tier; escalation walks UP the
# global ladder. Tasks no longer carry per-task model/effort/escalation — the cold-start prior is the
# global floor (sonnet/low) until the (layer × work-type) cell has enough ledger samples.
FACETS="$HARNESS_DIR/facets.json"
TIER_TUPLES=()   # portable (bash 3.2 — no mapfile): read the ladder into an array
while IFS= read -r _t; do TIER_TUPLES+=("$_t"); done \
  < <(jq -r '.tiers.ladder[] | "\(.model) \(.effort)"' "$FACETS" 2>/dev/null)
[ "${#TIER_TUPLES[@]}" -gt 0 ] || TIER_TUPLES=("$MODEL $EFFORT")     # fallback if facets.json absent
POLICY_FLOOR="$(jq -r '.policy.floor // 0.75' "$FACETS" 2>/dev/null || echo 0.75)"
POLICY_MINN="$(jq -r '.policy.minN // 6' "$FACETS" 2>/dev/null || echo 6)"
POLICY_JQ="$HARNESS_DIR/policy.jq"               # .harness/policy.jq, alongside this loop
# Verification-aware calibration knobs (the blocking audit gate — designs/audit-verification.md §4.6).
AUDIT_START_N="$(jq -r '.policy.auditStartN // 3' "$FACETS" 2>/dev/null || echo 3)"
AUDIT_FLOOR_N="$(jq -r '.policy.auditFloorN // 8' "$FACETS" 2>/dev/null || echo 8)"
AUDIT_FLOOR_PM="$(jq -r '((.policy.auditFloor // 0.10) * 1000) | round' "$FACETS" 2>/dev/null || echo 100)"
AUDITOR_MODEL="$(jq -r '.policy.auditorModel // "claude-opus-4-8"' "$FACETS" 2>/dev/null || echo claude-opus-4-8)"
AUDITOR_EFFORT="$(jq -r '.policy.auditorEffort // "medium"' "$FACETS" 2>/dev/null || echo medium)"
# Optional in-place "local DoD" gate the loop runs before the audit (the cheap CI-proxy). Empty =
# skip (CI still gates). Set in harness.env, e.g. LOCAL_DOD="npx tsc --noEmit && npm test".
LOCAL_DOD="${LOCAL_DOD:-}"

# gtier <idx> — echo "model effort" for the ladder tier at idx, clamped to [0, top].
gtier() {
  local idx="$1" last=$(( ${#TIER_TUPLES[@]} - 1 ))
  (( idx < 0 )) && idx=0; (( idx > last )) && idx=$last
  printf '%s' "${TIER_TUPLES[$idx]}"
}

# pick_base <id> — the policy's chosen START tier INDEX: the cheapest ladder tier whose
# (layer × work-type) cell historically clears the floor with >= minN samples; else the authored
# difficulty (cold-start prior). Robust: missing facets / empty ledger / any error → the prior.
pick_base() {
  local id="$1" layer wt am ae cold tiers
  am="$(tj -r --arg id "$id" '.tasks[]|select(.id==$id)|.model // empty')"; am="${am:-$MODEL}"
  ae="$(tj -r --arg id "$id" '.tasks[]|select(.id==$id)|.effort // empty')"; ae="${ae:-$EFFORT}"
  tiers="$(jq -c '.tiers.ladder' "$FACETS" 2>/dev/null)"
  cold="$(jq -n --argjson t "${tiers:-[]}" --arg m "$am" --arg e "$ae" '($t|map(.model==$m and .effort==$e)|index(true)) // 1' 2>/dev/null)"; cold="${cold:-0}"
  layer="$(tj -r --arg id "$id" '.tasks[]|select(.id==$id)|.facets.layer // empty')"
  wt="$(tj -r --arg id "$id" '.tasks[]|select(.id==$id)|.facets.workType // empty')"
  if [ -z "$layer" ] || [ -z "$wt" ] || [ ! -s "$OUTCOMES" ] || [ -z "$tiers" ] || [ ! -f "$POLICY_JQ" ]; then printf '%s' "$cold"; return; fi
  jq -n -f "$POLICY_JQ" --slurpfile rows "$OUTCOMES" --argjson tiers "$tiers" \
     --arg layer "$layer" --arg wt "$wt" --argjson floor "$POLICY_FLOOR" --argjson minN "$POLICY_MINN" \
     --argjson coldIdx "$cold" --argjson failedIds "$(manual_fail_ids)" \
     --argjson auditCount -1 --argjson auditStartN "$AUDIT_START_N" --argjson auditFloorN "$AUDIT_FLOOR_N" --argjson auditFloorPM "$AUDIT_FLOOR_PM" \
     2>/dev/null || printf '%s' "$cold"
}

# Rung machinery, now on the global ladder offset by cur_base (the policy's per-task start tier).
ladder_len() { echo $(( ${#TIER_TUPLES[@]} - cur_base )); }
rung_at()    { gtier $(( cur_base + ${2:-0} )); }

# tier_strength <model> <effort> — a total strength order over ANY (model, effort) pair, independent
# of the ladder: model dominates (opus > sonnet), then effort (low<medium<high<xhigh<max). Lets us
# compare the AUDITOR's configured tier against the builder's tier even when the auditor tier (e.g.
# opus/medium) isn't on the builder ladder.
tier_strength() {
  local m="$1" e="$2" mr er
  case "$m" in *opus*) mr=1 ;; *) mr=0 ;; esac
  case "$e" in low) er=0 ;; medium) er=1 ;; high) er=2 ;; xhigh) er=3 ;; max) er=4 ;; *) er=0 ;; esac
  echo $(( mr * 10 + er ))
}

# SELECT — echo the next eligible task id; return 1 if nothing is eligible.
select_task() {
  local t d ok
  if [ -n "$FORCE_TASK" ]; then
    # SAFETY: a forced id MUST be a real task in TASKS.json. Echoing a bogus id (typo, a stray flag
    # like --guard-selftest, an empty-ish value) would hand it to the builder and trigger a
    # destructive cold_reset build of a non-task. Refuse instead.
    if ! tj -e --arg id "$FORCE_TASK" '.tasks[]|select(.id==$id)' >/dev/null 2>&1; then
      log "FORCE_TASK '$FORCE_TASK' is not a real task id in TASKS.json — refusing to build it."
      return 1
    fi
    echo "$FORCE_TASK"; return 0
  fi
  for t in $(all_tasks); do
    task_done "$t" && continue
    task_gated "$t" && continue
    task_blocked "$t" && continue
    ok=1; for d in $(deps_for "$t"); do task_done "$d" || { ok=0; break; }; done
    [ "$ok" = 1 ] && { echo "$t"; return 0; }
  done
  return 1
}

# --- Pre-push guard: refuse to push if anything sensitive is in the new commits ----
guard_clean() {
  local bad
  # .env.example is a tracked, placeholder-only template (intentionally committable) — never the real secret env.
  bad="$(git -C "$ROOT" diff --name-only "origin/$MAIN_BRANCH..HEAD" 2>/dev/null | grep -nE "$SENSITIVE_RE" | grep -vE '(^|[/:])\.env\.example$' || true)"
  [ -z "$bad" ] && return 0
  log "PRE-PUSH GUARD TRIPPED — refusing to push. Sensitive paths in pending commits:"
  printf '   %s\n' $bad >&2
  return 1
}

# --- GitHub CI gate (watches the workflow run for the current main HEAD) -----
wait_ci_green() {   # 0=green 1=red 2=indeterminate
  local sha runid="" waited=0
  command -v gh >/dev/null 2>&1 || { log "gh not installed — cannot gate CI"; return 2; }
  sha="$(git -C "$ROOT" rev-parse HEAD)"
  log "waiting for CI ($CI_WORKFLOW) on ${sha}…"
  while [ "$waited" -lt "$CI_TIMEOUT" ]; do
    runid="$(gh run list --limit 20 --json databaseId,headSha,workflowName \
               --jq ".[] | select(.headSha==\"$sha\" and .workflowName==\"$CI_WORKFLOW\") | .databaseId" \
               2>/dev/null | head -1 || true)"
    [ -n "$runid" ] && break
    sleep "$WAIT_SECONDS"; waited=$((waited + WAIT_SECONDS))
  done
  [ -n "$runid" ] || { log "no '$CI_WORKFLOW' run appeared for $sha within ${CI_TIMEOUT}s"; return 2; }
  if gh run watch "$runid" --exit-status >/dev/null 2>&1; then log "CI GREEN (run $runid)"; return 0; fi
  log "CI RED (run $runid) — gh run view $runid --log-failed"; return 1
}

# --- Claude invocation with rate-limit detection ----------------------------
RL_RE='usage limit|rate.?limit|429|resets at|try again later|overloaded|quota|insufficient.*credit|exceeded your'
# run_claude <model> <effort> <prompt> → 0 ok | 10 rate-limited | other = failure
run_claude() {
  local model="$1" effort="$2" pr="$3" out="$WORKLOG/.claude-out" rc
  set +e
  ( cd "$ROOT" && "$CLAUDE_BIN" -p "$pr" --model "$model" --effort "$effort" "${FLAGS[@]}" ) 2>&1 | tee "$out"
  rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" -ne 0 ] && grep -qiE "$RL_RE" "$out"; then return 10; fi
  return "$rc"
}

# --- Per-task build prompt --------------------------------------------------
prompt() {
  local tid="$1"
  printf 'You are the autonomous builder for THIS repo (local-jobs). Build EXACTLY ONE task: %s, then stop.\n' "$tid"
  cat <<'EOF'
You work DIRECTLY on the `main` branch in the primary checkout — NO worktree, NO new branches.
Do NOT create/switch branches. Do NOT push. Do NOT merge. The loop pushes + gates on CI after you finish.
You run head-less and unattended. Obey CLAUDE.md and .harness/HARNESS.md exactly.

1. ORIENT. Read CLAUDE.md and README.md (current state). Find this task:
   `jq '.tasks[]|select(.id=="<TASK>")' .harness/TASKS.json` (read its scope/verify and all other
   orchestration fields). The task's `do` + `done-when` live in the Markdown spec at the JSON `spec`
   path (.harness/tasks/<TASK>.md, sections '## Do' / '## Done when') — its FULL TEXT is also
   appended at the end of this prompt. You are starting COLD on a CLEAN tree: do NOT look for or rely
   on any prior-attempt state (worklog, partial work) — build this task FRESH from the spec alone.
   Stay within the task's `scope` — the exact allowed-files list + the HARD-GATE rule are shown under
   "SCOPE" at the end of this prompt. Read it before you change anything.

2. DEFINITION OF DONE — all must hold before you report `done`:
   a. Run the FULL local suite (it MIRRORS CI), all must pass:
        npx tsc --noEmit
        npm test
      and for any dashboard/ change also:  npm --prefix dashboard run build
      Add unit tests for new behaviour (tests are *.test.ts, discovered by `npm test`).
   b. NEVER make live PAID-API calls (Google Places, Gemini) in verification — that spends the
      monthly cap. Use EXISTING fetched data under each job's data/ folder, or synthetic fixtures,
      plus the scratch DB. If a check genuinely requires a paid call, stop and record failed:blocked.
   c. If the task's `verify` field names empirical checks, run them and record what you OBSERVED in
      .harness/worklog/<TASK>.md.

3. SECRETS / PRIVACY — NON-NEGOTIABLE. NEVER `git add` anything under any `data/` folder, a
   `chrome-profile/`, `.env*`, or any credential file. NEVER edit .gitignore to un-ignore data.
   To PUBLISH job code, remove ONLY the relevant code-folder ignore line from .gitignore and
   `git add` the .ts files EXPLICITLY (never `git add -A` / `git add .`). The loop's pre-push guard
   HALTS the whole run if any sensitive path is staged — so stage precisely.

4. DOCS IN LOCKSTEP (same commit) — but ONLY docs that are in your SCOPE. If a convention/feature
   change needs README.md / CLAUDE.md / .harness/LIMITATIONS.md AND that file is in your scope, update
   it. If a needed doc is NOT in your scope, do NOT edit it (that trips the scope gate) — record
   `failed:blocked` noting the missing doc so a human can add it to scope. Do NOT edit
   .harness/TASKS.json — the loop owns task status. Write your notes to .harness/worklog/<TASK>.md
   (always allowed).

5. COMMIT (do NOT push) with message `<TASK>: <summary>`, staging your intended files explicitly.
   Your commit MUST include .harness/worklog/<TASK>.md (stage it alongside your code) — a task is
   not complete if its worklog isn't committed.

6. As your FINAL action, OVERWRITE .harness/worklog/.result with exactly ONE line:
     done <TASK>                     # built + committed (NOT pushed) — loop pushes + gates CI
     failed:soft <TASK> <reason>     # transient / partial — retry is worthwhile
     failed:blocked <TASK> <reason>  # needs-human / unmet prereq — do NOT retry
     waiting <TASK> <unmet-deps>     # a dependency is not done yet
     idle                            # nothing to do
EOF
  # Inject the task's `scope` as an explicit HARD boundary. structural_checks fails the build if the
  # diff touches anything outside it (except test files + the worklog), so the builder must know it.
  local sc
  sc="$(tj -r --arg id "$tid" '.tasks[]|select(.id==$id)|.scope[]?' 2>/dev/null)"
  printf '\n--- SCOPE — HARD GATE (a script checks your diff against this; staying inside it is mandatory) ---\n'
  printf 'You may change ONLY these files:\n'
  if [ -n "$sc" ]; then printf '%s\n' "$sc" | sed 's/^/  - /'; else printf '  (none declared — keep the diff minimal)\n'; fi
  printf '%s\n' 'PLUS you may always add/change TEST files (*.test.ts) and your own .harness/worklog/<TASK>.md. Touching ANY OTHER file — including a doc (README/CLAUDE/LIMITATIONS) not listed above — AUTO-FAILS this task. If you genuinely need a file that is not listed, do NOT edit it: record `failed:blocked <TASK> needs <file> (out of scope)` so a human can fix the scope.'
  # Visual confirmation block — UI tasks only (facets.layer == ui). Structural checks can't see
  # whether something actually RENDERS (T223 shipped a padlock present in the DOM but invisible, and
  # passed every check). So a UI builder must look at the rendered pages with its own eyes.
  if [ "$(tj -r --arg id "$tid" '.tasks[]|select(.id==$id)|.facets.layer // empty')" = "ui" ]; then
    cat <<'EOF'

--- VISUAL CONFIRMATION — MANDATORY FOR UI TASKS (facets.layer == ui) ---
This task changes the dashboard's rendered surface. Passing tsc/tests/build is NOT enough — an
element can satisfy every structural check yet never be painted (the T223 padlock bug). You MUST:
  1. Build the dashboard, then capture screenshots:
        npm --prefix dashboard run build && node dashboard/scripts/visual-check.mjs
  2. READ the PNGs it writes to dashboard/scripts/visual-out/ (the script prints their paths) and
     confirm WITH YOUR OWN EYES that what you changed renders correctly — the thing you added is
     actually painted/visible, nothing is blank, overlapping, or clipped. Record what you observed
     in .harness/worklog/<TASK>.md.
  3. LIVING ARTIFACT (non-negotiable): if you ADDED a page, ADDED/REMOVED a workflow or gate, or
     otherwise changed the UI surface, you MUST update dashboard/scripts/_dashboard-harness.mjs in
     THIS SAME commit — its PAGES list and/or fixtures — so the check stays accurate and does not
     start failing on intentionally-removed UI. The visual-check/harness/mobile-check scripts are
     ALWAYS in-scope for a UI task; editing them never trips the scope gate.
EOF
  fi
  # Append the task's Markdown spec (## Do / ## Done when) verbatim — this is the
  # SOLE source of do/doneWhen since T131 (they no longer live in TASKS.json).
  local rel="" path
  rel="$(task_spec_rel "$tid")"
  if [ -n "$rel" ]; then
    path="$ROOT/$rel"
    if [ -f "$path" ]; then
      printf '\n\n--- Task %s spec (%s) ---\n' "$tid" "$rel"
      cat "$path"
    else
      printf '\n\n(WARNING: spec file %s referenced by %s is missing — read the task via jq.)\n' "$rel" "$tid"
    fi
  fi
}

# --- Verification-aware Definition of Done (designs/audit-verification.md) -------------------------
# cold_reset — discard ALL local state so every build attempt is an INDEPENDENT cold measurement (no
# worklog carryover, no partial-work resume). gitignored data/ is preserved (clean without -x).
cold_reset() {
  git -C "$ROOT" reset --hard "origin/$MAIN_BRANCH" >/dev/null 2>&1 || true
  git -C "$ROOT" clean -fd >/dev/null 2>&1 || true
}

# structural_checks <id> — cheap, model-agnostic gate on the build commit, BEFORE the audit. Any
# fail = a failed attempt. 0 = pass, 1 = fail.
structural_checks() {
  local id="$1" changed want_test scope creep f s d inscope
  STRUCT_FAIL_KIND=""; STRUCT_FAIL_DETAIL=""        # set on failure so the caller can label the failures.jsonl row
  changed="$(git -C "$ROOT" diff --name-only "origin/$MAIN_BRANCH..HEAD" 2>/dev/null)"
  if [ -z "$changed" ]; then STRUCT_FAIL_KIND="empty-diff"; log "structural: $id produced an EMPTY diff — fail"; return 1; fi
  # Scope-creep gate: every changed file must be WITHIN the task's declared `scope` (exact path or
  # under a scope directory) — except the always-allowed worklog + test files. The strong planner's
  # `scope` is a binding contract; any other file the cheap builder touched is a failed attempt.
  scope="$(tj -r --arg id "$id" '.tasks[]|select(.id==$id)|.scope[]?' 2>/dev/null)"
  creep=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in .harness/worklog/*) continue ;; esac
    # Lockfiles are a MECHANICAL artifact of a dependency change, never "the work" and never dangerous:
    # a real dep change still requires editing package.json (which IS scope-checked), so its sibling
    # lockfile is auto-allowed (like test files + the worklog). This stops the common scope-creep where
    # a task lists package.json but `npm install` also rewrites package-lock.json (the T220 failure).
    case "$f" in */package-lock.json|package-lock.json|*/yarn.lock|yarn.lock|*/pnpm-lock.yaml|pnpm-lock.yaml) continue ;; esac
    # The dashboard visual-validation harness is a MECHANICAL artifact of a UI change (like a
    # lockfile): a UI task that adds a page / workflow / gate MUST keep the shared PAGES + fixtures
    # current, so these files are always-allowed and never trip scope-creep (see the LIVING ARTIFACT
    # rule in CLAUDE.md). Keeping them out of scope would punish a task for doing the right thing.
    case "$f" in dashboard/scripts/_dashboard-harness.mjs|dashboard/scripts/visual-check.mjs|dashboard/scripts/mobile-check.mjs) continue ;; esac
    if printf '%s\n' "$f" | grep -qiE '(\.test\.|\.spec\.|_test\.|(^|/)test_|(^|/)tests?/)'; then continue; fi
    inscope=0
    while IFS= read -r s; do
      [ -z "$s" ] && continue
      # A scope entry matches as: an EXACT path, OR a directory prefix. A trailing glob (`/**`, `/*`)
      # or slash is stripped to the bare directory so a file ANYWHERE under it counts — this is the
      # rigour dial: scope a whole area as `src/jobs/foo/**` (proactive in-area files like a new util
      # are fine) or pin exact files for surgical/shared changes (tight). Brackets in Next.js paths
      # (`[name]`) are literal here ([ = ] string compare + quoted ${f#"$d"/}), never glob classes.
      d="${s%/}"; d="${d%/\*\*}"; d="${d%/\*}"
      if [ "$f" = "$s" ] || [ "$f" = "$d" ] || [ "${f#"$d"/}" != "$f" ]; then inscope=1; break; fi
    done <<SCOPE
$scope
SCOPE
    [ "$inscope" = 1 ] || creep="$creep $f"
  done <<CHANGED
$changed
CHANGED
  if [ -n "$creep" ]; then STRUCT_FAIL_KIND="scope-creep"; STRUCT_FAIL_DETAIL="${creep# }"; log "structural: $id changed files OUTSIDE scope (scope creep):$creep — fail"; return 1; fi
  want_test="$(tj -r --arg id "$id" '.tasks[]|select(.id==$id)|.expectsTest // false')"
  if [ "$want_test" = "true" ] && ! printf '%s\n' "$changed" | grep -qiE '(\.test\.|\.spec\.|_test\.|(^|/)test_|(^|/)tests?/)'; then
    STRUCT_FAIL_KIND="test-missing"; log "structural: $id has expectsTest=true but no test file changed — fail"; return 1
  fi
  if [ -n "$LOCAL_DOD" ]; then
    log "structural: running LOCAL_DOD → $LOCAL_DOD"
    if ! ( cd "$ROOT" && eval "$LOCAL_DOD" ) >/dev/null 2>&1; then STRUCT_FAIL_KIND="local-dod"; STRUCT_FAIL_DETAIL="$LOCAL_DOD"; log "structural: LOCAL_DOD failed for $id — fail"; return 1; fi
  fi
  return 0
}

# audit_prompt <id> <spec> <diff> [visual] — the independent auditor's prompt (strict PASS/FAIL on
# ## Done when). The optional <visual> block (UI tasks only) instructs the auditor to LOOK at the
# rendered pages, since a text diff can't reveal whether a UI element actually paints.
audit_prompt() {
  local id="$1" spec="$2" diff="$3" visual="${4:-}"
  cat <<EOF
You are an INDEPENDENT AUDITOR. You did NOT write this code and you carry NO prior context. Another
agent implemented task $id; your ONLY job is to judge whether the implementation genuinely satisfies
the task's "## Done when" criteria below.

Respond with EXACTLY one word on the FIRST LINE: PASS or FAIL. Then, on following lines, give concise
reasons. PASS only if the diff meets EVERY "## Done when" item for real. FAIL if any item is unmet,
faked, stubbed, or only superficially addressed. Be strict — do not give the benefit of the doubt.

--- TASK $id SPEC ---
$spec

--- IMPLEMENTATION DIFF (origin/$MAIN_BRANCH..HEAD) ---
$diff
$visual
EOF
}

# audit_gate <id> — per-cell SAMPLED blocking audit (§4.3/4.6). Sets cur_verification. Spawns a fresh,
# independent auditor at max(opus-medium, builder tier) ONLY if sampled. 0 = pass (or not sampled),
# 1 = audit FAIL (a failed attempt).
audit_gate() {
  local id="$1" layer wt count pm bi ai am ae rel spec="" diff out verdict arc rlpoll
  cur_verification="ci-only"
  layer="$(tj -r --arg id "$id" '.tasks[]|select(.id==$id)|.facets.layer // empty')"
  wt="$(tj -r --arg id "$id" '.tasks[]|select(.id==$id)|.facets.workType // empty')"
  if [ -n "$layer" ] && [ -n "$wt" ] && [ -s "$OUTCOMES" ]; then
    # Confirmed-audited successes for this cell — but EXCLUDE any task the owner manually marked failed
    # (designs/manual-fail-signal.md): a false success must stop suppressing this cell's audit rate, so
    # dropping it from the count pushes the sampling probability back UP toward 100%.
    count="$(jq -s --arg l "$layer" --arg w "$wt" --argjson failed "$(manual_fail_ids)" '[.[]|select(.facets!=null and .facets.layer==$l and .facets.workType==$w and .blocked==false and .verification=="audited" and ((.id as $i|$failed|index($i))==null))]|length' "$OUTCOMES" 2>/dev/null || echo 0)"
  else count=0; fi
  count="${count:-0}"
  pm="$(jq -n -f "$POLICY_JQ" --argjson auditCount "$count" \
        --argjson auditStartN "$AUDIT_START_N" --argjson auditFloorN "$AUDIT_FLOOR_N" --argjson auditFloorPM "$AUDIT_FLOOR_PM" \
        --argjson rows '[]' --argjson tiers '[]' --arg layer '' --arg wt '' --argjson floor 0 --argjson minN 0 --argjson coldIdx 0 --argjson failedIds '[]' 2>/dev/null || echo 1000)"
  pm="${pm:-1000}"
  if [ "$(( RANDOM % 1000 ))" -ge "$pm" ]; then
    log "audit: $id cell (${layer:-?}×${wt:-?}) $count confirmed, p=${pm}per-mille → NOT sampled (ci-only)"; return 0
  fi
  # The auditor runs at its CONFIGURED tier (AUDITOR_MODEL/EFFORT — e.g. opus/medium, which need NOT
  # exist on the builder ladder), bumped UP to the builder's tier ONLY when the builder was stronger.
  # So most (sonnet-built) tasks audit at opus/medium; only an opus/high-built task bumps to opus/high.
  read -r bm be <<<"$(gtier $(( cur_base + cur_rung )))"   # the builder's tier
  if (( $(tier_strength "$bm" "$be") > $(tier_strength "$AUDITOR_MODEL" "$AUDITOR_EFFORT") )); then
    am="$bm"; ae="$be"
  else
    am="$AUDITOR_MODEL"; ae="$AUDITOR_EFFORT"
  fi
  log "audit: $id cell (${layer:-?}×${wt:-?}) $count confirmed, p=${pm}per-mille → AUDITING at $am/$ae (auditor $AUDITOR_MODEL/$AUDITOR_EFFORT, bumped to builder tier if stronger)"
  diff="$(git -C "$ROOT" diff "origin/$MAIN_BRANCH..HEAD" 2>/dev/null)"
  rel="$(task_spec_rel "$id")"; [ -n "$rel" ] && [ -f "$ROOT/$rel" ] && spec="$(cat "$ROOT/$rel")"
  # UI tasks: give the auditor VISUAL evidence — a text diff can't show whether a UI element renders.
  local visual=""
  if [ "$layer" = "ui" ]; then
    visual="$(cat <<'EOF'

--- VISUAL EVIDENCE — REQUIRED FOR THIS UI TASK ---
The text diff above is NOT sufficient to judge a UI task (an element can be in the diff yet never be
painted — the T223 padlock bug). Before deciding PASS/FAIL you MUST:
  1. Run:  npm --prefix dashboard run build && node dashboard/scripts/visual-check.mjs
  2. READ the screenshots it writes to dashboard/scripts/visual-out/ (the script prints their paths).
  3. Judge whether the rendered pages actually satisfy every "## Done when" item VISUALLY — the
     intended element is present AND painted/visible, not merely in the DOM. FAIL if a screenshot
     contradicts a "## Done when" claim, if the visual check exits non-zero, or if a "## Done when"
     visual requirement is not evidenced by what actually renders.
EOF
)"
  fi
  out="$WORKLOG/$id.audit.md"
  rlpoll="${RL_POLL:-${RL_BACKOFF_MIN:-300}}"
  while :; do
    set +e; run_claude "$am" "$ae" "$(audit_prompt "$id" "$spec" "$diff" "$visual")"; arc=$?; set -e
    [ "$arc" = 10 ] && { log "auditor rate-limited — waiting ${rlpoll}s (NOT an audit fail)"; sleep "$rlpoll"; continue; }
    break
  done
  cp "$WORKLOG/.claude-out" "$out" 2>/dev/null || true
  verdict="$(grep -oiE '\b(PASS|FAIL)\b' "$out" 2>/dev/null | head -1 | tr '[:lower:]' '[:upper:]')"
  if [ "$verdict" = "PASS" ]; then cur_verification="audited"; log "audit: PASS for $id (reasons → $out)"; return 0; fi
  AUDIT_FAIL_DETAIL="verdict=${verdict:-none}; reasons in .harness/worklog/$id.audit.md"
  log "audit: FAIL for $id (verdict='${verdict:-none}', reasons → $out)"; return 1
}

# Allow a test (or another script) to source ONLY the helper functions — set
# LOOP_SOURCE_ONLY=1 before sourcing to return here, before the loop runs.
[ -n "${LOOP_SOURCE_ONLY:-}" ] && return 0 2>/dev/null || true

# --- Dry run ----------------------------------------------------------------
if [ "${DRY_RUN:-0}" = "1" ]; then
  git -C "$ROOT" fetch origin --quiet 2>/dev/null || true
  sel="$(select_task || true)"
  [ -n "$sel" ] && echo "DRY-RUN → would build: $sel" \
                || echo "DRY-RUN → nothing eligible (backlog done or all gate/human-blocked)"
  exit 0
fi

# --- Main loop --------------------------------------------------------------
acquire_lock
trap 'release_lock' EXIT INT TERM

# SAFETY: the in-place loop cold-resets the working tree (`git reset --hard origin/main`) between
# every attempt, which DISCARDS any uncommitted work in this checkout. If the tree is dirty at
# startup, that's external work the loop must NOT destroy — refuse to run (commit/stash first).
if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
  log "REFUSING TO RUN: '$ROOT' has uncommitted changes. The in-place loop cold-resets (git reset --hard) and would discard them. Commit or stash first."
  exit 3
fi

cur_task=""; cur_attempts=0; cur_rung=0; cur_base=0; cur_verification="ci-only"

# Give up on ONE task WITHOUT halting the loop: discard any local unpushed work, record a
# failed:blocked marker in the task's worklog (so select_task skips it), push that, and move on.
block_task() {
  local id="$1" reason="$2"
  git -C "$ROOT" reset --hard "origin/$MAIN_BRANCH" 2>/dev/null || true
  mkdir -p "$WORKLOG"
  printf '\n---\nfailed:blocked %s — %s\n' "$id" "$reason" >>"$WORKLOG/$id.md"
  record_outcome "$id" true "$reason"               # blocked → ledger row (succeededRung=null, topRung=cur_rung, reason kept)
  flush_failures                                     # fold this task's buffered per-attempt failures into the committed FAILURES ledger
  # Stage always-present files first; add FAILURES only if it exists (see mark_done — a single add with a
  # missing failures.jsonl stages nothing and silently drops this commit).
  git -C "$ROOT" add "$WORKLOG/$id.md" "$OUTCOMES" 2>/dev/null || true
  if [ -f "$FAILURES" ]; then git -C "$ROOT" add "$FAILURES" 2>/dev/null || true; fi
  git -C "$ROOT" commit -q -m "$id: blocked, needs human — skipping [skip ci]" 2>/dev/null || true
  git -C "$ROOT" push origin "HEAD:$MAIN_BRANCH" 2>/dev/null || log "WARN: couldn't push block marker for $id"
  log "BLOCKED $id ($reason) — recorded for a human; moving on to the next task."
  cur_task=""; cur_attempts=0; cur_rung=0; cur_base=0
}

bump() {   # count a soft failure for $1 (kind/detail → failures.jsonl); escalate at the cap; BLOCK + move on past the top rung (never halt)
  local t="$1" kind="${2:-soft}" detail="${3:-}" last
  [ "$t" = "$cur_task" ] || { cur_task="$t"; cur_attempts=0; cur_rung=0; cur_base="$(pick_base "$t")"; }
  last=$(( $(ladder_len "$t") - 1 ))
  cur_attempts=$((cur_attempts + 1))
  record_failure "$t" "$kind" "$detail"             # capture THIS attempt's cause (the full escalation history, not just the terminal row)
  log "soft failure $cur_attempts/$MAX_ATTEMPTS on $t (rung $cur_rung/$last): $kind${detail:+ — $detail}"
  if (( cur_attempts >= MAX_ATTEMPTS )); then
    if (( cur_rung < last )); then
      cur_rung=$((cur_rung + 1)); cur_attempts=0
      log "escalating $t → rung $cur_rung: $(rung_at "$t" "$cur_rung")"
    else
      block_task "$t" "exhausted $MAX_ATTEMPTS attempts at the top model rung"
      return 0
    fi
  fi
  sleep "$WAIT_SECONDS"
}

log "starting — default model=$MODEL effort=$EFFORT, in-place on $MAIN_BRANCH, ci_gate=$REQUIRE_CI"
mkdir -p "$WORKLOG"
# Pre-flight (difficulty auto-tuning): warn about BUILDABLE tasks missing facets. Non-fatal — the
# policy degrades to the authored prior, but a facet-less task gets no auto-tuning + adds nothing to
# calibration. needs-human/gated tasks are correctly excluded (they're carved out).
_missing_facets="$(tj -r '[.tasks[]|select(.status!="done" and (.gate==null) and ((.facets|not) or (.facets.layer|not)))|.id]|join(", ")' 2>/dev/null || true)"
if [ -n "$_missing_facets" ]; then log "WARN: buildable tasks MISSING facets (no auto-tuning until tagged — see facets.json): $_missing_facets"; fi
for ((i = 1; i <= MAX_ITERS; i++)); do
  git -C "$ROOT" fetch origin --quiet 2>/dev/null || true
  sel="$(select_task || true)"
  if [ -z "$sel" ]; then
    log "no eligible task — backlog complete or everything left is gate/human-blocked."
    board; exit 0
  fi
  task="$sel"
  if [ "$task" != "$cur_task" ]; then
    cur_task="$task"; cur_attempts=0; cur_rung=0
    cur_base="$(pick_base "$task")"          # difficulty auto-tuning: policy picks the start tier
    log "policy: $task → start tier $cur_base ($(gtier "$cur_base")), ladder rungs $(ladder_len "$task")"
  fi
  read -r tmodel teffort <<<"$(rung_at "$task" "$cur_rung")"
  log "iteration $i/$MAX_ITERS → $task (cold) on $tmodel/$teffort (rung $cur_rung)"

  RESULT="$WORKLOG/.result"; rm -f "$RESULT"

  # Run Claude COLD — every (re)attempt resets to a CLEAN tree first, so it measures one cold pass of
  # this tier (designs/audit-verification.md §4.1). Pause + auto-resume on usage/rate limits (NOT a failure).
  rl_sleep="$RL_BACKOFF_MIN"
  while :; do
    cold_reset
    set +e; run_claude "$tmodel" "$teffort" "$(prompt "$task")"; rc=$?; set -e
    if [ "$rc" = 10 ]; then
      log "Claude usage/rate limit hit — backing off ${rl_sleep}s, will RE-ATTEMPT the same task COLD (not a failure)."
      sleep "$rl_sleep"
      rl_sleep=$(( rl_sleep * 2 )); [ "$rl_sleep" -gt "$RL_BACKOFF_MAX" ] && rl_sleep="$RL_BACKOFF_MAX"
      continue
    fi
    break
  done
  if [ "$rc" -ne 0 ]; then
    log "claude exited $rc (crash / non-rate-limit) — backing off ${WAIT_SECONDS}s"; sleep "$WAIT_SECONDS"; continue
  fi
  [ -f "$RESULT" ] || { log "no result file written — backing off"; sleep "$WAIT_SECONDS"; continue; }

  read -r status rtask extra <"$RESULT" || true
  case "$status" in
    done)
      log "agent reports $task built + committed"
      if ! guard_clean; then
        log "PRE-PUSH GUARD tripped on $task — sensitive path staged; discarding the commit + blocking."
        record_failure "$task" "guard" "sensitive path staged"
        block_task "$task" "pre-push guard tripped (sensitive path staged)"; board; continue
      fi
      # Cheap structural gate (in-place local DoD) THEN the blocking audit — both BEFORE the push, so
      # a failure never reaches the remote (designs/audit-verification.md §3). Either fail = a failed
      # attempt: discard the commit + soft-retry (cold), escalating per the existing ladder.
      if ! structural_checks "$task"; then
        log "structural checks failed for $task — discarding commit + soft retry."
        cold_reset; bump "$task" "${STRUCT_FAIL_KIND:-structural}" "$STRUCT_FAIL_DETAIL"; board; continue
      fi
      if ! audit_gate "$task"; then
        log "AUDIT FAILED for $task — discarding the commit (never pushed) + soft retry."
        cold_reset; bump "$task" "audit-fail" "$AUDIT_FAIL_DETAIL"; board; continue
      fi
      if ! git -C "$ROOT" push origin "HEAD:$MAIN_BRANCH"; then
        log "push to $MAIN_BRANCH failed (remote moved / network) — soft retry."
        bump "$task" "push-fail" "remote moved / network"; board; continue
      fi
      if [ "$REQUIRE_CI" = "1" ]; then
        if wait_ci_green; then
          mark_done "$task"; run_integrate_hook; log "integrated $task → $MAIN_BRANCH (CI green)"; cur_task=""; cur_attempts=0; cur_rung=0; cur_base=0
        else
          # NEVER halt the whole loop on one red CI: revert the pushed commit to restore main, then
          # soft-retry. If it keeps failing, bump eventually BLOCKS it and the loop moves on.
          log "CI RED for $task — reverting the pushed commit to restore $MAIN_BRANCH, then retrying."
          if git -C "$ROOT" revert --no-edit HEAD 2>/dev/null && git -C "$ROOT" push origin "HEAD:$MAIN_BRANCH" 2>/dev/null; then
            log "reverted $task; $MAIN_BRANCH is clean again."
          else
            log "WARN: auto-revert/push failed — main may need a manual: git revert HEAD && git push"
          fi
          bump "$task" "ci-red" "CI checks failed on the pushed commit"
        fi
      else
        mark_done "$task"; run_integrate_hook; log "marked $task done (REQUIRE_CI=0; local DoD only)"; cur_task=""; cur_attempts=0; cur_rung=0; cur_base=0
      fi
      ;;
    failed:soft)    log "agent soft-failed $rtask: ${extra:-}"; bump "$task" "agent-soft" "${extra:-}" ;;
    failed:blocked) log "agent reports blocker on $rtask: ${extra:-}"; record_failure "$task" "agent-blocked" "${extra:-}"; block_task "$task" "agent reported failed:blocked — ${extra:-}" ;;
    waiting)        log "waiting on deps for $rtask: ${extra:-}"; sleep "$WAIT_SECONDS" ;;
    idle)           log "agent reports idle — nothing to do"; board; exit 0 ;;
    *)              log "unrecognized result '$status' — backing off"; sleep "$WAIT_SECONDS" ;;
  esac
  board
done

log "reached MAX_ITERS=$MAX_ITERS — stopping"; board; exit 4
