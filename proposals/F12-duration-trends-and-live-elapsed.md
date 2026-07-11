# F12: Run-duration baseline + live elapsed time — "this run is taking 3× normal" is invisible, and running rows show "—"

**Type**: feature · **Priority**: P3 · **Effort**: S
**Area**: db / api / dashboard
**Backlog cross-ref**: not tracked. Merges two independent findings (feature review + dashboard review).

## Problem

Every run row stores `duration_ms`, and the dashboard shows each run's own duration — but never
a baseline, so a quietly-degrading workflow (perfumes cycling more, Plex walks slowing, Claude
timeouts causing silent retries) is invisible until hard failure. Separately, a RUNNING run
shows "—" for duration (`duration_ms` is null until finish) even though the pages re-render
every poll tick — the live case is the most useful one.

## Design sketch

1. **Baseline**: `typicalWorkflowDuration(name)` in `store.ts` — median `duration_ms` of the
   last 10 succeeded runs; exposed as `typical_duration_ms` on `GET /api/workflows/:name` (and
   per-job on the job view if cheap). No schema change.
2. **UI**: beside a finished run's duration, "typical: 12m"; amber tint when a finished run
   exceeded 2× typical. On a RUNNING run: compute elapsed client-side from `started_at`
   (`fmtDuration(Date.now() − parse(started_at))`) and show "12m elapsed · typically 4m" — the
   at-a-glance "something's wrong" signal.
3. Requires Q05's `fmtDuration` hours fix for honest display of long runs.

## Acceptance criteria

- Running rows show live-updating elapsed time on the run/workflow-run pages.
- A run > 2× median renders visibly distinct; workflows with < 3 completed runs show no
  baseline rather than a garbage one.
- Mobile-check green.

## Test plan

Store test for the median (including the <3-runs guard); fixture + visual check for both
states.
