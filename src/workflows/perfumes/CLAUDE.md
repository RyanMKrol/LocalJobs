# CLAUDE.md — src/workflows/perfumes/

Builds a rich markdown profile for each perfume in the owner's collection. Backlog source: the
`PerfumeRatings` DynamoDB table (populated by rating perfumes on the owner's own website — the
`dynamodb` service, read-only `Scan`). Fully serial DAG (`maxConcurrency: 1`, since stages share one
Chrome profile + the Claude CLI), wrapped in `repeatUntilStable` (cycles until nothing retryable
remains, capped at `maxCycles`). Runs daily at 02:00.

## DAG: find-url → fetch → parse → build

- **`perfumes-find-url`** — root stage (`inputKeys()` = every perfume id from the DynamoDB scan,
  routed through `inputKeysService: 'dynamodb'`). For each perfume without an already-known
  `fragranticaUrl`, asks Claude (web search) to find its Fragrantica page. Writes
  `data/out/fragrantica-urls.json` (gate: `fragrantica-urls`).
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
  `applicationSpots` — T461, T481) are passed through **verbatim, never researched or blended** via
  `personalFieldsClause`, populating the frontmatter's `personal_rating`/`personal_date_added`/
  `personal_ownership`/`personal_longevity`/`personal_projection`/`personal_seasons` keys and the
  `## Personal Notes`/`## Application` sections — each falls back to an honest `null`/`[]`/"not
  recorded yet" when the Dynamo field is absent, same tone as the notes-pyramid honest-gap
  convention. The dead `status: "owned"` frontmatter field (it never varied) was removed in T481.
  `personal_rating` is `loadPerfumes`'s Dynamo `rating` halved (0-10 → 0-5) so it lines up with
  Fragrantica's 0-5 `community_rating` scale, rather than the raw 0-10 owner score. The personal
  frontmatter block and the `## Personal Notes`/`## Application` body sections sit immediately after
  the researched/crawled data (right after the frontmatter's researched fields, and right after
  `## Overview` in the body) rather than at the end of the document. Writes `data/out/markdown/<id>.md`.

## Files & config (`src/workflows/perfumes/config.ts`)

- `data/out/{fragrantica-urls.json, pages/, pages-failed/, fragrantica/, markdown/}` — one file/dir
  per stage's output, as above.
- `profileDir` — the shared framework Chrome profile (`defaultChromeProfileDir` from
  `src/core/browser.ts`), NOT a perfumes-local one — other scrape jobs benefit from the same warmed,
  trusted profile.
- `templatePath` — the in-project `profile.template.md` (override via `PERFUMES_TEMPLATE_PATH`).
- Models: `modelFind`/`modelParse` default to a cheaper Sonnet tier, `modelBuild` defaults to Opus
  (the richer research/writing step). The per-call CLI timeout comes from the shared
  `claude-cli` service (`claudeTimeoutMs()` in `src/services/claude.ts`, dashboard-editable),
  not a perfumes-local setting.
- `maxAttempts` (default 4), `runLimit` (0 = no per-stage cap), `dryRun` (skip real Claude calls,
  fabricate — for harness testing).

## Non-obvious invariants

- **`perfumes` uses the shared Claude helper (T567).** `find-url`/`parse`/`build` all import
  `runClaude`/`extractJsonObject`/`unfenceMarkdown` from `src/services/claude.ts` — the same
  spawn/timeout/parse implementation `projects-sync` and the movie/TV recommender branches use.
  There is no perfumes-local Claude helper anymore. Each stage still calls `runClaude` per-item
  inside its loop (correct `callService` granularity), and the perfumes-specific
  `PERFUMES_CLAUDE_BIN`/`PERFUMES_CLAUDE_TIMEOUT_MS` env vars are no longer read — perfumes now
  picks up the shared `LOCALJOBS_CLAUDE_BIN` and the dashboard-editable `claude-cli` service timeout
  (`claudeTimeoutMs()`) like every other Claude caller. Seeded perfumes with an already-known
  `fragranticaUrl` (from the DynamoDB row) skip the Claude call in `find-url` entirely.
- **Same-key stages, no lineage args** — every stage keys by the same perfume `id` (`p.id`), so
  `root_key` propagates for free (`markWorkItem`'s rule 3: item is its own root); this is the
  canonical "no `rootKey`/`parentKey` needed" example referenced elsewhere in this repo.
- Real Chrome (not bundled Chromium) + a persistent profile is load-bearing for beating Fragrantica's
  Cloudflare gate — this is reputation/rate-based blocking, not per-request fingerprinting, so pacing
  (the `fragrantica` service's `minIntervalMs`) matters as much as the browser identity.
