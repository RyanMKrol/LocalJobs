# F08: Workflow-level timeout — per-job timeouts exist, but a workflow can legally run for hours and block its own next runs

**Type**: feature · **Priority**: P2 · **Effort**: S
**Area**: core
**Backlog cross-ref**: not tracked.

## Problem

`JobDefinition.timeoutMs` kills a hung *stage*, but `WorkflowDefinition` has no wall-clock
bound. A `repeatUntilStable` workflow (perfumes: up to 40 cycles × 4 stages × ~12s-paced
fetches × 5-minute Claude calls) or an 11-stage fan-out can run for hours while every
individual stage stays under ITS timeout; a pathological run then blocks the next scheduled run
indefinitely via the one-active-run guard. T112's no-forward-progress stop covers only the
cycling case, not e.g. retry loops that each stay under per-stage timeouts.

The enforcement machinery ALREADY exists end-to-end: the `workflowRunId → AbortController`
registry, `cancelWorkflowRun`, and the abort threading that hard-kills the in-flight child and
records `cancelled`.

## Design sketch

`workflowTimeoutMs?: number` on `WorkflowDefinition` (0/absent = none):

```ts
// in runWorkflow, after registering the controller:
const t = def.workflowTimeoutMs ? setTimeout(() => {
  addWorkflowLog(id, `workflow timeout after ${…} — aborting`, 'error');
  controller.abort();
}, def.workflowTimeoutMs) : null;
// cleared in the existing finally
```

On timeout-abort, record the run with a distinct error ("timed out after Xh") — either as
`cancelled` with that message, or add `'timeout'` to `WorkflowRunStatus` for honest history
(preferred; the dashboard status maps already handle per-status labels). ~30 lines. Set
generous values only on the unbounded-shaped workflows (perfumes, the two recommenders).

Interaction: B08 must land first/together (a timeout abort exercising the same paths must not
hit the escaped-exception wedge).

## Acceptance criteria

- A workflow exceeding its `workflowTimeoutMs`: in-flight child hard-killed, run recorded with
  the timeout-distinct status/message, next scheduled run starts normally.
- Workflows without the field: zero behavior change.

## Test plan

`workflow-executor.test.ts`: fake slow stage + tiny workflowTimeoutMs → assert
kill/status/re-runnability; no-field regression case.
