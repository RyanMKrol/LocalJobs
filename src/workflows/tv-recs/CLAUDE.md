# CLAUDE.md — src/workflows/tv-recs/

Folder name is `tv-recs`; the workflow's registered name is **`tv-recommendations`** — distinct from
`missing-tv-seasons` (`src/workflows/missing-tv-seasons/`), which only audits missing seasons and does
no recommending.

## What it does

A standalone TV show recommender, mirroring `movies`' (`movie-recommendations`) fan-out shape. DAG:
`tv-snapshot → (8 recommender branches) → tv-rec-merge → tv-recs-notify`. Scheduled monthly (1st,
09:00, `'0 9 1 * *'`), `maxConcurrency: 4`. Not limitable — no member declares `inputKeys()`; inputs
are discovered live from Plex each run.

## Stages

**`tv-snapshot`** connects to Plex via the shared `src/core/plex-client.ts` (`fetchSectionMetadata`,
a thin wrapper over `plexGet` for the `/library/sections/<n>/all` pattern, T586), reads the TV
library section (`PLEX_TV_SECTION`, default `5`), builds a per-show snapshot keyed by TMDB GUID, and
computes a taste profile (genres/roles/decades/countries) from the owned library. Writes
`data/out/snapshot.json` + `data/out/taste-profile.json`.

**8 recommender branches** fan out in parallel off `tv-snapshot`: 3 random-serendipity branches
(`tv-rec-random-1/2/3`) plus 5 targeted branches — `tv-rec-creator` (favourite showrunners/creators),
`tv-rec-canon` (acclaimed/canonical picks), `tv-rec-thin-genre` (genres underrepresented in the owned
library), `tv-rec-older-era` (older decades), `tv-rec-world` (international/non-English shows). Each
branch is a Claude CLI call (`TV_RECS_MODEL`, default `claude-sonnet-4-6`) shown a stratified sample of
the owned library (`TV_RECS_SAMPLE`, default 40 shows) and asked for `TV_RECS_PER_BRANCH_ASK` (default
9) suggestions — headroom before the merge stage's dedup/quality filter.

**`tv-rec-merge`** (`tmdbGet` via the same shared client) TMDB-verifies every suggestion, dedupes
against the owned library and recommendation history, enforces a quality bar (TMDB `vote_average` ≥
`TV_RECS_MIN_RATING` [7.0] with `vote_count` ≥ `TV_RECS_MIN_VOTES` [50]), balances the list (max
`TV_RECS_GENRE_CAP` [3] per genre), and tops up via a bounded re-prompt loop (`TV_RECS_TOPUP_ROUNDS`
[3] rounds, up to `TV_RECS_TOPUP_CONCURRENCY` [4] concurrent branch re-prompts per round) until it
reaches `TV_RECS_TARGET` (default 15) or exhausts the rounds. Recent recommendations
(`TV_RECS_RECENT_WINDOW`, default 40) and history titles (`TV_RECS_HISTORY_CONTEXT`, default 200) are
fed back into branch prompts so re-prompts don't just re-suggest the same shows. Writes
`data/out/recommendations.json`.

**`tv-recs-notify`** sends ONE monthly digest of new picks — announce-exactly-once via the `tv-recs`
ledger (a show's tmdb id, once recorded, is never re-notified), drops owner-ignored shows (see below),
writes a markdown report to `data/out/reports/tv-recommendations.md`, and appends notified shows to
the history file (the same history `tv-rec-merge` reads back for re-prompt context).

**Combined per-run visibility ledger row (T571).** `tv-snapshot`, each of the 8 recommender branches,
and `tv-rec-merge` each record ONE combined `work_items` row per run (keyed by the run's ISO date, so
a same-day manual re-run upserts the same row), describing what that stage produced — snapshot:
`{ name, shows, path: snapshot.json, format: 'json' }`; each branch: `{ name, suggestions,
path: recs/<branch-id>.json }` (recorded under the branch's own job name); merge: `{ name, balanced,
path: recommendations.json, format: 'json' }`. This is PURELY for the run page's Input/Output panel
(`StageIoPanel`) — these stages still re-scan/re-compute fresh every run (the row is not a work-done
gate). The `tv-recs-notify` announce-once ledger is separate and unchanged.

**Recs-history row schema (T560).** Each appended history row is `{ tmdbId, title, year, at }` —
aligned with `movies`' (`movie-recommendations`) `RecsHistoryFile` shape, so a single shared notify
pipeline can be extracted and future id-based history dedup is possible. The parse stays tolerant of
LEGACY 2-field `{ title, year }` rows written before T560 (they load without error and are left
untouched — no `tmdbId`/`at` is fabricated); the re-prompt context only consumes `title`/`year`, so
old rows keep working.

## Ignore / un-ignore

A recommended show can be permanently dismissed from the dashboard (ignore) and reversed later
(un-ignore) — same `ignoreSurfacedItem`/`unignoreSurfacedItem` mechanism shared by all four
recommendation/audit ledgers in this repo (movie franchise gaps, movie recs, TV recs, missing TV
seasons); see root `CLAUDE.md`'s "Ignore-to-suppress" convention for the full mechanism. Ledger key is
the recommended show's tmdb id.

## Shared recommender pipeline (T561)

The recommender machinery (branch runner, merge verify/dedup/balance/top-up, notify
digest/report/history) is **not owned by this folder** — it's generic across domains and lives in
`src/core/recommender/` (`types.ts`, `pure.ts`, `branch.ts`, `merge.ts`, `notify.ts`), shared with
`movies` (`src/workflows/movies/`, the `movie-recommendations` workflow). This folder keeps only
what's genuinely TV-specific:

- `stages/branches.ts` — the 8 branches' lens PROMPT TEXT (unchanged content) + the
  `tvDomain: RecommenderDomain<PlexShow, TvTasteProfile>` wiring object (TMDB `/search/tv`
  endpoint + field mapping, the TMDB TV-genre id table, digest emoji/wording, push job/tags,
  report heading/filename, and `extraNotifyDetail` — TV's ledger `detail` additionally carries a
  `tmdbUrl`, which movies' does not).
- `recs.ts` — thin re-exports of the shared pure helpers (`src/core/recommender/pure.ts`) plus
  `RECS_JOB` and `creatorsOwnedAtLeast` (TV's wrapper over the shared `ownedAtLeast`, keyed by
  `profile.roles` instead of movies' `profile.directors`).
- `stages/recommend.ts`, `stages/tv-rec-merge.ts`, `stages/tv-recs-notify.ts` — thin wrappers
  that call the shared `runBranch`/`makeBranchJob`, `runMerge`, `runRecsNotify` with `tvDomain`
  baked in, preserving every existing exported name (`runBranch`, `makeBranchJob`,
  `runTvRecMerge`, `SearchTvFn`, `runTvRecsNotify`, `buildDigest`, …) so the `*.job.ts` wrappers
  and existing tests are unaffected.
- `contracts.ts` (gate contracts) and `config.ts` (env var names + tuning defaults) stay
  entirely per-workflow — the shared pipeline takes them as plain data (`domain.config`), never
  reads `process.env` itself.

This is a **pure structural extraction (T561)** — this workflow used to duplicate ~1,100 lines of
`movies`' recommender logic verbatim; both workflows now run the identical shared code with
different `RecommenderDomain` wiring. Job names, ledger keys, and DAG shape are all unchanged.
`recsModel` now defaults to `claude-sonnet-5` (was `claude-sonnet-4-6`) — aligned with `movies`.

## Files, credentials, service

- `config.ts` — `tvRecsConfig` (data paths + all `TV_RECS_*` tuning env vars above; `tvSection` and a
  `host` field kept only for a log line — Plex/TMDB connectivity itself lives in the shared client).
- `recs.ts` — TV-domain wiring over the shared pure helpers (see "Shared recommender pipeline"
  above).
- `stages/tv-snapshot.ts`, `stages/tv-rec-*.ts` (8 branches), `stages/tv-rec-merge.ts`,
  `stages/tv-recs-notify.ts`.
- Credentials: `PLEX_HOST`, `PLEX_API_TOKEN`, `TMDB_API_TOKEN` (shared with every other Plex/TMDB
  workflow via `src/core/plex-client.ts`) — no tv-recs-specific credential.
- Services used: `plex` and `tmdb` (via the shared client) and `claude-cli` (via `runClaude`).

**Plex reads are response-cached for a 3-hour window (T477).** `tv-snapshot`'s Plex fetch passes a
`cacheKey` derived from the request path (`plex:<path>`) to `callService('plex', ..., { cacheKey })`,
engaging the `plex` service's 3-hour cache TTL (T476) — a second read of the same TV section within
that window (e.g. another Plex-touching workflow triggered back-to-back via the admin "Run all
workflows" button) is served from cache instead of hitting Plex again. The stage's existing
`fetchMeta` test seam still fully bypasses `callService`; a new `plexFetch` option stands in for the
real `plexGet` used by the default `fetchMeta`, still routed through `callService`, so the cache
dedup itself is unit-tested without a live Plex call.
