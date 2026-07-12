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

**`tv-snapshot`** connects to Plex via the shared `src/core/plex-client.ts` (`plexGet`), reads the TV
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

## Ignore / un-ignore

A recommended show can be permanently dismissed from the dashboard (ignore) and reversed later
(un-ignore) — same `ignoreSurfacedItem`/`unignoreSurfacedItem` mechanism shared by all four
recommendation/audit ledgers in this repo (movie franchise gaps, movie recs, TV recs, missing TV
seasons); see root `CLAUDE.md`'s "Ignore-to-suppress" convention for the full mechanism. Ledger key is
the recommended show's tmdb id.

## Files, credentials, service

- `config.ts` — `tvRecsConfig` (data paths + all `TV_RECS_*` tuning env vars above; `tvSection` and a
  `host` field kept only for a log line — Plex/TMDB connectivity itself lives in the shared client).
- `recs.ts` — pure recommendation helpers (mirrors `movies/recs.ts`, adapted for TV shows).
- `stages/tv-snapshot.ts`, `stages/tv-rec-*.ts` (8 branches), `stages/tv-rec-merge.ts`,
  `stages/tv-recs-notify.ts`.
- Credentials: `PLEX_HOST`, `PLEX_API_TOKEN`, `TMDB_API_TOKEN` (shared with every other Plex/TMDB
  workflow via `src/core/plex-client.ts`) — no tv-recs-specific credential.
- Services used: `plex` and `tmdb` (via the shared client) and `claude-cli` (via `runClaude`).
