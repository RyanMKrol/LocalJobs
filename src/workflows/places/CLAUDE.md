# CLAUDE.md — src/workflows/places/

Google Saved Places enrichment: parse Google Takeout CSVs → resolve each venue's
opaque CID to a canonical `place_id` via a headless browser → fetch full details
from the Google Places API → generate a Gemini-written summary → write a
formatted markdown profile. A "second-brain" workflow (`category:
'second-brain'`) — the goal is a queryable local corpus of the owner's saved
places, not just a raw data dump.

## DAG (4 stages, serial — `maxConcurrency: 1`)

`places-ingest → cid-to-place-id-resolver → places-enrich → enrich-with-llm`.
Serial by design: the resolver drives a real browser and the last two stages
hit paid APIs (Google Places, Gemini) that must not overlap and are governed by
day/month spend caps. Single pass per run (no `repeatUntilStable`) — a
scheduled run processes whatever's ready; capped or transiently-failed items
resume next run via the ledger. Runs daily at 03:00; the daily spend caps
(`monthly / 30`, see `src/services/lib.ts`'s `DAILY_SPEND_DIVISOR`) mean a daily
run steadily drains the backlog without ever blowing the month.

**`places-ingest`** parses every CSV under `data/raw/Saved/` (only the `Saved/`
export — `Maps`/`Maps (your places)` are intentionally ignored) into one
deduped, normalized `data/out/places.json`, plus a `data/out/validation-report.json`.
Throws if validation finds an error-level issue. This stage OWNS the workflow's
per-item ledger list — one row per CID-bearing place, keyed by CID (the id
every downstream stage keys on); name-only places with no CID never enter the
pipeline. Re-records the full current list every run (upsert, never skips).

**`cid-to-place-id-resolver`** resolves each place's CID to a real Google
`place_id` by driving a headless browser to `https://www.google.com/maps?cid=<cid>`
(`src/workflows/places/stages/resolve.ts`, own inline Playwright launch — not
the shared `launchPersistentBrowser` helper). Free (no paid API), so its own
`resolveConfig` caps (`PLACES_RESOLVE_MONTHLY_CAP`/`_DAILY_CAP`, default
10000/1000) are politeness/runaway guards via the per-job `job_usage` meter,
not a spend cap. Writes `data/out/resolved.json`. Paced by `PLACES_RESOLVE_DELAY_MS`
(default 1500ms).

**This is the workflow's root stage — `resolveInputKeys()` derives its input keys
LIVE from the raw CSVs, never from this workflow's own output (T484).** It used
to read back `data/out/places.json` — a file THIS workflow itself writes on a
prior run — so after a "Clear output data" reset it returned `[]` until an
unlimited run reseeded the file, silently no-opping any limited manual run in
the meantime. It now calls the shared `collectResolvableCids(savedDir)` helper
(`src/workflows/places/parse.ts`) directly against `data/raw/Saved/`'s CSVs —
the SAME true source `places-ingest` parses — routed through
`callService('fs', …)` (the local-filesystem service, T483) so this read is
metered like any other input-key source. `collectResolvableCids` and
`listSavedCsvFiles` are the shared helpers both `places-ingest`'s `run()` and
`resolveInputKeys()` call, so the two can never drift on which CSV rows count
as a resolvable CID.

**`places-enrich`** fetches full Place Details (New) via the Google Places API
using a wildcard field mask (`*` — the raw response is stored as-is, trimmed
downstream; billing tier is unaffected since `*` is already Enterprise+Atmosphere).
Incremental — a place enriched successfully is never re-enriched. Spend is
governed SOLELY by the shared `google-places` service quota (`callService`
throws `QuotaExceededError` when exhausted; the run stops gracefully, no
redundant per-job cap). Writes `data/out/enriched.json`. Credential:
`GOOGLE_MAPS_API_KEY`.

**`enrich-with-llm`** asks Gemini (default model `gemini-flash-lite-latest`,
override `GEMINI_MODEL`, thinking level raised to `high` so it actually
deliberates/searches rather than barely thinking) to write a prose summary per
place, blending the Places API data with the owner's own saved-list
name/notes (fed into the markdown as provenance/context only — never into the
LLM prompt). Spend governed by the shared `gemini` service quota, same
`QuotaExceededError` soft-fail. Writes `data/out/llm-enriched.json` plus one
markdown profile per place under `data/out/markdown/<slug>.md` (frontmatter +
body, built inline — no separate template file). Records `detail: { name,
markdown: mdPath }` per item (T110 shape), with `rootKey: cid` (this stage
keys by `place_id`, so it must explicitly pass the CID lineage back — the one
place in this workflow where `rootKey` isn't implicit). Credential:
`GEMINI_API_KEY`.

## Files

- `config.ts` — `placesConfig` (all `data/` paths), `enrichConfig` (Places API
  knobs — spend caps live on the `google-places` service, NOT here),
  `llmConfig` (Gemini knobs — spend caps live on the `gemini` service),
  `resolveConfig` (resolver knobs + its own free-tier `job_usage` caps).
- `contracts.ts` — 3 gates: `places-normalized` (ingest→resolver),
  `resolved-place-ids` (resolver→enrich), `enriched-places` (enrich→llm).
- `parse.ts` — CSV parsing helpers (`parseListFile`, CID/name extraction, plus
  `listSavedCsvFiles`/`collectResolvableCids` — the shared CSV-walk + CID-list
  helpers used by both `places-ingest` and `resolveInputKeys`).
- `types.ts` — shared shapes (`NormalizedPlace`, `ResolvedFile`,
  `EnrichedFile`, `ValidationReport`, etc.).

## Non-obvious invariants

- **`places-ingest` must stay the root stage's ledger owner** even though it's a
  bulk single-file transform, not a per-item API call — without it, the
  workflow-run Input→Output panel has no input side to pair against the
  terminal stage's output (it would render empty).
- **`enrich-with-llm` is the only stage that passes `rootKey` explicitly**
  (`rootKey: cid`) — every other stage's `item_key` already equals the root, so
  omitting `rootKey` there correctly defaults `root_key = item_key`. Dropping
  the explicit `rootKey` here would make each LLM-enriched item its own root,
  silently breaking manual run-limits.
- Both paid stages (`places-enrich`, `enrich-with-llm`) rely EXCLUSIVELY on
  their service's quota (`google-places`, `gemini`) as the spend governor —
  don't add a redundant per-job `job_usage` cap on top; it would shadow the
  service's `QuotaExceededError` soft-fail and double-meter the same calls.
