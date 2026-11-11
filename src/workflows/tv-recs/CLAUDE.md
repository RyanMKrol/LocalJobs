# CLAUDE.md — src/workflows/tv-recs/

The folder is `tv-recs`. The workflow's registered name is **`tv-recommendations`**. It is separate
from `missing-tv-seasons` (`src/workflows/missing-tv-seasons/`), which only audits missing seasons
and recommends nothing.

## What it does

A monthly TV show recommender with the same shape as `movies` (`movie-recommendations`): a
snapshot, 8 Claude branches, a merge that takes all of them, and a notify stage.

```
tv-snapshot ──snapshot, taste──▶ 8 branches ──suggestions──▶ tv-rec-merge ──recommendations──▶ tv-recs-notify
     └──────────────snapshot, taste──────────────────────────▲
```

The 8 branches are `tv-rec-random-1`, `tv-rec-random-2`, `tv-rec-random-3`, `tv-rec-creator`,
`tv-rec-canon`, `tv-rec-thin-genre`, `tv-rec-older-era` and `tv-rec-world`. Each depends only on
`tv-snapshot`. `tv-rec-merge` depends on all 8 branches and on `tv-snapshot`. `tv-recs-notify`
depends on `tv-rec-merge`.

Scheduled monthly (`'0 9 1 * *'`, the 1st at 09:00), `maxConcurrency: 4`, so the branches run up
to 4 at a time. Not limitable: no stage declares `inputKeys()`, and the library is read live from
Plex on every run.

## How the stages hand data to each other (ports)

This is a ports workflow (see "Ports" in the root `CLAUDE.md`). `tv-snapshot` is a `defineStage`.
The branch, merge and notify stages come from the makers in `src/core/recommender/stages.ts`. The
artifact types come from `contracts.ts` (`tvArtifacts = recommenderArtifacts(tvDomain, 'tv', 'shows')`).

| Stage | Inputs | Outputs |
|---|---|---|
| `tv-snapshot` | none | `snapshot` (`tv-snapshot`, `snapshot.json`), `taste` (`tv-taste-profile`, `taste-profile.json`) |
| each `tv-rec-*` branch | `snapshot`, `taste` | `suggestions` (`tv-branch-suggestions`, `recs/<branch>.json`) |
| `tv-rec-merge` | `snapshot`, `taste`, `branches` (`tv-branch-suggestions`, `many`: one per branch) | `recommendations` (`tv-recommendations`, `recommendations.json`) |
| `tv-recs-notify` | `recommendations` | `report` (`tv-recs-report`, `reports/tv-recommendations.md`), `digest` (`tv-recs-digest`, inline counts) |

All files are under `data/out/`.

Things that follow from that, and are worth keeping:

- **The merge depends on `tv-snapshot` directly.** It reads the snapshot (to drop shows already
  owned) and the taste profile (to re-prompt when short), so the manifest gives it that edge.
  Every read is an edge.
- **The merge gets its branch files from the engine, not from the directory.** All 8 branches
  output the same artifact type, and the merge takes them through one `many` input.
  `ctx.inputs('branches')` returns one handle per branch, each the file that branch committed in
  this run. A file left in `recs/` by a removed branch, or by an earlier run of a branch that
  failed this time, is never merged.
- **Every branch commits its file on every run that succeeds, even an empty one.** A branch that
  hits a usage limit writes an empty suggestions list. A branch that returned without writing
  would fail with "declared output was not written this run".
- **No stage writes a ledger row to be visible.** The run page is drawn from the engine's record
  of what each stage was handed and what it committed. A branch reports the sample of the library
  it put in its prompt through `ctx.input('snapshot').used(...)`, which the run page shows as
  "Used 40 of 650".
- **The one ledger is `tv-recs`** (`RECS_JOB` in `recs.ts`), keyed by the recommended show's TMDB
  id. Note the job name is `tv-recs`, not the stage name `tv-recs-notify`. The notify stage
  writes a `success` row for each show it announces and the dashboard writes `ignored` rows. The
  branches and the merge read it. Those rows are what the notify stage lists as its items on a
  run page, with fields from the stage's `describeItem`.
- `tv-recs-notify` is marked `product: true` (it is also the last stage), so the workflow page's
  Output section shows its report.
- Besides the ledger, one file carries state across runs: `data/out/recs-history.json`. The
  notify stage appends each announced show to it, and the branches and the merge read it to steer
  prompts away from repeats. Both are declared on the stages as `state`, not as ports.

## Stages

**`tv-snapshot`** reads the TV library section (`PLEX_TV_SECTION`, default `5`) through
`fetchSectionMetadata` in the shared `src/core/plex-client.ts`. It builds one entry per show with
its TMDB id (from the `tmdb://` GUID, never guessed) and taste metadata, and a taste profile:
counts per genre, role, decade and country across the library. Writes `data/out/snapshot.json`
and `data/out/taste-profile.json`, both rebuilt on every run. `timeoutMs` 5 minutes,
`maxRetries: 3`.

**The 8 branches** (specs in `stages/branches.ts`) are one stage, one child process and one
Claude CLI call each:

- `tv-rec-random-1/2/3` (lens `serendipity`): a stratified sample of the library, balanced across
  genres, with a different seed per branch.
- `tv-rec-creator` (`creator-completion`): more shows featuring people the owner has at least 3
  shows with (up to 8 names). The names come from the taste profile's `roles`, which are Plex's
  `Role` tags. Writes an empty list without calling Claude when nobody qualifies.
- `tv-rec-canon` (`top-genre-canon`): well-regarded shows in the owner's 4 strongest genres.
- `tv-rec-thin-genre` (`thin-genre`): shows in the 5 genres the owner has fewest of.
- `tv-rec-older-era` (`older-era`): pre-2000 shows.
- `tv-rec-world` (`world-tv`): non-English-language shows.

A random branch is shown a stratified sample of `TV_RECS_SAMPLE` (default 40) owned shows. A
targeted branch is shown the owned shows that match its lens, capped at the same number. Every
branch also gets the taste profile and the titles already recommended or dismissed
(`recs-history.json` plus the `ignored` rows of the `tv-recs` ledger, capped at
`TV_RECS_HISTORY_CONTEXT`, default 200). It asks for `TV_RECS_PER_BRANCH_ASK` (default 9)
suggestions, more than the final list needs, because the merge drops some. Model:
`TV_RECS_MODEL` (default `claude-sonnet-5`). `timeoutMs` 10 minutes, `maxRetries: 1`.

**A branch's Claude failure is not swallowed (shared `src/core/recommender/branch.ts`).** A rate
or usage limit, a reply that cannot be parsed, or a branch with nothing to ask writes an empty
suggestions file (with an `error` note) and the branch succeeds. Any other Claude failure
(`spawn claude ENOENT`, a crash, a timeout) means the branch produced nothing, so `runBranch`
throws: the branch run is `failed`, and because the merge needs every branch, the merge and
notify do not run. This fixed a real incident where an unset `LOCALJOBS_CLAUDE_BIN` made every
branch `ENOENT`, yet the workflow reported success with zero recommendations. The daemon's
launchd PATH is minimal, so `LOCALJOBS_CLAUDE_BIN` must point at an absolute `claude` path in
`.env`.

**`tv-rec-merge`** pools the suggestions of every branch that fed it this run, drops duplicates
by normalised title and year, then for each title: searches TMDB (`/search/tv` through
`callService('tmdb', ...)`, cached per title and year; no match means the model made it up),
drops shows already owned, drops shows already recommended or dismissed (the `tv-recs` ledger),
and applies the quality bar (TMDB `vote_average` at least `TV_RECS_MIN_RATING` [7.0] with
`vote_count` at least `TV_RECS_MIN_VOTES` [50]). Suggestions that resolve to the same TMDB id are
merged, joining their lens tags. The list is then balanced: at most `TV_RECS_GENRE_CAP` [3] per
genre, up to `TV_RECS_TARGET` [15] in total. If it is short, a top-up loop re-prompts all 8
branches in memory for up to `TV_RECS_TOPUP_ROUNDS` [3] rounds (`TV_RECS_TOPUP_CONCURRENCY` [4]
at once), excluding every title already considered this run. Writes
`data/out/recommendations.json`. A TMDB quota stop ends verification early and the list is still
written. If any TMDB search errored, the stage writes the list and then throws, so the run fails
and is retried. `timeoutMs` 30 minutes, `maxRetries: 2`.

**`tv-recs-notify`** removes anything the owner dismissed, finds the shows with no done row in
the `tv-recs` ledger, and rewrites `data/out/reports/tv-recommendations.md` (all current
recommendations, new ones flagged) on every run. If there are new shows it sends one push, and
only after the push succeeds does it mark each show `success` in the ledger and append it to
`recs-history.json`. A failed push throws before anything is marked, so the retry sends the
digest again. `timeoutMs` 2 minutes, `maxRetries: 3`.

**Recs-history rows.** Each appended row is `{ tmdbId, title, year, at }`, the same shape `movies`
uses. Older rows that have only `{ title, year }` still load and are left as they are. The
prompts only use `title` and `year`.

## Ignore / un-ignore

A recommended show can be dismissed from the dashboard and brought back later:
`POST /api/tv-recs/:tmdbId/ignore` and `/unignore` (plus `/api/tv-recs/ignore-bulk` and
`/unignore-bulk`), backed by `ignoreSurfacedItem` / `unignoreSurfacedItem` on the `tv-recs`
ledger, keyed by the show's TMDB id. See the root
`CLAUDE.md`'s "Ignore-to-suppress" notes for the mechanism. Un-ignoring deletes the row, so the
show is treated as new and can be announced again.

## Shared recommender pipeline

The branch runner, the merge and the notify logic are not owned by this folder. They live in
`src/core/recommender/` (`types.ts`, `pure.ts`, `branch.ts`, `merge.ts`, `notify.ts`,
`stages.ts`) and are shared with `movies` (`src/workflows/movies/`, the `movie-recommendations`
workflow). Both workflows run the same code with a different `RecommenderDomain` object. This
folder keeps what is specific to TV:

- `stages/branches.ts`: the 8 branches' prompt text and the `tvDomain` object (the TMDB
  `/search/tv` call, the TMDB TV-genre table, the digest wording, the push job and tags, the
  report heading and filename, and `extraNotifyDetail`: a TV ledger row's `detail` also carries a
  `tmdbUrl`, which a movie row's does not).
- `recs.ts`: re-exports of the shared pure helpers (`src/core/recommender/pure.ts`), plus
  `RECS_JOB` and `creatorsOwnedAtLeast` (keyed by `profile.roles`, where movies use
  `profile.directors`).
- `stages/recommend.ts`: `makeBranchJob(id)`, which each `tv-rec-*.job.ts` file calls and which
  builds the stage with `makeBranchStage`. It also wraps the shared `runBranch` for the tests.
- `stages/tv-rec-merge.ts`, `stages/tv-recs-notify.ts`: wrappers over the shared `runMerge` and
  `runRecsNotify` with `tvDomain` filled in. The stages do not use them (`tv-rec-merge.job.ts`
  and `tv-recs-notify.job.ts` call `makeMergeStage` and `makeNotifyStage` directly). They exist
  for the tests, which call the functions with explicit paths.
- `tv-shows.ts`: pure helpers that build the per-show snapshot and the taste profile.
- `contracts.ts` is one line: this domain's artifact types.
- `config.ts` holds the env var names and defaults. The shared pipeline takes it as plain data
  (`domain.config`) and never reads `process.env` itself.

## Files, credentials, services

- `config.ts` (`tvRecsConfig`): the `data/out/` paths, the `TV_RECS_*` tuning env vars above,
  `tvSection`, and a `host` field kept only for a log line. Plex and TMDB access itself is in the
  shared client.
- Stage files: `stages/tv-snapshot.job.ts` and `stages/tv-snapshot.ts`, the 8
  `stages/tv-rec-<branch>.job.ts` files, `stages/tv-rec-merge.job.ts`,
  `stages/tv-recs-notify.job.ts`.
- Credentials: `PLEX_HOST`, `PLEX_API_TOKEN`, `TMDB_API_TOKEN` (read by the shared
  `src/core/plex-client.ts`, which nine workflows use), and `LOCALJOBS_CLAUDE_BIN` for the Claude
  CLI. There is no credential specific to this workflow.
- Services called: `plex` (snapshot), `claude-cli` (branches, and the merge's top-up), `tmdb`
  (merge).

**The Plex read is response-cached.** `tv-snapshot`'s fetch goes through `callService('plex', ...)`
with a cache key of `plex:<path>`, so a second read of the same section within the `plex`
service's 3-hour cache window (for example another Plex workflow run just before) is served from
the cache. In tests, `fetchMeta` replaces the whole fetch and bypasses the service. `plexFetch`
replaces only the low-level GET, so the caching path can be tested without a live Plex.
