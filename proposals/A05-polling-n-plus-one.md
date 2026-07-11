# A05: Dashboard polling endpoints are N+1 heavy — ~150 statements and ~16 DAG re-derivations per 5-second tick; status-only scans lack an index

**Type**: arch/perf · **Priority**: P3 · **Effort**: M
**Area**: api / db
**Affected files**: `src/api/server.ts` (~332–392), `src/db/store.ts` (`memberWorkflowMap`/`getWorkflowJobs` ~1243–1260, `stuckItems`/`ignoredItems` ~823–828/~965–970), `src/db/schema.sql` (~71)

## Problem

Each `GET /api/jobs` poll runs: `listJobs()` + per-job `lastRunForJob` + `stuckCount`
(2 × ~60 jobs) + `memberWorkflowMap()` = `listWorkflows()` × `getWorkflowJobs()` — and **each**
`getWorkflowJobs` builds + topologically sorts a DAG. `GET /api/workflows` is similar. Net:
≈150 statements + ~16 DAG constructions per 5 s dashboard tick, forever.

Also: `stuckItems()`/`ignoredItems()` filter on bare `status`, but the only index is
`(job_name, status)` — full scans of a 6k-row (and growing, see A01) table per Overview poll.

Fine on local SQLite today; flagged because it compounds with unbounded table growth (A01) and
the single-query alternatives are easy.

## Proposed fix

1. One `GROUP BY job_name` query replaces the ~60 per-job `stuckCount` calls; one
   window-function (or `MAX(started_at)` join) query replaces per-job `lastRunForJob`.
2. Workflow membership + DAG order are static between registry syncs — compute once at sync,
   cache in-process (invalidate on `syncWorkflow`), stop re-deriving per request.
3. Add a `(status)` index on `work_items` (or reorder the composite) — inside a migration per
   the T098 rule if the column predates it (it doesn't — `status` is original, so schema.sql +
   migration-safe either way; verify).

## Acceptance criteria

- `GET /api/jobs` and `/api/workflows` execute a bounded, small number of statements regardless
  of job count (assert via a statement-count spy or better-sqlite3 hooks in a test).
- Responses byte-identical to today for the same data.
- `EXPLAIN QUERY PLAN` for `stuckItems` shows index use.

## Test plan

Existing `server.test.ts` response-shape tests stay green (they pin the contract); add the
statement-count regression test.
