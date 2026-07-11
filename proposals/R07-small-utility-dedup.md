# R07: Small-utility dedup across workflows — `weekKey` ×3, JSON file helpers ×4, `readPortfolio` ×3, `PlexAllResponse` ×5, TMDB-GUID extraction ×4

**Type**: refactor · **Priority**: P3 · **Effort**: S
**Area**: workflows / core
**Affected files**: per item below; new `src/core/dates.ts`; additions to `src/core/plex-client.ts`

## Problem

Verbatim (sometimes self-confessed) small-helper copies across workflow folders:

1. **`weekKey` (ISO week) ×3**: `stock-digest/lib.ts`, `plex-space-saver/stages/scan.ts`
   (~15–22), `overrides-audit/stages/scan.ts` (~10–17) — the latter two literally comment
   "mirrors X's weekKey". `dayKey` oddly lives in `stocks-sync/stages/stocks-snapshot.ts` and is
   imported by sibling stages; `monthKey` variants exist in the monthlies.
2. **`readJsonFile`/`writeJsonFile`/`ensureDirs` ×4+**: movies, tv-recs, perfumes libs;
   plex-space-saver's `writeJsonFile`.
3. **Tolerant `readPortfolio` ×3**: `stocks-watch.ts` (~45–52), `stock-sector-lookup.ts`
   (~20–28), `stock-digest-build.ts` (~186–194).
4. **`interface PlexAllResponse<T> { MediaContainer?: { Metadata?: T[] } }` re-declared in 5
   workflows.**
5. **TMDB-GUID extraction + fetch-section-`/all?includeGuids=1` pattern ×4**:
   `movies/movies.ts`, `tv-recs/tv-shows.ts`, `missing-tv-seasons/plex.ts`,
   `plex-language-fix/lib.ts`.

## Proposed fix

- `src/core/dates.ts`: `weekKey`, `monthKey`, `dayKey` (unit-tested once, including the ISO-week
  year-boundary cases the copies risk diverging on).
- `src/core/fsjson.ts` (or fold into an existing core module): `readJsonFile`, `writeJsonFile`,
  `ensureDirs`.
- `src/core/plex-client.ts`: export `PlexAllResponse<T>`, `extractTmdbId`, and
  `fetchSectionMetadata<T>(section, opts)` — plex-client is already the blessed shared Plex
  home.
- Stocks: one `readPortfolio` in `stock-digest/lib.ts` (or a small shared stocks lib both
  workflows import — they already share the Trading212 service).

Keep it boring: pure moves + import updates, no behavior change. Do after R01 (which deletes
two of the copies wholesale).

## Acceptance criteria

- Grep finds one definition of each helper; all suites green; workflow outputs unchanged on
  fixtures.
- ISO-week boundary unit tests exist for `weekKey`.

## Test plan

Existing per-workflow tests are the regression net; add the dates tests.
