# CLAUDE.md — src/workflows/plex-profiles/

A single-stage build that writes one markdown profile file per Plex title (movie AND TV show) to
`data/out/movies/` / `data/out/shows/`, sourced purely from data the Plex API already exposes — no
LLM involved. This is a genuinely NEW workflow, distinct from the other four Plex-touching
workflows: `missing-tv-seasons` audits season completeness, `movie-recommendations`
(`src/workflows/movies/`) / `tv-recommendations` (`src/workflows/tv-recs/`) build franchise-gap /
recommendation digests, and `plex-space-saver` reports a disk-size breakdown only — none of them
write a per-title profile covering summary/cast/ratings/technical detail for every movie AND show.

## Confirmed Plex fields in use

Reuses the shared Plex client (`src/core/plex-client.ts`'s `resolvePlexHost`/`plexGet` — DHCP
self-heal) and the existing Plex env (`PLEX_HOST`/`PLEX_API_TOKEN`/optional `PLEX_MACHINE_ID`),
plus the SAME `PLEX_MOVIE_SECTION`/`PLEX_TV_SECTION` env vars the `movies`/`missing-tv-seasons`/
`plex-space-saver` workflows already read (no new connectivity config).

- `GET /library/sections/<id>/all` (list): `ratingKey`, `slug`, `title`, `updatedAt` — used only to
  discover the current key set + decide whether a title needs rebuilding (cheap; no detail fields).
- `GET /library/sections/<tvSectionId>/all?type=4` (flat episode list): used ONLY to compute each
  show's total library size (a show carries no `Media`/size of its own — sum every episode's
  `Media[].Part[].size`, grouped by `grandparentRatingKey`, mirroring `plex-space-saver`'s
  `buildShowRows`).
- `GET /library/metadata/<ratingKey>` (single-item detail — genuinely new territory; no other
  workflow in this repo calls this endpoint): the full per-title detail used to build the profile —
  `Guid[]` (tmdb/imdb/tvdb ids), `Rating[]` (per-source critic/audience ratings), `Genre`/
  `Country`/`Director`/`Writer`/`Role` tag arrays, `Media[]`/`Part[]` (resolution/codec/container/
  file size/file path — movies only), and for shows `leafCount`/`childCount`/`originalTitle`.

## Idempotency — `updatedAt` marker (mirrors projects-sync)

`plex-profiles-build` (the only stage) keys each item `movie:<ratingKey>` / `show:<ratingKey>`.
Before rebuilding, it compares the item's CURRENT `updatedAt` (from the cheap list fetch) against
the `updatedAt` stored in the `work_items` ledger's `detail` from its last successful build — an
unchanged marker skips the (expensive) detail fetch + rewrite entirely. This is the SAME marker
idiom `projects-sync/project-summarize.ts` uses with `pushedAt`, generalized to Plex's own
`updatedAt` epoch-seconds field. A new key (no ledger row) or a moved `updatedAt` always rebuilds.

`plex-profiles-build` declares `inputKeys()` (every current `movie:<ratingKey>`/`show:<ratingKey>`
in the library) so a manual run can be limited (T094) — the owner's first run processes the whole
library, a large backlog, so `PLEX_PROFILES_RUN_LIMIT` (default `0` = unlimited) caps how many
titles are (re)built in a single run; the next scheduled/manual run resumes with whatever's left.

## Markdown template

Fixed frontmatter keys + `##` section names (`## Summary`, `## Cast & Crew`, `## Ratings`,
`## Technical`, `## Source`) kept STABLE across every profile for corpus-wide queryability — prose
within a section is free-form. `type: movie|show` distinguishes the two; movies additionally carry
tagline/director/writer/file-path fields that shows omit, and shows carry `original_title` (when it
differs from `title`), season/episode counts, and a summed total library size instead of a single
file size. See `lib.ts`'s `buildMovieProfileMarkdown`/`buildShowProfileMarkdown` for the exact
shape. `detail.markdown` is set on every successful `markWorkItem` call (T110), so the produced
profiles surface automatically in the workflow's generic unified Output section (T205) — no
dashboard changes needed.

## No DAG edge, no gate needed

One stage (`plex-profiles-build`), no `dependsOn` edges — per the gate-coverage rule in
`src/workflows/CLAUDE.md`, a gate is only derived for a producer→consumer edge inside a workflow's
own DAG; a single-stage workflow has none, so (mirroring `plex-space-saver`'s identical reasoning)
no `contracts.ts` and no gate are needed here.

## Schedule

Weekly, Saturday 05:00 (`0 5 * * 6`) — deliberately offset from `plex-space-saver`'s Sunday 06:00
slot so the two don't collide. Category `second-brain` (matches `places`/`perfumes`'s
per-item-profile grouping).

## Deferred: phase 2 (Claude-narrated layer) — NOT built here

This task (phase 1) is deliberately pure-API, no LLM call anywhere. A phase 2 — optionally layering
Claude-authored narrative commentary on top of the pure-API profile (mirroring how `perfumes`/
`projects-sync` layer a Claude write over raw source data) — is a SEPARATE, later follow-up idea.
No toggle, no stub stage, and no unused config knob for it exists in this folder yet; if/when that
follow-up lands, it should add its own stage (e.g. `plex-profiles-narrate`) consuming this stage's
output rather than modifying `build.ts` in place.
