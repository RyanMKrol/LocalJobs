# B14: `hevy-sync` marks workouts synced BEFORE persisting them — a mid-run kill permanently loses workouts

**Type**: bug · **Priority**: P2 · **Effort**: S
**Area**: workflows (workouts-sync)
**Affected files**: `src/workflows/workouts-sync/stages/hevy-sync.ts` (~155–186)

## Problem

The sync loop does `newlyAppended.push(workout)` then
`markWorkItem(JOB_NAME, workout.id, 'success', …)` **per item**, but
`appendWorkoutsHistory(...)` — the write that actually persists the workouts to
`workouts-history.json` — runs once, AFTER the loop.

**Failure scenario**: crash / SIGKILL / the job's own `timeoutMs` (300 s) firing mid-run →
workouts are marked `success` in the ledger but were never written to the history file. Because
sync idempotency is ledger-keyed (`isWorkItemDone`), those workouts are **permanently skipped on
every future run — silent data loss** in the exact file that `workouts-progress` (stage 2)
computes the monthly report from. The report is then quietly wrong forever.

Secondary: the per-item `try/catch` wraps an array `push()` that can never throw — so the
`failed` path (~170–177) and the end-of-run throw are dead code (the job is only *nominally*
T416-compliant).

## Proposed fix

Invert the order: build the merged list, `writeFileSync` the history file FIRST, then loop
`markWorkItem('success')` for each newly-persisted workout. (Or checkpoint every N items like
places' `persist` helper if the file grows large — it won't; monthly workout counts are tiny.)
A duplicate re-append on the re-run after a crash between write and mark is impossible if the
merge dedupes by workout id — verify `appendWorkoutsHistory` dedupes (make it, if not).

Delete or make real the dead per-item failure path while there.

## Acceptance criteria

- Killing the process between the file write and the marks loses nothing: the next run re-marks
  the already-persisted workouts (dedupe by id) without duplicating them in the file.
- Killing the process before the file write leaves the ledger unmarked → next run re-fetches.
- No path exists where a ledger row is `success` but the workout is absent from the history file.

## Test plan

Unit test: simulate the interrupted orders (write-no-mark, and the old mark-no-write for
regression documentation) against a temp file + scratch DB; assert the invariant "ledger success
⇒ present in file" holds after a re-run.
