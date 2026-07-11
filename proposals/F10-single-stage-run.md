# F10: Manual single-stage run — largely mitigated by ledger idempotency; the residual gap is re-verifying a fix without re-spending a full pipeline pass

**Type**: feature · **Priority**: P3 · **Effort**: M
**Area**: core / api / dashboard
**Backlog cross-ref**: not tracked (T094's run-limit bounds *roots*, not stages — orthogonal).

## Problem (honestly assessed)

Only whole workflows can run (`POST /api/workflows/:name/run`; T070 removed per-job run BY
DESIGN — this proposal does not reintroduce standalone jobs, only a scoped variant of a
workflow run). The mitigation is real: ledger idempotency means a full re-run naturally skips
done items, so "re-run from failed stage" mostly falls out for free. The residual pain:

- Audit-shaped workflows deliberately RE-COMPUTE their early stages fresh every run
  (missing-tv-seasons, the recommender snapshots) — retrying a failed terminal notify stage
  re-walks Plex and re-spends TMDB/Claude budget.
- "Did my fix to stage 3 work?" costs a full pipeline pass.

Operator convenience, not owner-daily need. Honestly fine to leave unbuilt; specified for when
the friction bites.

## Design sketch

`POST /api/workflows/:name/run { onlyJobs: ['stage-name'] }`:

- `runWorkflow` filters the DAG to the named member(s); gates still enforce against the
  producer artifacts already on disk (that's the point — a stale/absent upstream artifact fails
  the gate loudly instead of running on garbage).
- Recorded as a normal workflow run flagged partial-scope in `progress_msg` (honest history; no
  schema change).
- Validation: unknown job name → 400; a job whose consumed keys have no on-disk artifact fails
  its gate, not silently.
- UI: a small "Run only this stage" button on the read-only `/jobs/[name]` member view,
  dev-tool tone (or omit UI entirely and keep it curl-only — owner's call).

## Acceptance criteria

- Running only a terminal notify stage consumes the existing artifacts and sends/marks exactly
  as a full run's final stage would; no upstream stage spawns.
- Gate failure path: delete the upstream artifact → the scoped run records a gate-failure run,
  nothing executes.

## Test plan

`workflow-executor.test.ts`: scoped run of stage 3 of a 3-stage fixture workflow — assert only
one child, gates evaluated, run row flagged.
