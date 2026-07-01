---
description: Read-only pre-flight check-in on the harness backlog before starting an unattended loop.sh / supervise.sh run
argument-hint: (optional) a task id to focus on, e.g. T215 — omit for a full sweep
---

You are vetting the autonomous build harness (`.harness/loop.sh`, run via `.harness/supervise.sh`)
**BEFORE** the owner starts an unattended run. This is the pre-run mirror of
`.claude/commands/loop-recover.md` — but where that command diagnoses AND FIXES state after an
interrupt, this command only **looks and reports**. It never changes anything.

Focus target: `$ARGUMENTS` (if a task id is given, narrow check 1 and check 4 to it but still run
the global checks 2 and 3; if empty, do a full sweep of the backlog).

---

## ⚠️ Guardrails (read-only / advisory-ONLY — do not violate)

- **You MUST NOT edit `.harness/TASKS.json`.** Not `status`, not `facets`, not anything — this
  command only reads it.
- **You MUST NOT write, commit, or push ANY file.** No worklog entries, no `.harness/outcomes.jsonl`
  rows, no scratch files. This is purely observational.
- **You MUST NOT touch `.harness/reviews.json`, `.harness/human-done.json`, or
  `.harness/manual-fail.json`.** Those are dashboard/owner-owned overlay files; you only ever READ
  them (to check whether a needs-human blocker is about to auto-reconcile).
- **You MUST NOT run any destructive or mutating git command** — no `commit`, `push`, `add`, `reset`,
  `clean`, `restore`, `checkout --`, `rebase`, branch create/delete. `git status`/`git log`/`git
  fetch`/`git rev-list`/`git rev-parse` (read-only) are fine.
- If you notice something that genuinely needs fixing, **report it** — do not fix it here. Point the
  owner at `/loop-recover` (if it's interrupt-shaped state damage) or at hand-editing the backlog
  themselves.

---

## 1. Needs-human tasks blocking buildable work

Find every `gate:"needs-human"` task that appears in the `dependsOn` array of some `pending`,
`gate:null` (buildable) task, and check whether it's about to self-resolve via the owner-done overlay.

```bash
# every needs-human task id
jq -r '.tasks[]|select(.gate=="needs-human")|.id' .harness/TASKS.json

# for each needs-human id NH, find buildable blockees
jq -r --arg nh "T<id>" '.tasks[]|select(.status=="pending" and .gate==null and (.dependsOn // [] | index($nh)))|.id' .harness/TASKS.json

# is NH already marked done by the owner (about to auto-reconcile on next loop pre-flight)?
jq -r --arg nh "T<id>" '.[$nh].done // false' .harness/human-done.json 2>/dev/null || echo "false"
```

For each needs-human blocker with ≥1 buildable dependent, report:
- the blocker id + how many/which tasks it blocks,
- whether `.harness/human-done.json` already has `done:true` for it — if so, note it will
  auto-reconcile to `status:"done"` on the loop's next pre-flight (`reconcile_overlays` in
  `loop.sh`) and unblock its dependents **on its own, no action needed**,
- if NOT yet marked done, flag it as **owner action needed now** — otherwise the loop will idle on
  that branch of the DAG for the whole run.

If `$ARGUMENTS` names a task id, narrow this check to blockers that (transitively) gate that task.

## 2. Session hygiene — uncommitted / unpushed work, running loop, lock state

```bash
git fetch origin --quiet
git status --porcelain                                    # dirty tree?
git status -sb | head -1                                   # ahead/behind summary
git rev-list --count origin/main..HEAD                     # unpushed commits
git rev-list --count HEAD..origin/main                     # commits you're behind on

ps aux | grep -iE "loop\.sh|supervise\.sh|claude -p|runJob" | grep -v grep || echo "✓ no loop process running"

GC="$(git rev-parse --git-common-dir)"; case "$GC" in /*) ;; *) GC="$(pwd)/$GC";; esac
LOCK="$GC/$(basename "$(pwd)")-loop.lock"
ls -la "$LOCK" 2>/dev/null && cat "$LOCK/pid" 2>/dev/null || echo "✓ no repo lock held"
```

Report:
- dirty tree — yes/no (if yes, list the paths; a run refuses to start on a dirty tree),
- ahead/behind counts vs `origin/main`,
- **if a `loop.sh`/`supervise.sh` process is alive OR the lock is held by a live PID** — say so
  plainly and recommend **NOT** starting a second run (T105's "one active run" guard is per-workflow
  inside the daemon, it does NOT prevent two `loop.sh` processes stepping on each other's git state).
- if the lock dir exists but its `pid` is dead, note it as stale (a human/`/loop-recover` can clear
  it — do not clear it yourself here).

## 3. Dependency short-circuits (informational only)

Best-effort heuristic: flag `dependsOn` edges that are already effectively resolved because their
target is already `done` — harmless, but worth knowing since that edge no longer constrains
scheduling.

```bash
jq -r '
  .tasks as $all
  | ($all | map({(.id): .status}) | add) as $status
  | $all[]
  | select(.status != "done")
  | . as $t
  | ($t.dependsOn // [])[]
  | select($status[.] == "done")
  | "\($t.id) depends on \(.) which is already done"
' .harness/TASKS.json
```

List every match found (or "none found"). Do **not** attempt to rewrite `dependsOn` arrays — this is
purely informational, a human can decide whether to prune the edge.

## 4. Per-task definition quality

For every `pending`, non-`needs-human` task (or just the focus task if `$ARGUMENTS` names one), check:

```bash
# a) facets present with a layer + workType drawn from facets.json's vocabulary
jq -r '.tasks[]|select(.status=="pending" and .gate==null)
  |select((.facets|not) or (.facets.layer|not) or (.facets.workType|not))|.id' .harness/TASKS.json

VALID_LAYERS="$(jq -r '.facets.layer.values|keys[]' .harness/facets.json)"
VALID_WORKTYPES="$(jq -r '.facets.workType.values|keys[]' .harness/facets.json)"
# then for each task with facets present, confirm .facets.layer is in VALID_LAYERS
# and .facets.workType is in VALID_WORKTYPES — flag any that aren't

# b) spec file exists
jq -r '.tasks[]|select(.status=="pending" and .gate==null)|[.id,.spec]|@tsv' .harness/TASKS.json \
  | while IFS=$'\t' read -r id spec; do [ -f "$spec" ] || echo "$id: missing spec file $spec"; done

# c) spec has non-empty '## Do' and '## Done when' sections
#    for each existing spec file: confirm both headers appear and each has content before the next header

# d) scope is a non-empty array
jq -r '.tasks[]|select(.status=="pending" and .gate==null)
  |select((.scope|type != "array") or (.scope|length==0))|.id' .harness/TASKS.json
```

Report every task that fails any of (a)-(d), naming which specific check failed.

---

## Final report — go / no-go

Consolidate everything above into ONE report the owner can read in one glance before starting a run:

- **Needs-human blockers**: table of blocker id → blocked task ids → auto-resolving (yes/no).
- **Session hygiene**: dirty tree? ahead/behind? loop already running / lock held?
- **Dependency short-circuits**: list or "none found".
- **Task definition quality**: list of tasks with issues, or "all clear".
- **Verdict**: a plain **GO** (safe to start `.harness/supervise.sh`) or **NO-GO** (name the blocking
  issue(s) and what the owner should do — e.g. "mark T210 done in the dashboard first", "a loop
  process is already running, don't start another", "run `/loop-recover` first"). If everything is
  clean but there are informational-only notes (short-circuits, auto-resolving blockers), say **GO
  with notes**.

Remember: you changed nothing. If asked to fix anything found here, direct the owner to
`/loop-recover` (interrupt-shaped state damage) or a manual edit — never do it from this command.
