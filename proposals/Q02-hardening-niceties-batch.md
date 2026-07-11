# Q02: Hardening-niceties batch — constant-time token compare, LIKE-wildcard escaping, a route listing, error-body slicing

**Type**: quality (batch) · **Priority**: P3 · **Effort**: S
**Area**: api / db / services

## Items

1. **Token compare is `===`, not constant-time** (`src/api/server.ts` ~312). Use
   `crypto.timingSafeEqual` (length-guarded). Low practical risk on loopback, one-line fix.
2. **Global-logs `q` filter treats `%`/`_` as wildcards** (`src/db/store.ts` ~299–302, 350–353).
   Parameterized (no injection) but `q=%` matches everything — escape user input and add
   `ESCAPE '\'` for literal-substring semantics.
3. **No route listing**: with R03's route table, `GET /api` returning
   `[{method, pattern}]` is ~5 lines — a poor man's OpenAPI that makes the API self-describing
   for future sessions/agents at near-zero cost.
4. **Duplicate query**: `GET /api/workflows/:name` calls `getWorkflow(p.name)` a second time
   (~978) while already holding the row. Harmless; drop it.
5. **Unsliced upstream error bodies in thrown errors** (`src/services/trading212.service.ts`
   `fetchPortfolio`/`fetchInstrumentsMetadata`): errors embed the FULL `await res.text()` —
   safe with Trading212 today, but if any API ever echoes auth material into error bodies it
   lands verbatim in run logs. Slice to ~300 chars like `claude.ts` already does; sweep other
   services for the same pattern.

## Acceptance criteria

Each item verified by a small unit test where testable (2, 5) or by inspection (1, 3, 4);
`server.test.ts` / `store.test.ts` green.
