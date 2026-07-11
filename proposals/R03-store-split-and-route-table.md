# R03: `store.ts` god module (2,152 lines) + `server.ts` single-function router (~1,150-line if/else chain)

**Type**: refactor · **Priority**: P2 · **Effort**: L
**Area**: db / api
**Affected files**: `src/db/store.ts` (whole), `src/api/server.ts` (~399–1561)

## Problem

1. **`store.ts`**: ~110 exports across ≥8 domains (runs/logs, work items + lineage, workflows,
   services + meter + cache, stuck/ignored, admin resets, DB browser leftovers). The convention
   is "all SQL lives in the db layer" — it says nothing about ONE FILE. At 2,152 lines it's the
   repo's largest file; unrelated domains share scroll-space and merge-conflict surface.
2. **`server.ts`**: one ~1,150-line request callback of ~55 sequential `if` blocks with
   positional matching (`parts[3] === 'run'`). This has already produced loose matches — e.g.
   `GET /api/workflows/:name/runs` matches **any** path length — and route-order correctness is
   maintained by comments. Several B27 semantics bugs are structural consequences.

## Proposed fix

1. Split `store.ts` by domain with a barrel re-export so ~60 import sites are untouched:
   ```
   src/db/store/{runs,workItems,workflows,services,admin}.ts
   src/db/store.ts   → export * from './store/runs.js'; …
   ```
   Pure file moves — zero logic change; keep `db` connection sharing as-is.
2. A tiny route table in `server.ts` — no framework, keeping the deliberate no-dependency
   choice:
   ```ts
   const routes: Route[] = [
     { method: 'GET',  pattern: '/api/workflows/:name/runs', handler: h.workflowRuns },
     { method: 'POST', pattern: '/api/workflows/:name/run',  handler: h.runWorkflow },
     ...
   ];
   // ~20-line matcher: split pattern, exact-length match, ':' segments → params
   ```
   Exact-length matching kills the loose-path bugs class; ordering becomes irrelevant; the
   table doubles as a machine-readable route listing (see Q02's `GET /api` nicety). Handlers
   move to small per-domain files mirroring the store split.

## Sequencing

Do this AFTER (or bundled carefully with) the behavioral API fixes (B04–B07, B27) so behavior
changes aren't buried inside a move-everything diff — or land the route table first and the
fixes as follow-ups; either order, never both in one commit.

## Acceptance criteria

- `npm test` + `tsc` green with zero behavioral diffs (the extensive `server.test.ts` /
  `store.test.ts` suites are the safety net — they pin response shapes).
- No route matches a path with extra segments (add a regression test).
- CLAUDE.md file map updated (docs-as-Done).

## Test plan

The existing ~100-case `server.test.ts` and ~broad `store.test.ts` ARE the test plan; add the
route-matcher unit tests (exact length, param extraction, 404 fallthrough).
