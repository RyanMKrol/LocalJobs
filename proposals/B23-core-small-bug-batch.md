# B23: Core small-bug batch — six bounded defects in executor/workflow-executor/services/plex-client

**Type**: bug (batch) · **Priority**: P3 · **Effort**: M (S each)
**Area**: core
**Affected files**: per item below. Each item is independently landable; they're batched because each is small and the fixes don't interact.

## 1. `repeatUntilStable`: `noopJobs` never reset between cycles → lying logs/labels

`src/core/workflow-executor.ts` (~320, 362–377). `const noopJobs = new Set<string>()` is
declared once before the cycle loop and only ever added to. Cycle 1: a stage noops → added.
Cycle 2: the same stage does REAL work → `onSettle` still sees stale membership → the ✓ success
log line is suppressed and the progress message says `(stage skipped (noop))` for work that
happened. Inverse skew too: `hasJobAdvancedAnyItem` queries the whole run, so a stage that
advanced anything in cycle 1 can never be flagged noop in later cycles.
**Fix**: clear `noopJobs` at the top of each cycle; scope the noop check per cycle (snapshot the
job's `work_item_runs` count before/after the stage).

## 2. `callService` cache: `undefined` result poisons an already-successful call; corrupt row throws instead of missing

`src/core/services.ts` (~127–148), `src/db/store.ts` (~1827–1852). `JSON.stringify(undefined)`
returns `undefined` (not a string) → better-sqlite3 throws binding it → a successful,
already-metered, possibly PAID call fails at the caching step and the item is marked failed.
Symmetrically `JSON.parse(row.response_json)` on a corrupt/truncated row throws out of
`callService` instead of being treated as a miss.
**Fix**: skip caching when `JSON.stringify` returns `undefined`; wrap the parse in try/catch →
return `undefined` (miss). Two lines each.

## 3. `resolvePlexHost` cache never invalidated on failure

`src/core/plex-client.ts` (~78–108, 343–386). `cachedHost` is process-lifetime and `plexGet`'s
error path rejects "Plex unreachable at ${host}" WITHOUT clearing it — the exact DHCP-change
failure the resolver exists to heal becomes unhealable within a process. Harmless today only
because all Plex calls happen in short-lived job children; any future daemon-side Plex call (a
dashboard endpoint, a gate check) inherits a stale-forever cache.
**Fix**: clear `cachedHost` on connection-level failure before rejecting. Also: the timeout
error gets re-wrapped into a misleading "unreachable" message — preserve the timeout cause.

## 4. NDJSON `result: success` honored despite nonzero exit code

`src/core/executor.ts` (~208–211). In the `close` handler, `resultStatus === 'success'`
resolves success **regardless of exit code**. The child only legitimately exits 0 on success
(`emitResultAndExit(…, 0)`), so a success-event + nonzero-exit disagreement is pure forge-or-bug
signal being ignored (any dependency that `console.log`s a result-shaped object can end the run
"successfully" while the job continues).
**Fix**: honor `result: success` only when `code === 0`; otherwise record failed with a
"result/exit disagreement" error. Two lines.

## 5. `runJob.ts`: floating `main()` promise; pre-try store throw degrades the recorded error

`src/runJob.ts` (~40–60). `getWorkflowRunRoots(wfRunId)` (a DB read) runs OUTSIDE the try/catch
that emits the structured failure event, and `main();` has no `.catch`. A DB open/read throw
kills the child via unhandled rejection — the parent still records a failure from stderr +
generic "exited without reporting a result", but the real cause is buried.
**Fix**: move the roots load inside the try, or
`main().catch(e => emitResultAndExit({ type:'result', status:'failed', error: String(e?.stack ?? e) }, 1))`.

## 6. `executeDag` stall-safety break can yield a silent false-success aggregate

`src/core/dag.ts` (~276–278), `src/core/workflow-executor.ts` (~434–442). The "impossible"
stall branch (`nothing runnable and nothing in flight`) breaks the loop quietly; un-run members
are simply absent from the status map, and `runWorkflowInner` computes
`statuses.every(s => s === 'success')` over the PARTIAL set — a workflow that never ran half its
stages can settle **success** if a future indegree regression ever fires the branch.
**Fix**: before returning, if `!hooks.signal?.aborted && status.size < dag.nodes.length`, call
`onSkip`/record `'failed'` for each missing node (guard on the signal — the cancelled path
legitimately leaves members absent).

## Acceptance criteria / test plan

One focused unit test per item (workflow-executor cycle labels; services cache
undefined/corrupt; plex-client cache invalidation; executor exit-code disagreement; runJob
pre-try throw via bad `LOCALJOBS_DB`; dag stall branch with a hand-broken indegree map). All
existing suites stay green.
