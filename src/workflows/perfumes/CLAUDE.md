# CLAUDE.md — src/workflows/perfumes/

Builds a rich markdown profile for each perfume in the owner's collection. Backlog source: the
`PerfumeRatings` DynamoDB table (populated by rating perfumes on the owner's own website — the
`dynamodb` service, read-only `Scan`). Fully serial DAG (`maxConcurrency: 1`, since stages share one
Chrome profile + the Claude CLI), wrapped in `repeatUntilStable` (cycles until nothing retryable
remains, capped at `maxCycles`). Runs daily at 02:00.

## DAG: find-url → fetch → parse → build

- **`perfumes-find-url`** — root stage (`inputKeys()` = every perfume id from the DynamoDB scan). For
  each perfume without an already-known `fragranticaUrl`, asks Claude (web search) to find its
  Fragrantica page. Writes `data/out/fragrantica-urls.json` (gate: `fragrantica-urls`).
- **`perfumes-fetch`** — for each resolved URL, launches a real (non-bundled) Chrome via the shared
  `launchPersistentBrowser` helper (`src/core/browser.ts`) against the framework's shared persistent
  profile (`data/chrome-profile/`, keeps Cloudflare clearance across runs), waits out any Cloudflare
  challenge, scrolls to trigger lazy content, and saves the page. Success path saves page *text*
  (`data/out/pages/<id>.txt`); a page diagnosed as blocked/short is saved as HTML instead
  (`data/out/pages-failed/<id>.html`) for debugging. Paced via the `fragrantica` service
  (`minIntervalMs` ~12s + jitter — the block is rate/reputation-based, not per-request detection).
  Gate: `fragrantica-pages`.
- **`perfumes-parse`** — parses the cached page into structured notes/accords
  (`data/out/fragrantica/<id>.json`, gate: `fragrantica-data`). Accord `pct` (e.g. "woody 83%") is
  lifted from the page's coloured-bar `width: NN%` CSS — **only populated when an `<id>.html` capture
  exists** (the normal `.txt`-only success path leaves `pct: null`); re-fetching an item so it also
  saves `.html` backfills this on next parse. No network calls of its own.
- **`perfumes-build`** — researches + writes the final profile via Claude CLI, following the enforced
  `profile.template.md` contract (YAML frontmatter — name/brand/notes pyramid/accords/wear
  profile/community rating/provenance — plus fixed narrative sections). Blends Fragrantica's
  community signal against the LLM's own web research using a continuous **confidence weight**
  `votes/(votes+k)` — `k` defaults to the scraped corpus's median vote count (so the median perfume
  sits at weight 0.5), overridable via `PERFUMES_CONFIDENCE_K`; the computed weight + an explicit
  "state this in the profile" directive are fed into the build prompt (`confidenceClause`) — the LLM
  is trusted to honor it, there's no post-build validator re-checking the written prose against it.
  Separately, 8 owner-authored personal fields from the `PerfumeRatings` Dynamo row (own `rating`,
  `dateAdded`, `ownership`, `personalLongevity`, `personalProjection`, `personalSeasons`, `description`,
  `applicationSpots` — T461) are passed through **verbatim, never researched or blended** via
  `personalFieldsClause`, populating the frontmatter's `rating`/`date_added`/`ownership`/
  `personal_longevity`/`personal_projection`/`personal_seasons` keys and the `## Personal Notes`/
  `## Application` sections — each falls back to an honest `null`/`[]`/"not recorded yet" when the
  Dynamo field is absent, same tone as the notes-pyramid honest-gap convention; `status` stays a fixed
  `"owned"`, unrelated to these. Writes `data/out/markdown/<id>.md`.

## Files & config (`src/workflows/perfumes/config.ts`)

- `data/out/{fragrantica-urls.json, pages/, pages-failed/, fragrantica/, markdown/}` — one file/dir
  per stage's output, as above.
- `profileDir` — the shared framework Chrome profile (`defaultChromeProfileDir` from
  `src/core/browser.ts`), NOT a perfumes-local one — other scrape jobs benefit from the same warmed,
  trusted profile.
- `templatePath` — the in-project `profile.template.md` (override via `PERFUMES_TEMPLATE_PATH`).
- Models: `modelFind`/`modelParse` default to a cheaper Sonnet tier, `modelBuild` defaults to Opus
  (the richer research/writing step). `claudeTimeoutMs` = 5 min/call.
- `maxAttempts` (default 4), `runLimit` (0 = no per-stage cap), `dryRun` (skip real Claude calls,
  fabricate — for harness testing).

## Non-obvious invariants

- **`perfumes` has its OWN Claude helper**, `src/workflows/perfumes/claude.ts` — a separate spawn
  implementation from the shared `src/services/claude.ts`'s `runClaude` (used by `projects-sync` and
  the movie/TV recommender branches). Migrating perfumes onto the shared helper is a known,
  not-yet-done follow-up; both route through the same `claude-cli` service either way.
  `find-url`/`parse`/`build` each call it per-item inside their loop (correct `callService` granularity).
  Seeded perfumes with an already-known `fragranticaUrl` (from the DynamoDB row) skip the Claude call
  in `find-url` entirely.
- **Same-key stages, no lineage args** — every stage keys by the same perfume `id` (`p.id`), so
  `root_key` propagates for free (`markWorkItem`'s rule 3: item is its own root); this is the
  canonical "no `rootKey`/`parentKey` needed" example referenced elsewhere in this repo.
- Real Chrome (not bundled Chromium) + a persistent profile is load-bearing for beating Fragrantica's
  Cloudflare gate — this is reputation/rate-based blocking, not per-request fingerprinting, so pacing
  (the `fragrantica` service's `minIntervalMs`) matters as much as the browser identity.
