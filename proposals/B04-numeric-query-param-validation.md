# B04: `limit`/`after`/`windowHours` query params unvalidated — NaN → 500, negative → full-table dump

**Type**: bug · **Priority**: P2 · **Effort**: S
**Area**: api
**Affected files**: `src/api/server.ts` (~428–431, 437, 1346–1356), `src/db/store.ts` (`listRecentRuns` ~219–226, `listRecentWorkflowRuns` ~1378–1385)

## Problem

`GET /api/runs` and `GET /api/workflow-runs` parse their `limit` as
`const limit = Number(url.searchParams.get('limit') ?? 50)` with no clamping. Empirically
verified against better-sqlite3 by the reviewing agent:

- `?limit=abc` → `NaN` → binding NaN to `LIMIT ?` throws **`datatype mismatch`** → blanket 500.
- `?limit=-1` → SQLite treats a negative LIMIT as *no limit* → **returns every row** of the two
  highest-churn tables in one response.
- `?limit=1000000000` is accepted verbatim.

The `after` param (~437 / ~1356) silently binds NaN as a no-match, and `?windowHours=abc`
produces `datetime('now','-NaN hours')` → NULL → a silently empty result where a 400 is the
honest answer.

The correct idiom already exists in the same file: `/api/logs` clamps its params
(~464–467) — these endpoints just don't use it.

## Proposed fix

Extract a helper and use it for every numeric query param in `server.ts`:

```ts
function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = Number(raw ?? def);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
}
```

- `limit`: clamp to [1, 500] (default 50).
- `after`: `Number.isFinite` or ignore the param.
- `windowHours`: clamp to [1, 24*90] or 400 on non-numeric.

Sweep the file for other `Number(url.searchParams…)` sites while there.

## Acceptance criteria

- `?limit=abc` → 200 with the default 50 rows (or 400 — pick one convention and apply it
  file-wide), never a 500.
- `?limit=-1` → clamped small result, never a full-table dump.
- Existing `/api/logs` behavior unchanged.

## Test plan

Extend `server.test.ts` with the NaN/negative/huge cases for `/api/runs` and
`/api/workflow-runs` (the `/api/logs` clamp tests are the model).
