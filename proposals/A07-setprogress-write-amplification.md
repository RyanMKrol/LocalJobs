# A07: `setProgress` write amplification — every per-item progress event triggers a workflow roll-up that can no longer change anything

**Type**: arch/perf · **Priority**: P3 · **Effort**: S
**Area**: db / core
**Affected files**: `src/db/store.ts` (`setProgress` ~150–159, `rollUpWorkflowProgress` ~1325–1355)

## Problem

Every `ctx.progress()` NDJSON event costs: UPDATE runs + SELECT workflow_run_id +
`rollUpWorkflowProgress` (SELECT workflow_name + COUNT over `workflow_jobs` + a
correlated-subquery scan over the run's member runs + another UPDATE). The item-loop convention
tells jobs to report progress **per item** — a 600-item Plex stage emits 600 events → ~3,000
statements per stage, times up to 4 concurrent stages, all contending with the children's own
ledger writes.

This is the single biggest contributor to the SQLITE_BUSY exposure that makes B08/B09 live —
and it's pure overhead: since the completed-stages roll-up change, the workflow bar counts
**only terminal stages** ("no partial credit"), so a mid-run progress event **cannot change the
workflow percentage**. The value only moves when a member settles — which `onSettle` already
triggers. The comment in `setProgress` ("so the workflow reflects in-flight member progress")
describes the superseded behavior.

## Proposed fix

Drop the `rollUpWorkflowProgress` call (and the stale comment) from `setProgress` — `onSettle`'s
call is the one that matters. If any in-flight indicator is ever wanted back, throttle instead
(roll up at most once per N seconds per run). Optionally also throttle the per-event
`UPDATE runs.progress` itself (e.g. skip if unchanged integer percent), which halves the
remaining writes for chatty loops.

## Acceptance criteria

- Workflow progress behavior unchanged: bar steps in 100/N increments exactly on stage
  completion (the existing `workflow-executor.test.ts` completed-stages test, ~line 151, passes
  unmodified).
- Per-item `ctx.progress` still updates the member run's own progress bar.
- Statement count per progress event drops from ~6 to ≤2.

## Test plan

Existing progress tests green; add a statement-count assertion around a burst of progress events
(spy or better-sqlite3 statement hook).
