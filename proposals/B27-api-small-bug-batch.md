# B27: API small-bug batch — reset-output TOCTOU, HTTP-semantics fixes, `markWorkItem` atomicity

**Type**: bug (batch) · **Priority**: P3 · **Effort**: S–M
**Area**: api / db
**Affected files**: per item. Independently landable.

## 1. TOCTOU: reset-output's active-run check is separated from the wipe by an `await`

`src/api/server.ts` (~1302–1325; also `reset-output-all` ~1256–1292).
`workflowRunInProgress(name)` check → `await findWorkflowDataOut(name)` (yields the event loop —
a croner tick can start a scheduled run of this exact workflow in that window) →
`resetWorkflowOutput(name)` then deletes the fresh run rows out from under the live executor;
the executor's later `UPDATE runs …` silently matches 0 rows and `markWorkItem` re-populates the
just-cleared ledger.
**Fix**: re-check `workflowRunInProgress` synchronously immediately before the transaction (no
`await` between check and wipe), or perform the check inside the transaction.

## 2. Assorted incorrect HTTP semantics

`src/api/server.ts`, various:
- `POST /workflows/:name/toggle` never 404s (~1159–1163) — unknown workflow → `200 {ok:true}`
  (0-change UPDATE); every sibling endpoint 404s. Same for `GET /api/jobs/:name/runs` (~880–882)
  → `200 {runs: []}` for a nonexistent job.
- OPTIONS returns **204 with a JSON body** (~412 — `json(res, 204, {})`); RFC 9110 forbids
  content on 204. Use `res.writeHead(204).end()`.
- `decodeURIComponent(parts[4])` on the gate routes (~1002–1003, ~1395–1396) throws `URIError`
  on `%zz` → blanket 500 instead of 400. Wrap and 400.
- The blanket 500 handler returns `err.message` to the client (~1558) — can leak absolute
  filesystem paths, contradicting the topology-leak care taken at ~1498. Return a generic
  message; log the detail server-side.
- Several routes match `parts[n]` without a path-length check (`/jobs/:name/runs`,
  `/workflows/:name/runs`, `/jobs/:name/prune`) so over-long paths still match. (Fixed
  structurally by R03's route table; patch the worst offenders if R03 doesn't land first.)

## 3. `markWorkItem` is three statements with no wrapping transaction

`src/db/store.ts` (~494–546). The ledger upsert, the `work_item_runs` linkage insert, and the
root-resolution read run un-wrapped. A SIGKILL between the upsert and the linkage insert (the
executor's timeout path genuinely hard-kills children) leaves a ledger row with no run
attribution — the Stage I/O panel under-reports that run.
**Fix**: wrap the body in `db.transaction(…)` (synchronous, cheap — `ignoreSurfacedItems`
already does exactly this).

## Acceptance criteria

- Toggle/job-runs on unknown names → 404. OPTIONS → bodyless 204. `%zz` in a gate path → 400.
  500 responses carry no `err.message`.
- A reset cannot interleave with a run start (test with a monkey-patched
  `findWorkflowDataOut` that starts a run mid-await — assert 409).
- `markWorkItem` is atomic (kill between statements impossible by construction).

## Test plan

Extend `server.test.ts` per semantic; a store test asserting `markWorkItem` runs inside one
transaction (e.g. spy on `db.transaction` or induce a linkage failure and assert rollback).
