# CLAUDE.md — src/workflows/movies/

The folder is `movies`. The workflow's registered name is **`movie-recommendations`**. Both names
refer to the same thing.

## What it does

A monthly, taste-based Plex movie recommender. A snapshot stage reads the library, 8 Claude
branches each propose films from a different angle, a merge stage verifies every suggestion
against TMDB and balances the list, and a notify stage sends one digest of the picks that have
not been announced before.

The franchise-gap audit (films missing from a collection you partly own) is a separate workflow,
`missing-movies` (see `src/workflows/missing-movies/CLAUDE.md`). It has its own Plex snapshot and
its own schedule. This workflow has no `franchise-gaps` stage.

The owner can dismiss a recommendation from the dashboard (see "Ignore-to-suppress" below).

## DAG

```
movie-snapshot ──snapshot, taste──▶ 8 branches ──suggestions──▶ rec-merge ──recommendations──▶ movie-recs-notify
     └──────────────snapshot, taste──────────────────────────▲
```

The 8 branches are `rec-random-1`, `rec-random-2`, `rec-random-3`, `rec-auteur`, `rec-canon`,
`rec-thin-genre`, `rec-older-era` and `rec-world-cinema`. Each depends only on `movie-snapshot`.
`rec-merge` depends on all 8 branches and on `movie-snapshot`. `movie-recs-notify` depends on
`rec-merge`.

Scheduled monthly (`'0 9 1 * *'`, the 1st at 09:00), `maxConcurrency: 4`. Once `movie-snapshot`
finishes, the branches run up to 4 at a time. Each branch is its own child process running the
Claude CLI, and the cap keeps the Mac Mini from running 8 at once. The cap is not the spend
limit: every Claude call goes through the shared `claude-cli` service and every TMDB call through
the `tmdb` service, which meter usage across all processes.

Not limitable: no stage declares `inputKeys()`. The library is read live from Plex on every run.

## How the stages hand data to each other (ports)

This is a ports workflow (see "Ports" in the root `CLAUDE.md`), built the same way as `tv-recs`.
`movie-snapshot` is a `defineStage`. The branch, merge and notify stages come from the makers in
`src/core/recommender/stages.ts`. The artifact types come from `contracts.ts`
(`movieArtifacts = recommenderArtifacts(moviesDomain, 'movie', 'movies')`).

| Stage | Inputs | Outputs |
|---|---|---|
| `movie-snapshot` | none | `snapshot` (`movie-snapshot`, `snapshot.json`), `taste` (`movie-taste-profile`, `taste-profile.json`) |
| each `rec-*` branch | `snapshot`, `taste` | `suggestions` (`movie-branch-suggestions`, `recs/<branch>.json`) |
| `rec-merge` | `snapshot`, `taste`, `branches` (`movie-branch-suggestions`, `many`: one per branch) | `recommendations` (`movie-recommendations`, `recommendations.json`) |
| `movie-recs-notify` | `recommendations` | `report` (`movie-recs-report`, `reports/recommendations.md`), `digest` (`movie-recs-digest`, inline counts) |

All files are under `data/out/`.

- All 8 branches output the same artifact type, which is what lets the merge take them through
  one `many` input. The merge reads them with `ctx.inputs('branches')`: one handle per branch,
  each the file that branch committed in this run. It never pools whatever happens to be in
  `recs/`.
- The merge also takes `snapshot` and `taste` directly, which is why the manifest gives it an
  edge from `movie-snapshot`. It uses the snapshot to drop films already owned and the taste
  profile to re-prompt when the list is short.
- Every branch commits its file on every run that succeeds, even an empty one (a branch with
  nothing to ask, or one that hit a usage limit).
- No stage writes a ledger row so that the run page has something to show. The run page is drawn
  from what the engine recorded for each stage's inputs and outputs. A branch reports the films
  it put in its prompt through `ctx.input('snapshot').used(...)`.
- The one ledger is **`movie-recs`** (`RECS_JOB` in `recs.ts`), keyed by the recommended film's
  TMDB id. Note the job name is `movie-recs`, not the stage name `movie-recs-notify`. The notify
  stage writes a `success` row for each film it announces, and the dashboard writes `ignored`
  rows. The branches and the merge read it. So a film is announced once, and a dismissed film
  stays out.
- `movie-recs-notify` is marked `product: true` (it is also the last stage), so the workflow
  page's Output section shows its report.
- Besides the ledger, one file carries state across runs: `data/out/recs-history.json`. The
  notify stage appends each announced film to it, and the branches and the merge read it to
  steer prompts away from repeats. Both are declared on the stages as `state`, not as ports.

## Stage 1: `movie-snapshot`

Reads Plex library section `PLEX_MOVIE_SECTION` (default `4`) through `fetchSectionMetadata` in
the shared `src/core/plex-client.ts`. Each movie's TMDB id comes from its `tmdb://` GUID and is
never guessed. A movie with no such GUID is logged, keeps a null id, and so cannot be matched
against a recommendation. It still counts towards the taste profile. Writes:

- `data/out/snapshot.json`: every movie with its TMDB id, genres, directors, countries and
  ratings.
- `data/out/taste-profile.json`: counts per genre, director, decade and country across the whole
  library.

Both are rebuilt on every run. `timeoutMs` 5 minutes, `maxRetries: 3`.

The Plex read goes through the shared `plex` service (`callService('plex', ...)`) with a cache
key of `plex:<path>`, so a second read of the same section within the service's 3-hour cache
window is served from the cache. In tests, `fetchMeta` replaces the whole fetch and bypasses the
service. `plexFetch` replaces only the low-level GET, so the caching path can be tested without
a live Plex.

This snapshot is not shared with `missing-movies`, which builds its own. The two workflows have
no dependency on each other. Only this one builds a taste profile.

## Stage 2: the 8 recommender branches

Specs (id, lens, prompt) are in `stages/branches.ts`. Each branch is one stage, one child
process and one Claude CLI call:

- `rec-random-1/2/3` (lens `serendipity`): a stratified sample of the library, balanced across
  genres, with a different seed per branch.
- `rec-auteur` (`auteur-completion`): more films by directors the owner has at least 3 films by.
  Writes an empty list without calling Claude when no director qualifies.
- `rec-canon` (`top-genre-canon`): well-regarded films in the owner's 4 strongest genres.
- `rec-thin-genre` (`thin-genre`): films in the genres the owner has fewest of.
- `rec-older-era` (`older-era`): pre-1980 films.
- `rec-world-cinema` (`world-cinema`): non-English-language films.

A random branch is shown a stratified sample of `MOVIES_RECS_SAMPLE` (default 50) owned films. A
targeted branch is shown the owned films that match its lens, capped at the same number. Every
branch also gets the taste profile and the list of titles already recommended or dismissed
(`recs-history.json` plus the `ignored` rows of the `movie-recs` ledger, capped at
`MOVIES_RECS_HISTORY_CONTEXT`, default 200). It asks for `MOVIES_RECS_PER_BRANCH_ASK` (default
9) titles, more than the final list needs, because the merge drops some. Model:
`MOVIES_RECS_MODEL` (default `claude-sonnet-5`), called through `runClaude` in
`src/services/claude.ts`. `timeoutMs` 10 minutes, `maxRetries: 1`.

How a branch ends (shared `src/core/recommender/branch.ts`):

- A rate or usage limit, a reply that cannot be parsed, or a branch with nothing to ask: the
  branch writes an empty suggestions file (with an `error` note) and succeeds.
- Any other Claude failure (`spawn claude ENOENT`, a crash, a timeout): the branch throws. Its
  run is `failed`, and because the merge needs every branch, the merge and notify do not run.
  This is deliberate: an unset `LOCALJOBS_CLAUDE_BIN` once made every branch fail quietly and the
  workflow reported success with no recommendations. The daemon's launchd PATH is minimal, so
  `LOCALJOBS_CLAUDE_BIN` must be an absolute path in `.env`.

## Stage 3: `rec-merge`

Pools the suggestions of every branch that fed it this run, then:

1. Drops duplicate suggestions by normalised title and year before any lookup, keeping the first.
2. Searches TMDB for each title (`/search/movie` through `callService('tmdb', ...)`, cached per
   title and year). No match means the model made it up, and it is dropped.
3. Drops films already in the library.
4. Drops films already recommended or dismissed (`isWorkItemDone('movie-recs', <tmdbId>, 1)`).
5. Drops films below the quality bar: TMDB `vote_average` at least `MOVIES_RECS_MIN_RATING`
   (default 7.0) with `vote_count` at least `MOVIES_RECS_MIN_VOTES` (default 50).
6. Merges suggestions that resolve to the same TMDB id, joining their lens tags.
7. Balances by genre: at most `MOVIES_RECS_GENRE_CAP` (default 3) per genre, up to
   `MOVIES_RECS_TARGET` (default 15) in total.

If fewer than the target survive, a top-up loop runs for up to `MOVIES_RECS_TOPUP_ROUNDS`
(default 3) rounds. Each round re-prompts all 8 branches in memory (no files, up to
`MOVIES_RECS_TOPUP_CONCURRENCY` at once, default 4), excluding every title already considered
this run, then verifies and balances again. It stops when the target is reached, a round returns
nothing new, or TMDB's quota is hit.

A TMDB quota stop ends verification early and the stage still writes the (possibly short) list.
A search that errors for one title is skipped so the rest carry on, but if any search errored the
stage throws after writing `data/out/recommendations.json`, so the run fails and is retried.
`timeoutMs` 30 minutes, `maxRetries: 2`.

## Stage 4: `movie-recs-notify`

Reads the recommendations, removes anything the owner dismissed, and finds the films with no
done row in the `movie-recs` ledger. It rewrites `data/out/reports/recommendations.md` (all
current recommendations, new ones flagged) on every run. If there are new films it sends one
push, and only after the push succeeds does it mark each film `success` in the ledger and append
it to `recs-history.json`. A failed push throws before anything is marked, so the retry sends
the digest again. The first run announces the whole current list. Later runs announce only what
is new. `timeoutMs` 2 minutes, `maxRetries: 3`.

## Ignore-to-suppress (owner UI)

- `POST /api/movie-recs/:tmdbId/ignore` and `/unignore` (plus `/api/movie-recs/ignore-bulk` and
  `/unignore-bulk`), backed by `ignoreSurfacedItem('movie-recs', <tmdbId>)`. A dismissed film is dropped by the merge and left
  out of the report and every later digest.
- Un-ignoring deletes the ledger row. The film is then treated as new and can come back in a
  later digest.
- The controls are on the `movie-recommendations` workflow's dashboard page. Nothing is ignored
  automatically.
- The franchise-gap controls (`/api/movie-gaps/*`) belong to `missing-movies`.

## Shared recommender pipeline

The branch runner, the merge and the notify logic are not owned by this folder. They live in
`src/core/recommender/` (`types.ts`, `pure.ts`, `branch.ts`, `merge.ts`, `notify.ts`,
`stages.ts`) and are shared with `tv-recs`. Both workflows run the same code with a different
`RecommenderDomain` object. This folder keeps what is specific to movies:

- `stages/branches.ts`: the 8 branches' prompt text and the `moviesDomain` object (the TMDB
  `/search/movie` call, the TMDB movie-genre table, the digest wording, the push job and tags,
  the report heading and filename).
- `recs.ts`: re-exports of the shared pure helpers (`src/core/recommender/pure.ts`), plus
  `RECS_JOB`, `directorsOwnedAtLeast` and `genreNameFromIds`.
- `stages/recommend.ts`: `makeBranchJob(id)`, which each `rec-*.job.ts` file calls and which
  builds the stage with `makeBranchStage`. It also wraps the shared `runBranch` for the tests.
- `stages/merge.ts`, `stages/notify.ts`: wrappers over the shared `runMerge` and `runRecsNotify`
  with `moviesDomain` filled in. The stages do not use them (`merge.job.ts` and `notify.job.ts`
  call `makeMergeStage` and `makeNotifyStage` directly). They exist for the tests, which call the
  functions with explicit paths, and `notify.ts` also carries the compat re-export described
  below.
- `contracts.ts` is one line: this domain's artifact types.
- `config.ts` holds the env var names and defaults. The shared pipeline takes it as plain data
  (`domain.config`) and never reads `process.env` itself.

## Files, credentials, config

- `config.ts` (`moviesConfig`): the `data/out/` paths, the `MOVIES_RECS_*` tuning env vars and
  `PLEX_MOVIE_SECTION`. `gapsOut` is an alias into `missing-movies`'s config (see the compat shim
  below).
- `movies.ts`: pure helpers for the snapshot, the taste profile and collection gaps
  (`buildMovieSnapshots`, `buildOwnedSet`, `buildTasteProfile`, `collectionGaps`,
  `collectionOwnedExample`). `missing-movies` imports the snapshot and collection-gap helpers
  from here rather than copying them, and takes its `FranchiseGap*` and `MovieSnapshotFile` types
  from `types.ts`.
- Plex and TMDB access is the shared `src/core/plex-client.ts` (`plexGet`, `tmdbGet`,
  `fetchSectionMetadata`, `extractTmdbId`). It is not owned by this workflow. Nine workflows use
  it: `movie-recommendations`, `tv-recommendations`, `missing-movies`, `missing-tv-seasons`,
  `plex-space-saver`, `plex-library-guard`, `plex-language-fix`, `plex-profiles` and
  `plex-rename`.
- Services called: `plex` (snapshot), `claude-cli` (branches, and the merge's top-up), `tmdb`
  (merge).
- Credentials: `PLEX_HOST`, `PLEX_API_TOKEN`, `TMDB_API_TOKEN` (read by the shared client), and
  `LOCALJOBS_CLAUDE_BIN` for the Claude CLI. `PLEX_MOVIE_SECTION` is shared with `missing-movies`.

## Cross-workflow compat shim

`src/api/server.ts` still imports `NOTIFY_JOB` and `gapKey` from
`'../workflows/movies/stages/notify.js'` and reads `moviesConfig.gapsOut`, paths from before the
franchise-gap audit moved to `missing-movies`. So that `server.ts` did not have to change:

- `stages/notify.ts` re-exports `NOTIFY_JOB` and `gapKey` from `missing-movies`'s
  `stages/notify.js`, which is where they are defined.
- `moviesConfig.gapsOut` is an alias of `missingMoviesConfig.gapsOut`.

Neither changes behaviour. If `server.ts` is changed to import from `missing-movies` directly,
both can be deleted.
