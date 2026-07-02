---
description: Evaluate the autonomous loop after a manual interrupt and clean up orphaned tasks / artifacts robustly
argument-hint: (optional) a task id to focus on, e.g. T215 — omit for a full sweep
---

You are recovering the autonomous build loop (`.harness/scripts/loop.sh`, run via `.harness/scripts/supervise.sh`)
after it was **manually interrupted** (Ctrl+C). A clean interrupt is rare to get exactly right: the
loop can be killed mid-flow and leave inconsistent state behind. Your job is to **evaluate the loop's
health, find every problem the interrupt may have caused, fix them properly and robustly, and leave
the loop ready to restart** — exactly the procedure below.

Focus target: `$ARGUMENTS` (if a task id is given, scope the orphan checks to it but still run the
global health checks; if empty, do a full sweep).

This is a **deliberate, human-invoked recovery**. It mutates committed state (TASKS.json `status`,
`outcomes.jsonl`) and commits + pushes to `main`. That is normally the loop's job, but here the loop
is stopped and you are correcting the state the interrupt left wrong. Work carefully, verify before
you mutate, and **report every change you make**.

---

## ⚠️ Guardrails (do not violate)

- **The loop MUST be stopped before you touch anything.** If a `loop.sh`/`supervise.sh` process is
  still alive, STOP and tell the user — do not edit files or git while the loop runs (its `cold_reset`
  would wipe your work, and your pushes would race its pushes).
- **Never mark a task `done` unless you have VERIFIED it is genuinely complete** (code merged to
  `origin/main` + CI green + `tsc`/tests pass on current main + any audit PASS). If a task's work is
  NOT on main, CI is red/missing, an audit FAILED, or checks fail — it is *not* an orphan, it is
  genuinely incomplete/broken. STOP and surface it; do not paper over it.
- **Never fabricate ledger data.** Outcome metrics must reflect what actually happened; record
  `verification: "audited"` ONLY if the loop's own independent auditor ran and PASSed (a real
  `<id>.audit.md` from the loop). A review you did by hand is `ci-only`.
- **Privacy / git hygiene:** never `git add -A` or `git add .`; never blanket `git clean`; never stage
  `data/`, `.env*`, `chrome-profile/`, credentials, or private `*.job.ts` files. Stage explicit paths.
- **Do not rewrite pushed `main` history** (e.g. the harmless revert/build-summary churn commits)
  unless the user explicitly asks — rewriting published main is risky and rarely worth it.
- **Do not kill the daemon or dashboard.** `tsx src/daemon.ts` and the dashboard `next start`
  (launchd: `com.ryankrol.localjobs`, `com.ryankrol.localjobs-dashboard`) are the *product*, not loop
  artifacts. They coordinate with the loop via the shared repo lock; leave them running.

Key mental model: **gitignored files survive `cold_reset` (`git reset --hard` + `git clean -fd`);
tracked files do not.** That is why audit logs / the failure buffer persist across attempts while an
uncommitted `status=done` change can silently vanish — the root of most interrupt damage.

---

## 1. Confirm graceful shutdown

```bash
# processes — expect NONE
ps aux | grep -iE "loop\.sh|supervise\.sh|claude -p|runJob" | grep -v grep || echo "✓ none"
# lock — expect absent. Path = <git-common-dir>/<basename(repo)>-loop.lock
GC="$(git rev-parse --git-common-dir)"; case "$GC" in /*) ;; *) GC="$(pwd)/$GC";; esac
LOCK="$GC/$(basename "$(pwd)")-loop.lock"; ls -la "$LOCK" 2>/dev/null && cat "$LOCK/pid" || echo "✓ no lock"
```
- If a process is alive → STOP (loop still running).
- If the lock dir exists: if its `pid` is a **dead** PID → stale, remove it (`rm -f "$LOCK/pid"; rmdir
  "$LOCK"`). If the PID is **alive** → a loop is genuinely running; STOP.

## 2. Working tree & git state

```bash
git fetch origin --quiet
git status -sb | head -1            # ahead/behind
git status --porcelain             # any dirty?
git rev-list --count origin/main..HEAD   # unpushed
```
- **Dirty tree = in-flight build leftover** from the killed attempt. The loop builds COLD (discards
  prior work each attempt), so this is throwaway. Discard it surgically — **never** a blanket clean:
  ```bash
  git restore <tracked files the attempt modified>
  git clean -fd <the specific untracked task dir, e.g. src/jobs/<wf>/>
  ```
  Confirm `git status --porcelain` is then empty (the loop's startup guard refuses a dirty tree).
- **Unpushed commits**: inspect each (`git log origin/main..HEAD`). Often a stray worklog
  `Revert …` — harmless; it'll go along with your recovery push.

## 3. Transient scratch / logs

```bash
ls -la .harness/worklog/.result .harness/worklog/.claude-out .harness/worklog/.failures.buf 2>/dev/null
```
- `.result` / `.claude-out` — transient per-run scratch; remove them (`rm -f`).
- **`.failures.buf`** — per-attempt failures **buffered but not yet flushed** to `failures.jsonl`
  (flush only happens at a terminal `mark_done`/`block_task`). Inspect it (`jq -c . .harness/worklog/.failures.buf`).
  If the rows are **bogus** — e.g. `ci-red` from a revert-cycle on a task that was actually done — **discard**
  them (`rm -f`); do NOT flush bogus failures into the committed ledger. If they describe a task that
  genuinely failed, that's real signal — leave them / handle with the task.
- `<id>.audit.md` files — gitignored audit records; **keep** them (history + the evidence behind any
  `verification: "audited"` you record).

## 4. Detect & fix orphaned tasks  ← the main event

**The interrupt-orphan pattern:** a task is `status: pending` but its work is **already merged to
`origin/main` and CI-green** — the interrupt hit between the code push and `mark_done`, OR
`mark_done` set `status=done` + appended the outcome locally but its commit/push never reached origin,
and a later `cold_reset` reverted those *tracked* changes (while the gitignored `<id>.audit.md`
survived — the tell-tale signature).

**The revert-cycle variant:** a pending-but-already-merged task gets re-selected; the cold rebuild
finds the work present so it produces only a worklog-only `[skip ci]` commit; `wait_ci_green` never
sees a CI run for a `[skip ci]` commit, times out (~`CI_TIMEOUT`), treats "no run" as red, and
**reverts + retries forever**. Symptom: alternating `"<id>: … [skip ci]"` / `"Revert …"` commits in
`git log`, the task still `pending`, ladder climbing on phantom `ci-red`.

**Detect** (per pending task, or the focus task):
```bash
jq -r '.tasks[]|select(.status=="pending")|.id' .harness/TASKS.json   # candidates
git log --oneline -25 | grep -iE "T<id>"                              # code commit? mark-done commit?
git branch -r --contains <code-sha>                                  # is the work on origin/main?
gh run list --workflow CI --limit 30 --json headSha,status,conclusion --jq '.[]|select(.headSha=="<full-sha>")|"\(.status)/\(.conclusion)"'
git reflog | grep -iE "mark done|T<id>"                              # did mark_done ever run?
grep -c '"id":"T<id>"' .harness/ledgers/outcomes.jsonl                       # outcome row present?
ls .harness/worklog/T<id>.audit.md                                   # was it audited?
```
A task is an **orphan to fix** when: code is on `origin/main` + CI green, but `status=pending` with no
outcome row and no `mark-done` commit.

**Verify it's genuinely done before marking done** (the loop's Definition of Done — run on current `main`):
```bash
npx tsc --noEmit
npm test          # confirm the task's OWN test actually runs — the run-tests harness walks src/ for *.test.ts;
                  # check its file appears (e.g. "── src/jobs/<wf>/<x>.test.ts ──") and "✓ all tests passed"
# if the task touched dashboard/:
npm --prefix dashboard run build && node dashboard/scripts/mobile-check.mjs
```
Plus: CI green on the code commit, and if `<id>.audit.md` exists, read its verdict (PASS?). **If any
of these fail / the code isn't on main / CI is red / the audit FAILED → STOP and report. Do not mark
it done.**

**Fix each verified orphan** (mirror what `mark_done` would have written):
```bash
# a) status -> done (atomic, validated)
jq '(.tasks[]|select(.id=="T<id>")|.status)="done"' .harness/TASKS.json > .harness/TASKS.json.tmp \
  && jq -e '.tasks|length' .harness/TASKS.json.tmp >/dev/null && mv .harness/TASKS.json.tmp .harness/TASKS.json

# b) ONE accurate outcome row
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -nc --arg ts "$TS" '{id:"T<id>",ts:$ts,facets:<from TASKS.json>,scopeSize:<scope length>,
  startModel:"claude-sonnet-4-6",startEffort:"low",finalModel:"…",finalEffort:"…",
  succeededRung:<n>,topRung:<n>,attemptsAtRung:0,totalSoftFails:0,blocked:false,reason:"",
  verification:"audited|ci-only"}' >> .harness/ledgers/outcomes.jsonl
jq -e . .harness/ledgers/outcomes.jsonl >/dev/null   # must stay valid (one JSON object per line)
```
Outcome-row rules:
- `facets` from TASKS.json; `scopeSize` = `.scope|length`.
- `startModel/Effort`, `finalModel/Effort`, `succeededRung`/`topRung`: use what **actually happened**
  if recoverable (the loop console line `"… (cold) on <model>/<effort> (rung N)"`, or the audit file).
  If there's no escalation evidence (the failure buffer shows no real soft-fails), default to the
  **cold-start tier** (`sonnet/low`, rung 0). **Do not fabricate escalations, and do not record
  soft-fails caused by a framework bug** (e.g. a scope-matcher bug) — exclude those so the cell isn't
  mis-calibrated.
- `verification`: `"audited"` ONLY if a real loop `<id>.audit.md` exists with a PASS; else `"ci-only"`.
- The task's `<id>.md` worklog is usually already committed in the code commit — confirm it's sane;
  don't clobber a good one.

## 5. Clean ledger noise

- Remove **stale/wrong** `outcomes.jsonl` rows: e.g. a `blocked` row for a task that was later
  re-scoped and actually succeeded, or rows whose `(finalModel, finalEffort)` tuple is no longer on
  the ladder (calibration drops those anyway — remove for cleanliness). Keep the file valid
  (`jq -e . .harness/ledgers/outcomes.jsonl`), one JSON object per line.
- Leave the harmless revert/build-summary churn commits in history (see guardrails).

## 6. Final readiness verification

```bash
DRY_RUN=1 .harness/scripts/loop.sh 2>&1 | grep -iE "would build|nothing eligible|REFUS"  # next task; proves orphan won't be re-selected
gh auth status 2>&1 | grep -i "logged in"          # loop needs gh to gate CI
grep CI_WORKFLOW .harness/config/harness.env; grep -m1 '^name:' .github/workflows/ci.yml   # must match
git status --porcelain                              # empty -> startup guard passes
```

## 7. Commit, push, report

- Stage **only** the files you changed (`.harness/TASKS.json`, `.harness/ledgers/outcomes.jsonl`, any
  `worklog/<id>.md`). One commit, message explaining the interrupt-orphan recovery + what was fixed.
  `git push` (push after committing — always). Report the SHA.
- Finish with a concise **report**: a health table (processes / lock / tree / scratch / ledger / CI /
  dry-run) and a per-task line for every orphan fixed (or "none found"), plus anything **suspicious**
  you chose NOT to auto-fix (and why).

---

## Notes

- The root cause is recorded as a **known-but-deferred issue** in `.harness/CLAUDE.md`
  ("Known-but-deferred issues"): (1) an interrupt can orphan a merged task in `pending`; (2)
  `wait_ci_green` conflates "no CI run appeared" (a `[skip ci]` commit) with "CI failed", driving the
  revert loop. This command is the *recovery*; if interrupts keep causing this, that note is the
  signal to actually fix the loop (treat indeterminate CI ≠ red; detect already-merged work →
  `mark_done` instead of rebuilding).
- If you discover a NEW interrupt-related failure mode this runbook doesn't cover, add it here (and to
  the known-issues note) as part of the recovery.
