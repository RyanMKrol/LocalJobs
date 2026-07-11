# B16: `franchise-gaps` quota-hit mid-scan silently overwrites last month's gaps report with an empty one — "no franchise gaps" is then a lie

**Type**: bug · **Priority**: P2 · **Effort**: S
**Area**: workflows (movies)
**Affected files**: `src/workflows/movies/stages/franchise-gaps.ts` (~84–93, 100, 133–139)

## Problem

Pass 1 (walk the library, one TMDB `/movie/{id}` call per owned movie — the repo's largest
TMDB consumer) breaks out on `QuotaExceededError`:

```ts
quotaHit = true; break;
```

Pass 2 (collection completion checks) is then skipped (`if (!quotaHit)`), so `gaps` stays `[]` —
and the stage still runs `writeJsonFile(gapsFile, { …, gaps: [], … })`, **overwriting last
month's complete audit with an empty list**. The run *succeeds*, `movie-gaps-notify` reads the
empty file, and the monthly report claims "_No franchise gaps — every collection you own a film
from is complete._" — factually wrong, replacing the previous good report, with nothing re-running
for a month. Per-movie errors in the same loop are also swallowed (warn + continue, no tally —
part of the B13 retrofit).

## Proposed fix

Pick one (first preferred — honest failure + free retry):

1. On `quotaHit`, `throw` a summarizing error before writing the file — the gate/DAG then blocks
   `movie-gaps-notify` from consuming a partial artifact, `maxRetries` re-attempts (the next
   day's quota may allow completion; if not, the next monthly run does), and last month's file
   survives intact.
2. Or write `{ partial: true, ... }` and make `movie-gaps-notify` preserve the prior report and
   suppress the "no gaps" claim when `partial` is set.

Longer-term the quota pressure itself shrinks dramatically by caching the mostly-static
`belongs_to_collection` mapping (see F16 — per-workflow improvements; relates backlog T477/T479
response-caching decisions).

## Acceptance criteria

- A quota hit during pass 1 leaves the previous `gaps` file untouched and produces no "no gaps"
  digest claim.
- A clean run still writes the full file and notifies as today.

## Test plan

`franchise-gaps.test.ts` exists — add a case where the TMDB fake throws `QuotaExceededError`
partway: assert the file on disk is unchanged (or `partial: true` per chosen fix) and the run's
outcome matches the chosen semantic.
