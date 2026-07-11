# B08: An exception escaping `runWorkflowInner` permanently wedges the workflow (stuck `running` row, uncancellable, blocks all future runs until daemon restart)

**Type**: bug · **Priority**: P0 · **Effort**: M
**Area**: core
**Affected files**: `src/core/workflow-executor.ts` (~229–457, esp. 296–298, 323–421, 443), `src/core/dag.ts` (~264–273), `src/api/server.ts` (~1101, cancel endpoint ~1371–1381), `src/db/store.ts` (`hasActiveWorkflowRun` ~1408–1412)

## Problem

`runWorkflowInner` creates the workflow-run row, then executes the DAG inside a
`try { … } finally { activeWorkflowRuns.delete(workflowRunId); }` — **no `catch`** — and
`finishWorkflowRun(workflowRunId, status)` sits *after* the try/finally:

```ts
const workflowRunId = createWorkflowRun(def.name, trigger, runLimit, selectedRoots);
const controller = new AbortController();
activeWorkflowRuns.set(workflowRunId, controller);
try {
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    lastStatuses = await executeDag(dag, { ... });   // ← can reject
  }
} finally {
  activeWorkflowRuns.delete(workflowRunId);
}
finishWorkflowRun(workflowRunId, status);            // ← never reached on throw
```

`executeDag` rejects whenever `runOne`/`onSettle`/`onSkip` reject (dag.ts:
`hooks.runOne(job).then((s) => settle(job, s, false))`, surfaced by
`await Promise.race(inflight.values())`). `runOne` is not exception-proof: it calls
`createRun`/`finishRun`/`addLog` (via `runAttempts`), `recordGateFailure`,
`hasJobAdvancedAnyItem`/`setRunNoop`, and `onSettle` calls `rollUpWorkflowProgress` — all
synchronous better-sqlite3 writes that throw on `SQLITE_BUSY` after the 5 s `busy_timeout`
(`src/db/index.ts`), disk-full, or any I/O error. `addWorkflowLog` inside the `log` closure is
another writer on the same path.

## Failure scenario

1. A child job process holds a long write transaction >5 s while the daemon's
   `rollUpWorkflowProgress` fires → the daemon-side statement throws `SQLITE_BUSY`.
2. `executeDag` rejects → `runWorkflowInner` throws → `finishWorkflowRun` is skipped. The
   `workflow_runs` row stays `status='running'` forever.
3. On the manual path the API swallows it (`runWorkflow(...).catch(e => console.error(...))`,
   server.ts:1101). Nothing else happens.
4. From now on `workflowRunInProgress(name)` is permanently true via `hasActiveWorkflowRun` →
   every manual start gets **409 "already has an active run"**, every scheduled fire is skipped.
5. The run can't be cancelled: the cancel endpoint looks the id up in `activeWorkflowRuns`, which
   the `finally` already cleared → **409 "not active in this process"**.
6. Only recovery: daemon restart (`reapOrphanWorkflowRuns`). On an unattended always-on box this
   is a silent, indefinite outage of one workflow. Any in-flight member children at the moment of
   the throw keep running unobserved (orphaned `runOne` promises).

## Proposed fix

1. Wrap the body of `runWorkflowInner` from `createWorkflowRun` onward in try/catch: on catch,
   `addWorkflowLog(id, 'framework error: …', 'error')` (best-effort), `controller.abort()` (kills
   in-flight children via the existing cancel path), `finishWorkflowRun(id, 'failed')`
   (best-effort), then rethrow/return.
2. Make `executeDag` treat a rejected `runOne` as a `'failed'` settle rather than a poison pill:
   `.then(s => settle(job, s, false), () => settle(job, 'failed', false))` — one bad stage then
   can't abort the whole DAG's bookkeeping.
3. (See A07/B09 for reducing the SQLITE_BUSY exposure that makes this live.)

## Acceptance criteria

- A `runOne` that REJECTS (not "returns failed") still produces: a finished workflow run
  (`failed`), aborted in-flight members, and a subsequent run of the same workflow starting
  normally without a daemon restart.
- A store call that throws inside `onSettle` cannot leave a permanently-`running` workflow row.

## Test plan

`workflow-executor.test.ts` covers failing *statuses* but never a *rejecting* `runOne` or a
throwing store call — add both: (a) a fake job whose executor hook rejects; (b) monkey-patched
`rollUpWorkflowProgress` that throws once. Assert run row terminal + re-runnable.
