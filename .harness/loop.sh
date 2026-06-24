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
OUTCOMES="$HARNESS_DIR/outcomes.jsonl"             # append-only escalation ledger — the SOLE input to difficulty calibration (forward-only)
NAME="$(basename "$ROOT")"
MODEL="${MODEL:-claude-opus-4-8}"                 # pin EXACTLY — the bare alias drifts
EFFORT="${EFFORT:-high}"                           # low|medium|high|xhigh|max
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"                  # soft failures per rung before escalating
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
      -c '.tasks[]|select(.id==$id)|{
        id:$id, ts:$ts, facets:(.facets // null), scopeSize:(.scope|length),
        startModel:$sm, startEffort:$se, finalModel:$fm, finalEffort:$fe,
        succeededRung:(if $blocked then null else $rung end), topRung:$rung,
        attemptsAtRung:$atr, totalSoftFails:$total, blocked:$blocked, reason:$reason
      }')"
  if [ -n "$line" ]; then printf '%s\n' "$line" >>"$OUTCOMES"; else log "WARN: couldn't record outcome for $id"; fi
}

# Shell owns task status: set it done, then commit+push the one-line change (no CI needed).
mark_done() {
  local id="$1" tmp="$BACKLOG.tmp"   # same-dir temp → mv is an atomic rename (no cross-fs partial reads)
  jq --arg id "$id" '(.tasks[]|select(.id==$id)|.status)="done"' "$BACKLOG" >"$tmp" \
    && mv "$tmp" "$BACKLOG" || { rm -f "$tmp"; log "WARN: failed to mark $id done"; return 1; }
  record_outcome "$id" false                        # success → ledger row (succeededRung=cur_rung)
  git -C "$ROOT" add "$BACKLOG" "$WORKLOG" "$OUTCOMES" 2>/dev/null || true
  git -C "$ROOT" commit -q -m "$id: mark done [skip ci]" 2>/dev/null || true
  git -C "$ROOT" push origin "HEAD:$MAIN_BRANCH" 2>/dev/null || log "WARN: couldn't push status update for $id"
}

# Optional post-integration hook (deploy/restart so the running product matches main).
run_integrate_hook() {
  [ -n "$INTEGRATE_HOOK" ] || return 0
  log "integrate hook: $INTEGRATE_HOOK"
  ( cd "$ROOT" && eval "$INTEGRATE_HOOK" ) || log "WARN: integrate hook failed (non-fatal)"
}

# task_ladder <id> — emit "MODEL<TAB>EFFORT" per build rung (rung 0 = primary, then escalations).
task_ladder() {
  tj -r --arg id "$1" '
    (.defaults.model // "") as $dm | (.defaults.effort // "") as $de |
    (.defaults.escalation // []) as $desc |
    .tasks[] | select(.id==$id) |
    ( [ { model:(.model // $dm), effort:(.effort // $de) } ]
      + ( (.escalation // $desc) | map({ model:(.model // $dm), effort:(.effort // $de) }) )
    ) | .[] | "\(.model)\t\(.effort)"'
}
ladder_len() { task_ladder "$1" | grep -c .; }
rung_at() {
  local r m e
  r="$(task_ladder "$1" | sed -n "$(( ${2:-0} + 1 ))p")"
  m="${r%%$'\t'*}"; e="${r##*$'\t'}"
  printf '%s %s' "${m:-$MODEL}" "${e:-$EFFORT}"
}

# SELECT — echo the next eligible task id; return 1 if nothing is eligible.
select_task() {
  local t d ok
  if [ -n "$FORCE_TASK" ]; then echo "$FORCE_TASK"; return 0; fi
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

1. ORIENT & RESUME. Read CLAUDE.md and README.md (current state). Find this task:
   `jq '.tasks[]|select(.id=="<TASK>")' .harness/TASKS.json` (read its scope/verify and all other
   orchestration fields). The task's `do` + `done-when` live in the Markdown spec at the JSON `spec`
   path (.harness/tasks/<TASK>.md, sections '## Do' / '## Done when') — its FULL TEXT is also
   appended at the end of this prompt. Read .harness/worklog/<TASK>.md if present (prior attempts —
   don't repeat dead ends). The working tree MAY hold partial work from an interrupted attempt —
   RECONCILE: do ONLY the outstanding work vs the spec's '## Done when', trusting the code over the
   worklog. Stay within the task's `scope`.

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

4. DOCS IN LOCKSTEP (same commit): update README.md / CLAUDE.md if a convention or feature changed,
   and add any new trade-off to .harness/LIMITATIONS.md. Do NOT edit .harness/TASKS.json — the loop
   owns task status. Write your notes to .harness/worklog/<TASK>.md.

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

cur_task=""; cur_attempts=0; cur_rung=0

# Give up on ONE task WITHOUT halting the loop: discard any local unpushed work, record a
# failed:blocked marker in the task's worklog (so select_task skips it), push that, and move on.
block_task() {
  local id="$1" reason="$2"
  git -C "$ROOT" reset --hard "origin/$MAIN_BRANCH" 2>/dev/null || true
  mkdir -p "$WORKLOG"
  printf '\n---\nfailed:blocked %s — %s\n' "$id" "$reason" >>"$WORKLOG/$id.md"
  record_outcome "$id" true "$reason"               # blocked → ledger row (succeededRung=null, topRung=cur_rung, reason kept)
  git -C "$ROOT" add "$WORKLOG/$id.md" "$OUTCOMES" 2>/dev/null || true
  git -C "$ROOT" commit -q -m "$id: blocked, needs human — skipping [skip ci]" 2>/dev/null || true
  git -C "$ROOT" push origin "HEAD:$MAIN_BRANCH" 2>/dev/null || log "WARN: couldn't push block marker for $id"
  log "BLOCKED $id ($reason) — recorded for a human; moving on to the next task."
  cur_task=""; cur_attempts=0; cur_rung=0
}

bump() {   # count a soft failure for $1; escalate at the cap; BLOCK + move on past the top rung (never halt)
  local t="$1" last
  [ "$t" = "$cur_task" ] || { cur_task="$t"; cur_attempts=0; cur_rung=0; }
  last=$(( $(ladder_len "$t") - 1 ))
  cur_attempts=$((cur_attempts + 1))
  log "soft failure $cur_attempts/$MAX_ATTEMPTS on $t (rung $cur_rung/$last)"
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
for ((i = 1; i <= MAX_ITERS; i++)); do
  git -C "$ROOT" fetch origin --quiet 2>/dev/null || true
  sel="$(select_task || true)"
  if [ -z "$sel" ]; then
    log "no eligible task — backlog complete or everything left is gate/human-blocked."
    board; exit 0
  fi
  task="$sel"
  [ "$task" = "$cur_task" ] || { cur_task="$task"; cur_attempts=0; cur_rung=0; }
  read -r tmodel teffort <<<"$(rung_at "$task" "$cur_rung")"
  mode="fresh"; [ -n "$(git -C "$ROOT" status --porcelain)" ] && mode="resume"
  log "iteration $i/$MAX_ITERS → $task ($mode) on $tmodel/$teffort (rung $cur_rung)"

  RESULT="$WORKLOG/.result"; rm -f "$RESULT"

  # Run Claude, pausing + auto-resuming on usage/rate limits (NOT counted as a failure).
  rl_sleep="$RL_BACKOFF_MIN"
  while :; do
    set +e; run_claude "$tmodel" "$teffort" "$(prompt "$task")"; rc=$?; set -e
    if [ "$rc" = 10 ]; then
      log "Claude usage/rate limit hit — backing off ${rl_sleep}s, will RESUME the same task (not a failure)."
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
        block_task "$task" "pre-push guard tripped (sensitive path staged)"; board; continue
      fi
      if ! git -C "$ROOT" push origin "HEAD:$MAIN_BRANCH"; then
        log "push to $MAIN_BRANCH failed (remote moved / network) — soft retry."
        bump "$task"; board; continue
      fi
      if [ "$REQUIRE_CI" = "1" ]; then
        if wait_ci_green; then
          mark_done "$task"; run_integrate_hook; log "integrated $task → $MAIN_BRANCH (CI green)"; cur_task=""; cur_attempts=0; cur_rung=0
        else
          # NEVER halt the whole loop on one red CI: revert the pushed commit to restore main, then
          # soft-retry. If it keeps failing, bump eventually BLOCKS it and the loop moves on.
          log "CI RED for $task — reverting the pushed commit to restore $MAIN_BRANCH, then retrying."
          if git -C "$ROOT" revert --no-edit HEAD 2>/dev/null && git -C "$ROOT" push origin "HEAD:$MAIN_BRANCH" 2>/dev/null; then
            log "reverted $task; $MAIN_BRANCH is clean again."
          else
            log "WARN: auto-revert/push failed — main may need a manual: git revert HEAD && git push"
          fi
          bump "$task"
        fi
      else
        mark_done "$task"; run_integrate_hook; log "marked $task done (REQUIRE_CI=0; local DoD only)"; cur_task=""; cur_attempts=0; cur_rung=0
      fi
      ;;
    failed:soft)    log "agent soft-failed $rtask: ${extra:-}"; bump "$task" ;;
    failed:blocked) log "agent reports blocker on $rtask: ${extra:-}"; block_task "$task" "agent reported failed:blocked — ${extra:-}" ;;
    waiting)        log "waiting on deps for $rtask: ${extra:-}"; sleep "$WAIT_SECONDS" ;;
    idle)           log "agent reports idle — nothing to do"; board; exit 0 ;;
    *)              log "unrecognized result '$status' — backing off"; sleep "$WAIT_SECONDS" ;;
  esac
  board
done

log "reached MAX_ITERS=$MAX_ITERS — stopping"; board; exit 4
