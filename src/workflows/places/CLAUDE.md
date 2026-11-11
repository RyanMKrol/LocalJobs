# CLAUDE.md — src/workflows/places/

Google Saved Places enrichment: parse Google Takeout CSVs → resolve each venue's
opaque CID to a canonical `place_id` via a headless browser → fetch full details
from the Google Places API → generate a Gemini-written summary → write a
formatted markdown profile. A "second-brain" workflow (`category:
'second-brain'`) — the goal is a queryable local corpus of the owner's saved
places, not just a raw data dump.

## DAG (4 stages, serial — `maxConcurrency: 1`)

`places-ingest → cid-to-place-id-resolver → places-enrich → enrich-with-llm`,
plus an edge from `places-ingest` straight to `enrich-with-llm` (see the ports
table below). Serial by design: the resolver drives a real browser and the last two stages
hit paid APIs (Google Places, Gemini) that must not overlap and are governed by
day/month spend caps. Single pass per run (no `repeatUntilStable`) — a
scheduled run processes whatever's ready; capped or transiently-failed items
resume next run via the ledger. Runs daily at 03:00; the daily spend caps
(`monthly / 30`, see `src/services/lib.ts`'s `DAILY_SPEND_DIVISOR`) mean a daily
run steadily drains the backlog without ever blowing the month.

**`places-ingest`** parses every CSV under `data/raw/Saved/` (only the `Saved/`
export — `Maps`/`Maps (your places)` are intentionally ignored) into one
deduped, normalized `data/out/places.json`, plus a `data/out/validation-report.json`.
Throws if validation finds an error-level issue. Name-only places with no CID
are kept in `places.json` (`resolvable: false`) but nothing downstream can
resolve them. The stage also records one ledger row per CID-bearing place under
`places-ingest`, keyed by CID, with `detail: { name, url, lists }`. It re-records
the whole list on every valid run (only the selected roots on a limited run).
That ledger is kept on purpose (see the invariants below).

**`cid-to-place-id-resolver`** resolves each place's CID to a real Google
`place_id` by driving a headless browser to `https://www.google.com/maps?cid=<cid>`
(`src/workflows/places/stages/resolve.ts`, own inline Playwright launch — not
the shared `launchPersistentBrowser` helper). Free (no paid API), so its own
`resolveConfig` caps (`PLACES_RESOLVE_MONTHLY_CAP`/`_DAILY_CAP`, default
10000/1000) are politeness/runaway guards via the per-job `job_usage` meter,
not a spend cap. Writes `data/out/resolved.json`. Paced by `PLACES_RESOLVE_DELAY_MS`
(default 1500ms).

Its ledger is keyed by CID: `success` with `{ name, placeId }`, or `failed`
with the resolve status and error, retried on later runs up to
`PLACES_RESOLVE_MAX_ATTEMPTS` (default 4). `PLACES_RESOLVE_LIMIT` caps one run.
The run fails at the end if any place failed to resolve.

**This is the workflow's root stage — `resolveInputKeys()` derives its input keys
LIVE from the raw CSVs, never from this workflow's own output (T484).** Reading
back `data/out/places.json`, a file this workflow writes itself, would return
`[]` after a "Clear output data" reset until an unlimited run rebuilt the file,
and a limited manual run in between would do nothing. It calls the shared
`collectResolvableCids(savedDir)` helper
(`src/workflows/places/parse.ts`) directly against `data/raw/Saved/`'s CSVs —
the SAME true source `places-ingest` parses — routed through
`callService('fs', …)` (the local-filesystem service, T483, declared as
`inputKeysService: 'fs'`) so this read is metered like any other input-key
source. `collectResolvableCids` and `listSavedCsvFiles` are the shared helpers
both `places-ingest`'s `run()` and `resolveInputKeys()` call, so the two can
never drift on which CSV rows count as a resolvable CID.

**`places-enrich`** fetches full Place Details (New) via the Google Places API
using a wildcard field mask (`*` — the raw response is stored as-is, trimmed
downstream; billing tier is unaffected since `*` is already Enterprise+Atmosphere).
Incremental — a place enriched successfully is never re-enriched. Spend is
governed SOLELY by the shared `google-places` service quota (`callService`
throws `QuotaExceededError` when exhausted; the run stops gracefully, no
redundant per-job cap). Writes `data/out/enriched.json`, a map keyed by CID.
Its ledger is keyed by `place_id`, with `rootKey: cid` and
`detail: { name, rating, type, address }` on success. A place the quota or a
429 stopped at is recorded `skipped` with no attempt counted. An auth or
permission error, or a permanent provider failure, throws. Five failures in a
row stop the run. `PLACES_ENRICH_RUN_LIMIT` caps one run and
`PLACES_ENRICH_MAX_ATTEMPTS` (default 4) is the per-place retry budget.
Responses are cached by the service for 22 hours. Credential:
`GOOGLE_MAPS_API_KEY`.

**`enrich-with-llm`** asks Gemini (default model `gemini-flash-lite-latest`,
override `GEMINI_MODEL`, thinking level raised to `high` so it actually
deliberates/searches rather than barely thinking) to write a prose summary per
place, blending the Places API data with the owner's own saved-list
name/notes (fed into the markdown as provenance/context only — never into the
LLM prompt). Spend governed by the shared `gemini` service quota, same
`QuotaExceededError` soft-fail. Writes `data/out/llm-enriched.json` (its own
store of the Gemini verdicts, keyed by `place_id`; no stage reads it and it is
not a declared output) plus one markdown profile per place under
`data/out/markdown/<slug>.md` (frontmatter + body, built inline, with no separate
template file; the slug is made from the place name). Records `detail: { name,
markdown: mdPath }` per item, keyed by `place_id` with `rootKey: cid`.
`PLACES_LLM_RUN_LIMIT` caps one run and `PLACES_LLM_MAX_ATTEMPTS` (default 4)
is the per-place retry budget. Credential: `GEMINI_API_KEY`.

## How the stages hand data to each other (ports)

A ports workflow (see "Ports" in the root `CLAUDE.md`; artifact types in `contracts.ts`):

| Stage | Inputs | Outputs |
|---|---|---|
| `places-ingest` | none | `places` (`places-normalized`, `places.json`), `report` (`places-validation-report`) |
| `cid-to-place-id-resolver` | `places` | `resolved` (`resolved-place-ids`, `resolved.json`, cumulative) |
| `places-enrich` | `resolved` | `enriched` (`enriched-places`, `enriched.json`, cumulative) |
| `enrich-with-llm` | `enriched`, `places` | `profiles` (`place-profiles`, the `markdown/` folder, cumulative), the workflow's product |

- **The last stage depends on `places-ingest` directly.** It reads `places.json` for each
  place's list memberships and the owner's notes. That was a hidden read two stages back; it
  is now an edge in the manifest and an input on the stage.
- The checks are shape and non-empty checks: Takeout-sourced with at least one named place; a
  resolved map with at least one real place_id; an enriched map with at least one place_id; no
  empty profile file.
- The three stores are cumulative, so a run with nothing left to do in a stage, or one stopped
  by a quota, carries its store forward.
- The stage functions still read and write the configured paths themselves (`placesConfig`);
  the engine checks that each input is what the previous stage committed in this run before the
  stage starts. Each stage keeps its ledger, which is what makes the pipeline incremental.

## Files

- `config.ts` — `placesConfig` (all `data/` paths), `enrichConfig` (Places API
  knobs — spend caps live on the `google-places` service, NOT here),
  `llmConfig` (Gemini knobs — spend caps live on the `gemini` service),
  `resolveConfig` (resolver knobs + its own free-tier `job_usage` caps).
- `contracts.ts`: the artifact types the stages exchange (see the ports table above).
- `parse.ts` — CSV parsing helpers (`parseListFile`, CID/name extraction, plus
  `listSavedCsvFiles`/`collectResolvableCids` — the shared CSV-walk + CID-list
  helpers used by both `places-ingest` and `resolveInputKeys`).
- `types.ts` — shared shapes (`NormalizedPlace`, `ResolvedFile`,
  `EnrichedFile`, `ValidationReport`, etc.).

## Non-obvious invariants

- **`places-ingest` keeps its per-place ledger.** It writes one row per CID on every run
  even though it is a bulk single-file transform. The run page does not need it (the stage's
  two declared outputs are what it shows), and no other stage reads those rows. It is kept
  deliberately, so do not remove it as a leftover. Two things follow from it: the run's item
  tally counts every place every night, and the root stage for run limits is still the
  resolver (the first stage with `inputKeys()`), not ingest.
- **`places-enrich` and `enrich-with-llm` must pass `rootKey: cid`.** Both key their ledger by
  `place_id`, so without it each row would be its own root and a limited manual run would skip
  it. `places-ingest` and the resolver key by CID, where `root_key = item_key` is already right.
- **Both paid stages must classify a provider refusal before soft-stopping.**
  `places-enrich` and `enrich-with-llm` call `isPermanentProviderFailure`
  (`src/core/services.ts`) BEFORE their transient-rate-limit branch, and throw when
  it matches. This is not optional tidiness: `enrich-with-llm` used to match
  `credits? (are )?depleted` inside its own `isRateLimited` regex, so when the
  Gemini prepay balance ran out on 2026-08-20 it attempted exactly one place a
  night, caught the 429, recorded it `'skipped'`, stopped "gracefully", and
  reported SUCCESS — for 18 consecutive nights, while 514 places went unenriched
  and the nightly push showed a green tick. A ceiling that clears on its own is a
  graceful stop; one that needs a human is a failed run.
- **The three item stages save their hand-off file BEFORE marking items done.**
  `cid-to-place-id-resolver`, `places-enrich` and `enrich-with-llm` each add results to a
  cumulative JSON file (`resolved.json` and `enriched.json`, which the next stage reads, and
  `llm-enriched.json`) and save it every 10 items. Marking an item done before that save
  would mean a run killed in between leaves places "done" that are missing from the file,
  so they never reach the next stage and nothing retries them. Each stage holds its ledger
  marks in a `createCheckpoint` (`src/engine/checkpoint.ts`) and applies them only after the
  save that covers them, flushing in a `finally`. A kill costs at most 9 repeated lookups.
  `enriched.json` is about 80 MB, which is why it is not simply saved per item. All of these
  files are written atomically. The `skipped` row of a soft stop is written directly, since
  it carries no data.
- Both paid stages (`places-enrich`, `enrich-with-llm`) rely EXCLUSIVELY on
  their service's quota (`google-places`, `gemini`) as the spend governor —
  don't add a redundant per-job `job_usage` cap on top; it would shadow the
  service's `QuotaExceededError` soft-fail and double-meter the same calls.
