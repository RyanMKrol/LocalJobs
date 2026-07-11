# B06: `readBody` swallows malformed JSON as `{}` → destructive/lossy defaults; no body-size cap

**Type**: bug · **Priority**: P2 · **Effort**: S
**Area**: api
**Affected files**: `src/api/server.ts` (`readBody` ~315–324; consumers throughout)

## Problem

```ts
catch { return {}; }
```

turns any JSON parse failure into a *meaningful request*, and several endpoints give `{}`
dangerous semantics:

- `POST /api/workflows/:name/toggle` with a garbage body → `!!undefined` → **disables the
  workflow** (~1159–1163).
- `POST /api/stuck/unstick-bulk` → `{}` → scope **all** (see B05).
- `POST /api/services/:name/limits` → all fields treated as null → **caps removed** on a paid
  service (see B07).
- `POST /api/workflows/:name/run` → `limit` dropped → an intended limited run silently becomes
  unlimited (full paid corpus processing for places).

Additionally `readBody` buffers the request with **no size cap** (unbounded memory on a hostile
or accidental large body) and never checks `Content-Type` (which feeds the B02 CSRF surface).

## Proposed fix

- Distinguish empty body (legitimately `{}` — several endpoints accept bare POSTs) from a
  non-empty body that fails to parse → **400** `{ error: 'invalid JSON body' }`.
- Cap the buffered body at ~1 MB; destroy the request and return 413 beyond that.
- (With B02) require `Content-Type: application/json` when a non-empty body is present.

## Acceptance criteria

- `POST /api/workflows/x/toggle` with body `not-json` → 400, workflow's enabled state unchanged.
- Bare/empty-body POSTs to endpoints that accept them still work.
- A >1 MB body → 413 without buffering it all.

## Test plan

Add malformed-body cases for toggle, limits, run, and unstick-bulk to `server.test.ts`; one
oversized-body case.
