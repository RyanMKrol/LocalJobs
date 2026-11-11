# CLAUDE.md — src/workflows/perfumes/

Builds a rich markdown profile for each perfume in the owner's collection. Backlog source: the
`PerfumeRatings` DynamoDB table (populated by rating perfumes on the owner's own website — the
`dynamodb` service, read-only `Scan`). Fully serial DAG (`maxConcurrency: 1`, since stages share one
Chrome profile + the Claude CLI), wrapped in `repeatUntilStable`: the four stages run again in
cycles until nothing retryable remains or a cycle makes no progress, up to `maxCycles` (default
40, `PERFUMES_MAX_CYCLES`) with `cycleSleepMs` (default 5s) between cycles. Runs daily at 02:00.
Limitable: `perfumes-find-url` declares `inputKeys()`, so a manual run can be capped to N perfumes.

## DAG: find-url → fetch → parse → build

```
find-url ──urls──▶ fetch ──pages──▶ parse ──data──▶ build ──▶ profiles
   └──────────────────urls───────────────────────────▲
```

This is a ports workflow (see "Ports" in the root `CLAUDE.md`). Each stage is a `defineStage`
in its `*.job.ts`, the artifact types are in `contracts.ts`, and each stage's loop is the
engine's `eachItem` (`src/engine/items.ts`).

| Stage | Inputs | Output (all cumulative) |
|---|---|---|
| `perfumes-find-url` | none (root: `inputKeys()` from DynamoDB) | `urls` (`fragrantica-urls`, `fragrantica-urls.json`) |
| `perfumes-fetch` | `urls` | `pages` (`fragrantica-pages`, `pages/`) |
| `perfumes-parse` | `pages` | `data` (`fragrantica-data`, `fragrantica/`) |
| `perfumes-build` | `data`, `urls` | `profiles` (`perfume-profiles`, `markdown/`), the workflow's product |

What that buys, and what to keep in mind:

- **The build depends on find-url directly.** It cites each perfume's Fragrantica page, so it
  reads the URL store. That used to be a hidden read three stages back; it is now an edge in the
  manifest and an input on the stage.
- **Every store is cumulative.** A perfume is resolved, fetched, parsed and built once, and each
  stage adds to what earlier runs left. On a run with nothing new for a stage, its store is
  recorded as carried forward. The checks are therefore about shape, not about there being
  something new: an empty store is valid (nothing resolved yet), a store holding the wrong kind
  of thing fails (a URL that is not Fragrantica's, an empty page capture, parsed records with no
  name or notes, a profile with no frontmatter).
- **`eachItem` owns the loop.** It skips perfumes already done, leaves out perfumes outside a
  limited run, counts attempts, records a thrown error as a failed item and carries on, and
  fails the run at the end if any perfume failed (so the next cycle retries). A stage's handler
  only does the work for one perfume and returns what to record. There is no hand-written loop,
  tally or `assertNoFailures` left in this folder.
- **A Claude usage limit is `softStop(...)`.** The perfume is recorded `skipped` with no attempt
  counted, the stage ends without failing, and the next run resumes there. If a stage stops this
  way having completed nothing, the workflow run settles `partial` and the push says so.
- **A failed fetch keeps what came back.** It throws `ItemFailure(why, { httpStatus, pageTitle,
  finalUrl, textLength, snippet, debugFile, url })`, so the run page shows the HTTP status and
  page title of a blocked page, not just "failed". A browser that will not launch is a
  `FatalStageError`: it fails the run at once without charging any perfume an attempt.
- **Each item is saved before it is marked done.** The handler writes its file (atomically)
  and only then returns; find-url saves the URL store after every perfume.
- **Each stage after find-url says what its items were made from** (`from: { job: <previous
  stage> }`), which is what the run page lists as a stage's input items: the perfumes this run
  actually worked on, not the whole catalogue. find-url is the root and has no `from`.
- **Every ledger row is real state.** Each stage records one row per perfume under its own job
  name, keyed by the perfume id. That row is what makes a perfume "done" for the stage. The
  detail is `{ name, ...what the handler returned }`: the URL for find-url, the capture path and
  sizes for fetch, the JSON path and counts for parse, the markdown path and vote count for build.

The stages:

- **`perfumes-find-url`** — root stage (`inputKeys()` = every perfume id from the DynamoDB scan,
  routed through `inputKeysService: 'dynamodb'`). For each perfume without an already-known
  `fragranticaUrl`, asks Claude (web search) to find its Fragrantica page. Adds it to
  `data/out/fragrantica-urls.json`, which it creates (empty) on a first run.
- **`perfumes-fetch`** — for each resolved URL, launches a real (non-bundled) Chrome via the shared
  `launchPersistentBrowser` helper (`src/core/browser.ts`) against the framework's shared persistent
  profile (`data/chrome-profile/`, keeps Cloudflare clearance across runs), waits out any Cloudflare
  challenge, scrolls to trigger lazy content, and saves the page. Success path saves the page
  *text* (`data/out/pages/<id>.txt`) and the raw page beside it (`<id>.html`, written first); a
  page diagnosed as blocked/short is saved to `data/out/pages-failed/` instead for debugging. Paced via the `fragrantica` service
  (`minIntervalMs` ~12s + jitter — the block is rate/reputation-based, not per-request detection).
- **`perfumes-parse`**: asks Claude (`modelParse`) to turn the captured page text into a
  structured record of notes, accords and community votes (`data/out/fragrantica/<id>.json`).
  Accord `pct` (e.g. "woody 83%") is lifted in code from the page's coloured-bar `width: NN%`
  CSS, read from the `<id>.html` capture; a page with no HTML capture keeps `pct: null` rather
  than a guess. It fetches nothing from the web: its only outside call is the Claude CLI.
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
  `personal_ownership`/`personal_longevity_hours`/`personal_projection`/`personal_seasons` keys and the
  `## Personal Notes`/`## Application` sections — each falls back to an honest `null`/`[]`/"not
  recorded yet" when the Dynamo field is absent, same tone as the notes-pyramid honest-gap
  convention. Two of these are **disambiguated** rather than written as bare integers (a raw 1–4 or
  0–8 is meaningless to a downstream ingester): the 0–8 `personalLongevity` is a whole-hours figure
  (8 = "8 or more hours"), so its frontmatter key is `personal_longevity_hours` and the value stays
  the number; the 1–4 `personalProjection` is mapped to its website label (`projectionLabel`: 1 Skin
  scent · 2 Moderate · 3 Strong · 4 Beast mode) and `personal_projection` holds that label string.
  Both scales mirror the owner's `ryankrol.co.uk` `PerfumeCharacteristics` component (the source of
  the `PerfumeRatings` rows). The `## Application` section body is additionally **machine-rendered
  after the build**: `enforceApplicationSection` overwrites whatever the model wrote there with
  bullets rendered in code from `applicationSpots` (`renderApplicationBullets`, `- 1 spray — Wrists`)
  — a run sometimes pasted the raw JSON array into the section (9 shipped profiles), and structured
  owner data never needs the model for rendering. The prompt also feeds Claude the pre-rendered
  bullet lines rather than a JSON blob. No spots recorded → the model's "not recorded yet" text
  stands.
  `personal_rating` is `loadPerfumes`'s Dynamo `rating` halved (0-10 → 0-5) so it lines up with
  Fragrantica's 0-5 `community_rating` scale, rather than the raw 0-10 owner score. The personal
  frontmatter block and the `## Personal Notes`/`## Application` body sections sit immediately after
  the researched/crawled data (right after the frontmatter's researched fields, and right after
  `## Overview` in the body) rather than at the end of the document. Writes `data/out/markdown/<id>.md`.
  The reply is cleaned via `salvageProfile` (unfence + drop any stray commentary Claude prepends
  before the opening `---`) before the template-shape check (`startsWith('---')` and includes
  `## Sources`). A reply that still fails that check — an intermittent formatting deviation, NOT a
  data problem, since the same prompt succeeds on retry — has its raw text saved to
  `data/out/build-failed/<id>.txt` (mirrors `pages-failed/`) for inspection, then fails the item so
  `repeatUntilStable` retries it next cycle. `salvageProfile` deliberately does NOT rescue a
  genuinely truncated reply (no `## Sources`) — that must retry.

## Files & config (`src/workflows/perfumes/config.ts`)

- `data/out/{fragrantica-urls.json, pages/, pages-failed/, fragrantica/, markdown/, build-failed/}` —
  one file/dir per stage's output, as above (`build-failed/` holds raw Claude replies that failed the
  build template-shape check, written only on failure).
- `profileDir` — the shared framework Chrome profile (`defaultChromeProfileDir` from
  `src/core/browser.ts`), NOT a perfumes-local one — other scrape jobs benefit from the same warmed,
  trusted profile.
- `templatePath` — the in-project `profile.template.md` (override via `PERFUMES_TEMPLATE_PATH`).
- Models: `modelFind`/`modelParse` default to a cheaper Sonnet tier, `modelBuild` defaults to Opus
  (the richer research/writing step). The per-call CLI timeout comes from the shared
  `claude-cli` service (`claudeTimeoutMs()` in `src/services/claude.ts`, dashboard-editable),
  not a perfumes-local setting.
- `maxAttempts` (default 4; the manifest passes the same number as `minAttempts`, the retry budget the engine uses to decide whether retryable work is left), `runLimit` (`PERFUMES_RUN_LIMIT`,
  0 = no cap; a per-stage cap on items attempted in one run, separate from the dashboard's run
  limit), `dryRun` (`PERFUMES_DRY_RUN=1`: skip real Claude calls and fabricate a reply, for testing).
- Left over in `config.ts` and read by nothing: `claudeBin`, `claudeTimeoutMs` and
  `rateLimitBackoffMs`. `fetchDelayMs` and `fetchJitterMs` only feed a log line in the fetch
  stage; the pacing itself is done by the `fragrantica` service, which reads the same two env
  vars (`PERFUMES_FETCH_DELAY_MS`, `PERFUMES_FETCH_JITTER_MS`).

## Non-obvious invariants

- **`perfumes` uses the shared Claude helper (T567).** `find-url`/`parse`/`build` all import
  `runClaude`/`extractJsonObject`/`unfenceMarkdown` from `src/services/claude.ts` — the same
  spawn/timeout/parse implementation `projects-sync` and the movie/TV recommender branches use.
  There is no perfumes-local Claude helper (no `claude.ts` in this folder). Each stage calls
  `runClaude` once per perfume inside its loop, so each call is metered by the `claude-cli`
  service on its own. The binary is the shared `LOCALJOBS_CLAUDE_BIN` and the timeout is the
  dashboard-editable `claude-cli` service timeout (`claudeTimeoutMs()`), as for every other
  Claude caller. `PERFUMES_CLAUDE_BIN` and `PERFUMES_CLAUDE_TIMEOUT_MS` are still parsed into
  `config.ts` but nothing uses the values. Seeded perfumes with an already-known
  `fragranticaUrl` (from the DynamoDB row) skip the Claude call in `find-url` entirely.
- **Same-key stages, no lineage args** — every stage keys by the same perfume `id` (`p.id`), so
  `root_key` propagates for free (`markWorkItem`'s rule 3: item is its own root); this is the
  canonical "no `rootKey`/`parentKey` needed" example referenced elsewhere in this repo.
- **The perfume list itself is not a stage hand-off.** Every stage calls `loadPerfumes()` (the
  cached DynamoDB scan) for names and the owner's personal fields. That is a read of an external
  source through a service, not of another stage's output, so it has no port.
- **`dryRun` builds pass the shape check.** The fabricated dry-run profile includes a
  `## Sources` section, so a dry run exercises the success path end to end.
- Real Chrome (not bundled Chromium) + a persistent profile is load-bearing for beating Fragrantica's
  Cloudflare gate — this is reputation/rate-based blocking, not per-request fingerprinting, so pacing
  (the `fragrantica` service's `minIntervalMs`) matters as much as the browser identity.
