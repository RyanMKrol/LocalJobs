# A06: Run pages re-download the FULL log list every poll tick — the `after` cursor exists end-to-end and no call site uses it

**Type**: arch/perf · **Priority**: P2 · **Effort**: S
**Area**: dashboard
**Affected files**: `dashboard/app/lib/api.ts` (~443, 510–513), `dashboard/app/runs/[id]/page.tsx` (~13, 33–37), `dashboard/app/workflow-runs/[id]/page.tsx` (~52), the gate page (~122)

## Problem

The API and the client wrapper both support incremental log fetches (`?after=<id>`), but **no
call site ever passes `after`** — every tick refetches every line since run start:

- `runs/[id]/page.tsx` polls at **1000 ms**;
- `workflow-runs/[id]/page.tsx` and the gate page at 2000 ms.

With the repo's deliberately maximalist logging convention ("kilobytes of logs per run is
completely fine") a multi-thousand-line run re-transfers and re-renders its entire log **every
second**, plus a per-tick `logs.filter` count recompute. The correct pattern already exists in
the same codebase: `logs/page.tsx` (~72–81) accumulates in state and merges incremental pages.

## Proposed fix

On the three run-scoped pages: keep logs in state, poll with `after = <last seen id>`, append,
and derive the level counts incrementally (or memoize on length). ~15 lines per page following
the logs-page merge pattern. Reset the cursor when the run id changes.

Note: pair with the usePoll out-of-order guard (Q04) — incremental appends make ordering
correctness matter slightly more.

## Acceptance criteria

- Network tab during a live run shows small incremental responses after the first fetch, not the
  full log each second.
- Log rendering (order, levels, counts) identical to today, including across a page reload
  mid-run.

## Test plan

The api.ts wrapper already supports `after` — add a pure test for the merge/dedupe helper if
extracted; otherwise visual-check a live (fixture-driven) run page and assert via the harness's
route interception that subsequent requests carry `after`.
