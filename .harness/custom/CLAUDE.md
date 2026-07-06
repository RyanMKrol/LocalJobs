# .harness/custom/CLAUDE.md — your project-specific harness instructions

This is the **customization overlay** for `.harness/CLAUDE.md`. Anything you add here loads automatically
(the pristine `.harness/CLAUDE.md` imports it with `@custom/CLAUDE.md`), and **harness upgrades never touch
this file** — so this is where your edits belong.

## Why this file exists — the overlay rule

The harness's own prose files (`.harness/CLAUDE.md`, `README.md`, and everything under `docs/`) are
**plugin-owned**: `/implementation-harness-upgrade` refreshes them from the latest plugin version. If you
edit them in place, your changes collide with every future upgrade and force a manual reconcile. Instead,
put project-specific additions in the matching file under `.harness/custom/` — this tree **mirrors** the
harness layout (`custom/CLAUDE.md`, `custom/README.md`, `custom/docs/HARNESS.md`, …). The pristine files
then stay byte-identical to the plugin and upgrade cleanly, while your customizations ride along untouched.

(Scripts and config are NOT covered by this prose overlay — customize the loop via `config/harness.env`,
and if you need a script change, flag it to upstream into the plugin rather than hand-editing in place.)

Add your project's harness-authoring conventions, house rules, and reminders below.

<!-- Add your project-specific instructions here. -->

---

## Capturing ideas — the bare `/idea` command

This project keeps a deliberately **un-prefixed** `/idea` capture command (`.claude/commands/idea.md`) so the
same keystroke/macro works across every repo — mirror that bare filename in other repos rather than prefixing
it. It appends one bullet to `tracking/IDEAS.md`. Conversion to real tasks uses the plugin's
`/implementation-harness-convert-ideas` skill (the former project-local `/local-jobs-convert-ideas` fork was
retired). `tracking/IDEAS.md` is gitignored — raw ideas may reference private jobs, so they stay local.

## Bumping the base model (preserve calibration — migrate the ledger in lockstep)

When a new model ships and you switch the harness to it, the difficulty calibration in
`ledgers/outcomes.jsonl`/`ledgers/failures.jsonl` must be **migrated in lockstep**, or it is silently
lost. `scripts/policy.jq` maps each historic row's `(model, effort)` to a ladder **index** via `tidx`,
and **drops any row whose tuple isn't on the current ladder** (`select($s >= 0 and $f >= 0)`). So if
you change the ladder in `config/facets.json` but leave the ledger referencing the old id, every
historic row becomes `tidx = -1` → dropped → every `(layer × workType)` cell cold-starts from the
floor again.

Procedure (done for `claude-sonnet-4-6 → claude-sonnet-5`, 2026-07-01):
1. **Pin the FULL id.** From `claude-sonnet-4-6` on, model IDs are a **dateless pinned snapshot** (not
   an evergreen alias) — so `claude-sonnet-5` is the correct thing to pin (no `-YYYYMMDD`). Confirm the
   exact id from Anthropic's models doc; do not guess.
2. **Config:** update the `MODEL` default in `config/harness.env` + `scripts/loop.sh`, and the sonnet
   tiers in the `config/facets.json` `.tiers.ladder`. Leave the Opus ceiling + `policy.auditorModel`
   unless bumping those too.
3. **Migrate the ledger 1:1:** `sed 's/<oldid>/<newid>/g'` over `ledgers/outcomes.jsonl` +
   `ledgers/failures.jsonl` (and the gitignored `worklog/.failures.buf` so a pending flush stays
   consistent). Because the new model takes the SAME ladder positions, this preserves every cell's
   learned difficulty exactly. Leave worklog narrative (`*.md`) alone — it's historical record, not
   policy-consumed.
4. **Verify calibration is unchanged:** run `scripts/policy.jq` per cell against (old ledger + old ladder) vs
   (new ledger + new ladder); every cell's chosen start-tier must be identical. (It's a slightly
   *pessimistic* prior if the new model is stronger — safe; the ladder still escalates.)

## Known-but-deferred issues (review if they recur)

A running log of harness pathologies we've **seen at least once** and **consciously chose not to fix
yet** — usually because they're rare or only triggered by manual intervention. If you (Claude) hit
one again while working in or evaluating the harness, **flag it to the owner** with a pointer here
rather than silently working around it; a second occurrence is the signal to actually fix it. Add a
dated bullet when you defer something new.

- **2026-06-26 — A manual loop interrupt (Ctrl+C) can orphan a task whose work already merged.**
  *Symptom:* a task's code is on `main` and CI-green, but its `status` is still `pending` (the
  interrupt landed between the push and `mark_done`). The loop then re-selects it, the cold rebuild
  finds the feature already present so it produces only a worklog-only `[skip ci]` commit, and
  `wait_ci_green` never sees a CI run for that SHA → it times out (~`CI_TIMEOUT`s) and treats "no run
  appeared" the SAME as "CI failed" → revert + retry, **forever** (a `…build summary` → `Revert …`
  cycle, climbing the ladder until it falsely BLOCKS a task that's actually done). Two root causes:
  (a) an interrupt can leave a merged task in `pending`; (b) `wait_ci_green` returning *indeterminate*
  (no run / `[skip ci]`) is conflated with *red*. *Manual recovery (what we did):* stop the loop,
  confirm the work is on `main` + green, mark the task `done`, drop the bogus `ci-red` rows from the
  failure buffer, and add a clean `outcomes.jsonl` success row. *Why deferred:* only triggered by a
  manual Ctrl+C mid-task; not worth the complexity yet. *If it recurs:* consider (1) `wait_ci_green`
  treating indeterminate ≠ red, and (2) the loop detecting "this task's work is already on `main` →
  just `mark_done`" instead of rebuilding.
  **2026-07-07 — RESOLVED by the harness upgrade to plugin v1.29.0.** Adopting the pristine `loop.sh`
  brought its `[skip ci]` short-circuit: when the build commit is `[skip ci]`, the loop marks the task
  done immediately instead of waiting for a CI run that will never appear — closing the "worklog-only
  `[skip ci]` commit → `wait_ci_green` times out → revert forever" pathology described above. (The
  broader interrupt-window race is likewise covered by the pristine loop's overlay-reconcile + CI-
  indeterminate handling.)
- **2026-06-26 — ROOT CAUSE FOUND + FIXED: `mark_done`/`block_task` silently failed to commit
  `status=done` whenever `failures.jsonl` didn't exist.** The interrupt above was a *red herring* — the
  real reason tasks orphaned was a regression in the T-`failures.jsonl` change (commit `2226eb1`):
  `mark_done` did `git add "$BACKLOG" "$WORKLOG" "$OUTCOMES" "$FAILURES"`, but `.harness/failures.jsonl`
  almost never exists (failures are rare). `git add` fails **atomically** on a missing pathspec —
  staging **nothing** — so `git commit … || true` hit "no changes added to commit" and silently no-op'd.
  The `status=done` therefore lived ONLY as an uncommitted working-tree edit, which the next task's
  `cold_reset` wiped → **every** completed task since `2226eb1` orphaned (T214–T218), not just on
  interrupts (a clean run would orphan them too; the interrupt just made it visible — and the loop log's
  opening `no changes added to commit` line was the smoking gun). *Fix:* stage the always-present files
  first, then add `$FAILURES` only `if [ -f "$FAILURES" ]` (both `mark_done` and `block_task`). Verified
  in a scratch repo: the `mark done` commit now persists with `failures.jsonl` absent. **Do not recombine
  those `git add`s.** The interrupt-window race + `wait_ci_green`-indeterminate items above remain the
  only genuinely-deferred parts.
- **2026-06-29 — FIXED: usage-limit handling, CI-indeterminate≠red, supervise over-park, and dirty-tree
  block.** A session-limit hit on T254/T258 exposed a cluster of interacting bugs, all now fixed in
  `loop.sh`/`supervise.sh`/`harness.env`:
  - **`run_claude` missed an exit-0 usage limit.** It only classified a rate-limit when the CLI exited
    non-zero (`rc != 0 && RL_RE`), but the CLI often prints "You've hit your session limit · resets …"
    and STILL exits 0 — so the smart reset-aware backoff (`rl_reset_wait`, T265) was never reached and
    the loop fell through and EXITED. *Fix:* a tight `RL_HARD_RE` now classifies the unambiguous limit
    wording as rate-limited **regardless of exit code** (returns 10 → backoff); the broad `RL_RE` still
    only applies when the command also failed, so ordinary success output can't be misread.
    NB: the `rl_reset_wait` PARSER itself was never broken — it correctly parses
    `resets 7:30pm (Europe/London)` under real bash (the apparent "no match" was a zsh-vs-bash
    `BASH_REMATCH` artifact when testing interactively; loop.sh runs under `#!/usr/bin/env bash`).
  - **`wait_ci_green` conflated CANCELLED with RED** (the long-deferred item #1 above). It now reads the
    run's ACTUAL `conclusion` after watching: only `failure`/`timed_out`/`startup_failure`/`action_required`
    → red (return 1); `cancelled`/`skipped`/`stale`/no-run → **indeterminate (return 2)**. The caller
    branches on 0/1/2 and on indeterminate does **NOT revert** the pushed commit (it used to revert good
    work whenever a newer push concurrency-cancelled the run). Rough edge: an indeterminate result leaves
    the commit on `main` and soft-retries; a cold re-attempt may then hit an empty diff (the already-on-
    `main` pathology, deferred item above) — acceptable vs. reverting verified work.
  - **`supervise.sh` parked the FULL 5h15m window even on an early exit.** It now captures the loop's exit
    code and on a non-zero exit does a short `SUPERVISE_ERROR_BACKOFF` (default 300s) relaunch instead of
    the full interval — the loop now OWNS its usage-limit waits internally, so a non-zero exit is a crash,
    not quota exhaustion. (This was the real cause of "next cycle at 21:47" — supervise's fixed cadence,
    not the loop's backoff.)
  - **Dirty-tree startup refusal permanently blocked unattended runs.** A killed attempt leaves orphaned
    partial work; the startup guard then refused every future cycle (`exit 3`). New opt-in
    `LOOP_AUTORESET` (default **1** in `harness.env` for this dedicated checkout) auto-STASHES the dirty
    tree with a timestamped, recoverable label (`git stash list`) then hard-resets to `origin/$MAIN_BRANCH`
    so the loop can always start. Set `0` to restore the protective refuse-on-dirty behaviour.
  - **`structural_checks` discarded `LOCAL_DOD` output** (`>/dev/null 2>&1`), so a `tsc`/`test` failure was
    undiagnosable after `cold_reset` wiped the tree. It now tees to the gitignored `$WORKLOG/.local-dod.log`
    and logs the last 30 lines on failure. (The earlier `wait_ci_green` output is similarly worth capturing
    if it recurs.)
- **2026-06-30 — FIXED the REAL reason the loop exited on a usage limit: a `set -e` escape in the
  run_claude call sites (the 2026-06-29 "detect on rc=0" fix above was necessary but NOT sufficient).**
  `run_claude` internally does `set +e` (to read the claude pipe's `PIPESTATUS` without dying) then
  `set -e` to restore it — but `set -e` is a GLOBAL shell option, so by the time `run_claude` hits
  `return 10` it has re-enabled `set -e`, which **defeats the caller's leading `set +e`**. The call
  sites were `set +e; run_claude …; rc=$?; set -e` — and with `set -e` flipped back ON inside
  run_claude, the non-zero `return 10` triggers errexit and **kills `loop.sh` (exit 10) at the call,
  before `rc=$?` runs** — so the reset-aware backoff handler was never reached. supervise then saw a
  non-zero exit and did blind `SUPERVISE_ERROR_BACKOFF` (300s) relaunches that re-hit the limit
  immediately — the "5-minute retries forever" symptom. *Fix:* both call sites (builder ~`run_claude
  "$tmodel"` and auditor ~`run_claude "$am"`) now use **`rc=0; set +e; run_claude … || rc=$?; set -e`**
  — the `|| rc=$?` (an AND-OR list) is never exited-on by `set -e` regardless of run_claude's internal
  flipping, so rc=10 is captured and the handler runs. Verified with a minimal `set -euo pipefail`
  repro + an integration sim of the loop's structure (handler runs, script does NOT exit on rc=10).
  Now: a KNOWN reset ("resets 3:10pm (TZ)") → the loop sleeps until that time + `RL_BUFFER` (raised to
  **300s = 5 min**) and resumes itself, NOT supervise; an UNKNOWN/unparseable reset → exponential
  backoff capped at the new **`RL_EXP_MAX` (1h)** (decoupled from `RL_BACKOFF_MAX`=5h, which still caps
  a parsed wait since a real reset can be hours out). **Lesson:** a helper that toggles global `set -e`
  must be called with `|| rc=$?`, never `; rc=$?` — the latter is a latent errexit landmine.
