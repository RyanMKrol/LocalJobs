# CLAUDE.md — src/workflows/media-reviews/

Pulls the owner's book/movie/TV/album review data from the website's DynamoDB tables (the live
stores behind ryankrol.co.uk/reviews/*) and writes one markdown file per review to
`data/out/<category>/`. Strictly READ-ONLY against Dynamo (the `dynamodb` service's mutating
helpers are policy-disabled — keep it that way); the site itself is never scraped. vault-sync
mirrors the output into the vault under `Reviews/Books|Movies|TV|Albums`.

## Structure: four independent single-stage jobs, one generic engine

Four members (`media-reviews-books|movies|tv|albums`), NO `dependsOn` edges — so no gates/contracts
are needed (plex-profiles precedent: gates only exist on DAG edges) and the default
`maxConcurrency` (4) runs all four in parallel. The scan→diff→write→mark loop lives ONCE in
`stages/build.ts` (`runReviewBuild` + the `CATEGORY_SPECS` table); each `<category>.job.ts` is a
thin `JobDefinition` invoking it with its spec. Pure helpers (normalizers, markdown builders,
hashing, naming) live in `lib.ts`.

## ⚠️ Do NOT add `inputKeys()` to any member (run-limit trap)

With four INDEPENDENT members, the framework's run-limit root selection (T094) binds to the FIRST
member in topo order that declares `inputKeys()` — its keys become the selected root set, and the
other three jobs' `ctx.rootAllowed(id)` checks would then silently filter EVERY item (their ids are
never in that set). A "limited" run would process one category and silently no-op three. So this
workflow deliberately declares no `inputKeys()` anywhere → not limitable (the vault-sync /
plex-library-guard precedent). Nothing here is paid per-item anyway — a run is four cached table
scans plus local file writes. The stages still call `ctx.rootAllowed()` in their loops (house
style; a no-op when unlimited).

## Source tables + field quirks (verified against the site repo)

All four tables: partition key `id` (String UUID), no sort key/GSI; full paginated Scan (what the
site itself does). Table names are env-overridable (`MEDIA_REVIEWS_*_TABLE`), defaulting to the
site's current versions — if the site migrates a table (e.g. V4 → V5), update the default here (or
override in `.env`). AWS creds/region are the shared ones the perfumes workflow already uses
(region `us-east-2`).

| Job | Table | Review-text field | Identity | Artwork |
|---|---|---|---|---|
| `media-reviews-books` | `BookRatingsV4` | `review_text` | title + `author` | `coverUrl` (full URL) |
| `media-reviews-movies` | `MovieRatingsV4` | `review_text` | title | `posterPath` — RELATIVE, prefix `https://image.tmdb.org/t/p/w500` |
| `media-reviews-tv` | `TelevisionRatingsV4` | `review_text` | title (shape identical to movies) | same as movies |
| `media-reviews-albums` | `AlbumRatingsV3` | **`highlights`** | title + `artist` | `thumbnail` (full URL, `''` = absent) |

Quirks to preserve:
- `rating` is 0–5 (int). `date`/`editedDate` are `'DD-MM-YYYY'` — NOT ISO; normalized to
  `YYYY-MM-DD` in frontmatter via `isoFromDdMmYyyy` (pass-through if unparseable). `tmdbDate` IS
  ISO (`'YYYY-MM-DD'`) — the release date, and the ONLY place a movie/TV year comes from.
- Enrichment fields are absent-not-null (the site writes conditional spreads). Normalizers keep
  that: optionals are conditionally spread, `''` artwork/lastfm strings treated as absent.
- Albums' `lastfm.listeners`/`playcount` are STRINGS — kept as strings, never parsed.
  `lastfm.summary` may contain raw HTML (safe: the dashboard's react-markdown escapes it).
- A few ancient rows may predate the site's `id` migration → warn-skipped every run (visible,
  harmless, no ledger row). Rows missing a required field (title/author/artist) are likewise
  warn-skipped, not failed — owner-curated data, perfumes' malformed-row precedent.

## Idempotency — content-hash marker (NOT editedDate)

Each review is keyed by its Dynamo `id`; the ledger's `detail.marker` stores
`sha256(stableStringify(rawItem))` (`contentMarker` in `lib.ts` — recursive key sort, per-item,
never the whole scan since Scan order isn't guaranteed). An unchanged hash → skipped entirely (no
rewrite, no re-mark, so `work_items.updated_at` doesn't move and vault-sync stays quiet). Why not
`editedDate`: the site's metadata backfills mutate fields WITHOUT stamping it, so it misses real
changes — the whole-row hash catches them. Deleting a `data/out` file does NOT resurrect it until
the source row changes (same as plex-profiles); use the dashboard's "Clear output data" to rebuild
from scratch.

Success `detail` is `{ name, markdown: <path>, marker }` — `name` is the display name vault-sync
uses (`Title (Author)` / `Title (Artist)` / `Title (year)`), `markdown` powers the dashboard
Output section (T110/T205; store-relativized per T447).

## Markdown format

Fixed frontmatter keys + fixed `##` section names per category (plex-profiles
corpus-queryability rule); every string value `JSON.stringify`ed (titles with quotes/colons,
free-text Last.fm dates); absent optionals omitted, never null (except the always-present core
`rating: null` / `date: ""` fallbacks). Sections: books `## Review` + optional `## Synopsis`
(Hardcover); movies/TV `## Review` + optional `## Overview` (TMDB); albums `## Highlights` (the
table's own name for its review field) + optional `## About` (Last.fm summary). Filenames:
`<slug>-<id-prefix>.md` (`slugStem` in `lib.ts`).

## Schedule + service cache

Daily 04:00 (`0 4 * * *`) — before vault-sync's 07:30 mirror so a new review reaches the vault
the same morning, and 24h apart so the `dynamodb` service's 22h response cache (`cacheKey:
dynamodb:scan:<table>`, one distinct key per table) never serves a scheduled run a stale scan.
Consequence: a same-day MANUAL re-run sees the cached morning scan — a review written on the
website today appears after the next real scan, not instantly. Rate/quota impact is trivial: 4
metered calls/day against the service's 30/min + 50k/month caps.

## Tests

`lib.test.ts` — pure helpers, bare-assert script. `stages/build.test.ts` — the engine with an
injected `scan` (no AWS), temp-dir-redirected config outDirs (the plex-profiles pattern), scratch
DB: first-run writes, steady-state skip, backfill-without-editedDate rewrite, id-less/malformed
warn-skip, and the T416 fail-the-run path.
