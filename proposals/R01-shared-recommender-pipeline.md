# R01: Extract a shared recommender pipeline — movies ↔ tv-recs duplicate ~1,300 lines across 6 file pairs, and the copies have already diverged into real bugs

**Type**: refactor/arch · **Priority**: P1 · **Effort**: L
**Area**: workflows (movies, tv-recs) + core
**Affected files**: see table; new `src/core/recommender/` module

## Problem

The two recommender workflows are near-total copies. Measured (diff counts = changed lines; the
rest byte-identical):

| movies file | tv-recs file | total lines | diff lines | duplicated content |
|---|---|---|---|---|
| `movies/recs.ts` (191) | `tv-recs/recs.ts` (166) | 357 | 67 | `mulberry32`, `seededShuffle`, `stratifiedSample`, `normTitle`, `dedupeRawByTitleYear`, `balanceByGenre`, `mergeLens`, `topGenres`, `thinGenres` byte-identical; only `directorsOwnedAtLeast`↔`creatorsOwnedAtLeast` + types differ |
| `movies/stages/recommend.ts` (223) | `tv-recs/stages/recommend.ts` (218) | 441 | 97 | `parseSuggestions`, `recentTitles`, `allHistoryTitles`, `ignoredSuggestionTitles`, `writeBranchFile`, `runBranch`, `collectBranchSuggestions`, `makeBranchJob` — diffs are config/type names/strings |
| `movies/stages/merge.ts` (387) | `tv-recs/stages/tv-rec-merge.ts` (377) | 764 | 210 | `runBounded`, `poolBranchSuggestions`, `verifyInto`, `buildDefaultTopUp`, top-up loop + summary — differ only in search endpoint (`/search/movie` vs `/search/tv`, `year` vs `first_air_date_year`), genre-id table, and the searchFailed divergence |
| `movies/stages/branches.ts` (292) | `tv-recs/stages/branches.ts` (295) | — | structurally identical | same 8-branch shape; `rules()`, `avoidBlock`, `lensOwnedBlock`, owned-subset helpers duplicated |
| `movies/stages/notify.ts` (286) | `tv-recs/stages/tv-recs-notify.ts` (175) | — | partial | digest/report/appendHistory duplicated (movies adds the gaps half) — **diverged on the push-failure guard** |
| `movies/stages/snapshot.ts` (59) | `tv-recs/stages/tv-snapshot.ts` (80) | — | near-identical | fetch → buildSnapshots → taste-profile → write |
| `movies/lib.ts` | `tv-recs/lib.ts` | 28 | 0 meaningful | `ensureDirs`/`readJsonFile`/`writeJsonFile` verbatim |

The duplication has already produced **real divergence defects**: the tv-recs missing
push-failure guard (B11), the rec-merge missing searchFailed throw (B13 item), undocumented
config drift (movies model default `claude-sonnet-5` vs tv `claude-sonnet-4-6`), and
history-schema drift (movies rows `{tmdbId, title, year, at}` vs tv `{title, year}` — blocking
future id-based dedup). Every future fix must be remembered twice; B11 proves it isn't.

## Proposed design

Generic recommender pipeline at `src/core/recommender/` — `src/core` is the established
cross-workflow home (cf. `plex-client.ts`), and the registry only globs
`*.job.ts`/`*.workflow.ts` so nothing there gets auto-discovered:

```ts
// src/core/recommender/types.ts
export interface RecommenderMedia { title: string; year: number | null; genres: string[]; }
export interface RecommenderDomain<M extends RecommenderMedia, P> {
  id: string;                       // 'movie-recs' | 'tv-recs' → ledger keyspace
  branches: BranchSpec<M, P>[];
  paths: { snapshot; taste; history; recsDir; recsOut; reportDir };
  tuning: { model; sampleSize; ask; target; genreCap; minRating; minVotes;
            topUpRounds; topUpConcurrency; recentWindow; historyContext };
  search(title: string, year: number | null): Promise<TmdbSearchHit | null>;  // /search/movie vs /search/tv
  genreName(ids: number[] | undefined): string;   // movie vs tv genre table
  itemsOf(snapshot: unknown): M[];                // snapshot.movies vs snapshot.shows
  tmdbUrl(id: number): string;
}
// pure.ts   — the byte-identical pure helpers (already generic)
// branch.ts — parseSuggestions, runBranch(ctx, domain, spec), collectBranchSuggestions, makeBranchJob(domain, id)
// merge.ts  — runMerge(ctx, domain, opts) with UNIFIED searchFailed+throw semantics
// notify.ts — runRecsNotify(ctx, domain, opts) with the push-ok-then-mark guard baked in
```

Each workflow keeps: its `config.ts` (env names), a `branches.ts` shrunk to lens prompt text +
domain wiring, thin `*.job.ts` wrappers, its own contracts. Movies keeps franchise-gaps and
composes its combined digest around `runRecsNotify`'s rec half. While unifying, align the
history schema on the movies shape (`{tmdbId, title, year, at}`) and either align or explicitly
document the model-default difference.

Net deletion ≈ 1,100 lines; the existing test pairs collapse into one generic suite + two thin
domain suites.

## Sequencing

Land the behavioral bug fixes FIRST as small commits (B11, B13's rec-merge backport) so the
refactor is behavior-preserving and reviewable; the extraction then structurally prevents their
recurrence. Also fixes by construction: C-03 history drift, C-04 model drift.

## Acceptance criteria

- Both workflows produce identical artifacts (branch files, merged recs, digests) for a fixed
  snapshot + seeded RNG before/after the refactor (golden-file comparison in tests).
- One implementation of merge/notify semantics; grep finds no duplicated copy of the pure
  helpers.
- Both workflows' CLAUDE.mds updated (docs-as-Done); update `_dashboard-harness.mjs` only if any
  job names change (prefer keeping names stable so ledger/history continuity is untouched).

## Test plan

Golden-run test per domain with fixed seed + fixture snapshot; keep the existing per-stage tests
running against the thin wrappers until parity is proven, then consolidate.
