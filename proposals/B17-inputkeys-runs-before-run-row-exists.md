# B17: `inputKeys()` runs in the daemon before the run row exists — a throw makes a 202-acknowledged manual run vanish; a hang wedges the workflow claim forever

**Type**: bug · **Priority**: P2 · **Effort**: S
**Area**: core
**Affected files**: `src/core/workflow-executor.ts` (~271–296), `src/api/server.ts` (~1098–1102)

## Problem

For a limited manual run:

```ts
if (opts.limit && opts.limit > 0) {
  const candidates = await getJobDefinition(rootStage)!.inputKeys!();   // user job code, in-daemon, unguarded
  selectedRoots = selectPendingRoots(...);
}
const workflowRunId = createWorkflowRun(def.name, trigger, runLimit, selectedRoots);  // row exists only AFTER
```

The API has already replied `202 { ok: true, message: 'workflow run started' }` before this
executes (fire-and-forget).

**Failure scenario 1 — throw**: `inputKeys()` reads a missing/corrupt `data/` file and throws →
`runWorkflowInner` throws before `createWorkflowRun` → the API's `.catch` logs to the daemon
console only. The user clicked Run, got a success response, and **no run appears anywhere** —
no `workflow_runs` row, no framework log, no notification. Maximum confusion.

**Failure scenario 2 — hang**: `inputKeys()` blocks on I/O (nothing forbids it — the type is
`Promise<string[]>`). The `startingWorkflows` claim taken in `runWorkflow` is only released when
`runWorkflowInner` settles → the workflow reports **409 "already has an active run"**
indefinitely, with no visible run to cancel and nothing in `activeWorkflowRuns` to abort. Only a
daemon restart recovers — and unlike B08, the dashboard shows *nothing* running, so there's no
clue why.

Note the daemon also runs gate `check()`s inline un-timed (a documented limitation in
`.harness/custom/docs/LIMITATIONS.md`) — same class; a fix here can share the bounded-execution
helper.

## Proposed fix

1. Create the workflow-run row FIRST, and do root selection inside the B08 try/catch — a
   throwing `inputKeys()` then produces a first-class **failed run** with the error in the run's
   framework log (mirroring the existing invalid-DAG failure path at ~236–242).
2. Bound `inputKeys()` with a timeout (e.g. 60 s via `Promise.race`) so a hang becomes a failed
   run, not a permanent claim.

## Acceptance criteria

- A throwing `inputKeys()` on a limited manual run yields a visible failed workflow run whose
  log names the error; the workflow is immediately re-runnable.
- A hanging `inputKeys()` fails the run after the bound; the `startingWorkflows` claim is
  released.

## Test plan

`workflow-executor.test.ts`: fake root job with (a) throwing and (b) never-resolving
`inputKeys()`; assert failed-run row + claim release + re-runnability.
