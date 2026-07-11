# B07: `POST /api/services/:name/limits` — a missing field means NULL means "cap removed" on paid services

**Type**: bug · **Priority**: P2 · **Effort**: S
**Area**: api / db
**Affected files**: `src/api/server.ts` (~1517–1540), `src/db/store.ts` (`updateServiceLimits` ~1543–1566), `src/db/schema.sql` (~195–197)

## Problem

The endpoint conflates *absent* with *explicitly null*:

```ts
if (v === null || v === undefined || v === '') limits[f] = null;
```

and in the schema NULL = **no cap**. So a partial body `{ rate_per_minute: 10 }` — or an
empty/malformed body via B06 — sets `daily_cap = monthly_cap = NULL` on the service. Worse, the
edit flips `limits_overridden = 1`, so every subsequent code-sync **preserves** the uncapped
state (`upsertServiceStmt`, `store.ts` ~1485–1497) instead of restoring the code defaults.

The service quota is documented as "the SOLE spend governor" for the paid APIs (Gemini, Google
Places). One sloppy POST silently removes the only thing standing between a bug/retry-loop and
unbounded spend, permanently (until a human notices the override).

## Proposed fix

Pick one (first is simpler and matches the dashboard, which always sends all four fields):

1. **Require all four keys present** (`rate_per_minute`, `daily_cap`, `monthly_cap`, plus
   whatever the endpoint accepts) — 400 if any is absent; null must be sent explicitly to mean
   "remove this cap".
2. Or merge absent keys from the current row (PATCH semantics).

Either way: when a `paid = 1` service would end up with `monthly_cap IS NULL`, log a loud
warning line on the daemon and include a `warning` field in the response — removing a paid cap
should never be silent.

## Acceptance criteria

- `{ rate_per_minute: 10 }` alone no longer nulls the daily/monthly caps.
- Explicitly `{ ..., monthly_cap: null }` still removes the cap (intentional act), with a warning
  in the response for paid services.
- The override-preservation behavior (`limits_overridden`) is unchanged.

## Test plan

`server.test.ts` covers valid updates + type rejection; add the partial-body case and the
paid-service-null-cap warning case.
