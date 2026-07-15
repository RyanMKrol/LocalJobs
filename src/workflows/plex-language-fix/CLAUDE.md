# CLAUDE.md — src/workflows/plex-language-fix/

Plex only supports ONE global default-audio-language preference for the whole server — wrong for any
library whose original language isn't English, and even a foreign-language title's own baked-in file
default (its `default` flag) isn't guaranteed to match, since it's a per-file authoring choice, not a
per-language server setting. This workflow builds a per-title, original-language-aware replacement:
resolve each show/movie's TRUE original language via TMDB, then work out which audio/subtitle track
SHOULD be selected by default per file versus what's currently selected.

## Four members (T453) — read-only → read-only → read-only → mutating

```
plex-language-discover → plex-language-resolve → plex-language-evaluate → plex-language-apply
```

- **`plex-language-discover`** (read-only, the DAG's ROOT — declares `inputKeys()` with
  `inputKeysService: 'plex'`, so this workflow is limitable for the first time) walks every configured
  Plex library section and records every file (a movie, or a TV episode) on the `work_items` ledger,
  keyed `${itemRatingKey}::part${partId}`, with `detail: { name, file, itemRatingKey, partId, type,
  tmdbId, seasonEpisode? }` — `tmdbId` is extracted from the title's own Plex Guid, so this stage makes
  NO TMDB call. It always walks the whole library fresh (so a newly added file is found) but never
  re-marks a file already known — see "Idempotency" below for what that does and doesn't buy you.
  **`discoverInputKeys()` (T485) does a LIVE Plex library walk, not a ledger read-back.** `discover.ts`
  factors the section/item/leaf walk into a shared `walkLibraryFiles` helper — the SAME implementation
  `runDiscover` itself uses (via hooks, so `runDiscover` keeps its verbose `ctx.log`/`ctx.progress`
  narration while `discoverInputKeys` just needs the resulting key set) — routed through `lib.ts`'s
  `fetchSections`/`fetchSectionItems`/`fetchItemDetail`/`fetchAllLeaves`, which already go through
  `callService('plex', ...)` (T578). `discoverInputKeys` is therefore `async`, returning
  `Promise<string[]>`, computed fresh on every call rather than by reading this job's own prior
  `work_items` success rows. This replaces an earlier ledger-readback implementation
  (`ledgerSuccessRows(JOB_NAME).map(...)`) that had a self-referential trap: after "Clear output data"
  wipes this workflow's ledger, that version had nothing to read back and silently returned `[]`, so a
  manually-limited run selected zero roots and no-op'd instead of re-discovering the library. Known,
  accepted tradeoff: every manual limited-run request now pays the cost of a full/partial library crawl
  just to compute candidate keys — correct versus silently no-opping on a reset ledger.
- **`plex-language-resolve`** (read-only, `dependsOn: discover`) looks up each not-yet-resolved file's
  show/movie's true original language + candidate spoken languages via TMDB, routed through
  `callService('tmdb', () => lookupLanguageDetail(tmdbId, type), { cacheKey: 'tmdb-language:<type>:<tmdbId>'
  })` — the opt-in 5-minute response cache (`CallServiceOpts.cacheKey`, `src/core/services.ts`). Because
  the cache key is the SHOW's tmdb id (not the file), every other episode of the same show resolved
  within the same run reuses the cached response — a show with 20 not-yet-resolved episodes makes ONE
  real TMDB call, not 20 — while every file still gets its own permanent ledger row
  (`detail: { name, originalLanguage?, candidateLanguages[] }`). A hit TMDB day/month quota
  (`QuotaExceededError`) is caught per-file and stops the run gracefully; the file is left un-done and
  retried automatically once the quota resets.
- **`plex-language-evaluate`** (read-only, `dependsOn: discover, resolve`) fetches each not-yet-evaluated
  file's LIVE current Plex stream selection and compares it against resolve's candidate languages
  (reusing `evaluatePart`/`pickAudioCandidate` from `lib.ts`) to decide a 2-value outcome —
  `'change'` or `'skip'` (`FileStatus` in `types.ts`) — recording
  `detail: { name, status, currentAudio, currentSubtitle, proposedAudio?, proposedSubtitle? }`. The
  current selection is captured HERE (not re-fetched at apply time) so apply can record a real
  before/after in its undo log without a second live fetch.
- **`plex-language-apply`** (MUTATING, `dependsOn: evaluate`) reads every file evaluate flagged
  `status: 'change'` that this stage has not ALREADY applied and applies the proposed audio (and, when
  set, subtitle) selection via Plex's own official
  `PUT /library/parts/<id>?audioStreamID=&subtitleStreamID=&allParts=1` endpoint — the same call Plex's
  own clients make when a user manually picks a track (`plexPutStreams` in `src/core/plex-client.ts`,
  shared there rather than kept workflow-local since it's a Plex-generic mutating primitive, like
  `plexGet` is a Plex-generic read).

**A third member from an earlier design, `plex-language-no-track-flag`, was deliberately removed
(T452) with no replacement — don't re-add it without a fresh ask.** It used to flag files with NO audio
track at all in their title's true original language (a probable wrong-release signal); the owner
decided this signal wasn't worth keeping.

## Idempotency: "process each file exactly once, ever" (T453; NOT a re-scan)

This workflow used to be a single `plex-language-scan` stage that re-read the whole library fresh
every run (mirroring `plex-space-saver`). **T453 replaced that model entirely.** Every one of the four
stages above keys its `work_items` ledger row by the SAME `${itemRatingKey}::part${partId}` (no
lineage args needed — a same-key chain, like `perfumes`) and, once a file has a `success` row for a
given stage, that stage never touches it again:

- `discover` never re-marks a file it already knows (though it still re-WALKS Plex every run to find
  NEW files — see the stage's own doc above).
- `resolve` never re-looks-up a file it has already resolved (this is what makes the TMDB cacheKey
  dedup meaningfully cheap: without this, EVERY run would re-resolve every file, cache or not).
- `evaluate` never re-evaluates a file it has already evaluated. **Trade-off, deliberately accepted:**
  a real-world drift AFTER a file's evaluation (someone manually re-picks a track in Plex, a new audio
  track gets muxed in) is NOT automatically re-detected — the old re-scan-every-run design would have
  caught this on the next weekly run; this design does not. Re-evaluating requires manually unsticking
  (or deleting) that file's `plex-language-evaluate` ledger row.
- `apply` never re-applies a file it has already applied — PERMANENTLY, even if `evaluate`'s ledger row
  for that file is later re-flagged `'change'` by some future change to the evaluate logic. Re-applying
  requires the operator to manually unstick `apply`'s ledger row for that file
  (`POST /api/stuck/unstick`) — there is no automatic re-apply path, by design.

**Why the change:** the old model repeated the (cheap) Plex walk AND the (TMDB-quota-costing) language
resolution AND the (mutating) apply-eligibility check every single week for the owner's entire library,
even though almost nothing changes week to week. The new model only ever spends TMDB quota and Plex
Butler-backup-guarded mutations on a file the FIRST time it's seen — this workflow is limitable
(`plex-language-discover` declares `inputKeys()`) for exactly this reason: a manual run can now be
scoped to "just the N newest files" instead of the whole library.

`stages/ledger.ts` is this workflow's own helper for reading a prior stage's `work_items` rows (every
`'success'` row for a job name, with its parsed `detail`) — it imports the shared `db` handle from
`src/db/index.ts` directly rather than going through `src/db/store.ts` (which has no generic
"every row for a job" query), a deliberate, scope-driven exception to the "all SQL goes through
store.ts" convention, confined to this one workflow-local file. Read-only, never a paid/remote call.

## The evaluate → apply gate is a REAL pre-mutation check, not the trivial minimum (T574)

`contracts.ts`'s three gates all read the ledger via `stages/ledger.ts`, but they are NOT uniformly
trivial. `plexLanguageDiscoverContract`/`plexLanguageResolveContract` stay the sanctioned trivial
"the ledger is readable" minimum (per `src/workflows/CLAUDE.md`'s gate rule) — there's no meaningful
artifact shape to assert before those read-only stages. `plexLanguageEvaluateContract`, however, sits
directly in front of `plex-language-apply` — the repo's ONLY externally-mutating stage — so it asserts
something real: every `plex-language-evaluate` ledger row with `detail.status === 'change'` must carry
a numeric `detail.proposedAudio.streamId` AND a non-null `detail.currentAudio`. This is exactly the
malformation `apply.ts` currently checks for and silently skips at runtime (`!discover ||
typeof evalDetail.proposedAudio?.streamId !== 'number'`, `stages/apply.ts` ~line 54) — the gate now
catches an evaluate-logic drift LOUD, at the boundary, before any file reaches the mutating Plex call,
instead of it quietly showing up as a "skipped as malformed" apply-run log line. An empty ledger, or
one where every row is `'skip'`, passes trivially (nothing to apply). Covered by
`lib.test.ts` (valid change/skip rows → pass; a `'change'` row missing `proposedAudio.streamId` or with
a null `currentAudio` → fail, naming the offending `itemKey`).

## Fully unattended — no per-run manual sign-off, by explicit owner decision

The owner does not want to review every run by hand; this runs on the workflow's weekly schedule with
no approval gate. Every `'change'` entry (including what would previously have been flagged an
ambiguous channel-count tie) is applied the same way, using `evaluate`'s best-judgment pick. In place
of manual review, two safety nets stand in:
1. **Plex Butler backup, triggered once per run before the first real PUT** (`triggerButlerBackup()` in
   `src/core/plex-client.ts`, `POST /butler/BackupDatabase`) — validated live to produce a real dated
   backup within about a minute. A failed trigger only logs a WARN; it does not block applying (the
   per-file undo log below is the primary safety net, Butler the secondary one).
2. **A self-contained per-run applied-changes log**, `data/out/applied-log-<ISO-timestamp>.json`,
   recording every applied (or failed) file's `partId`, path, and BOTH its before AND after
   audio/subtitle selection (the before-state comes from `evaluate`'s recorded `currentAudio`/
   `currentSubtitle`, not a fresh fetch) — so a revert never needs to cross-reference any other file.
   The manual, NEVER-scheduled `scripts/plex-language-undo.ts` (top-level `scripts/`, run directly by
   the owner: `tsx scripts/plex-language-undo.ts [--apply] [path]`, dry-run by default) reads the most
   recent (or a given) log and reverts every `'applied'` entry back to its recorded before-state.
`plex-language-apply` records every processed file on the `work_items` ledger (`success`/`failed`) and
throws (failing the run itself) if any file failed to apply this run, per the repo-wide item-loop
convention.

**Ambiguous ties are NOT a thing here — the owner explicitly ruled it out.** `FileStatus` has exactly 2
values — `'change' | 'skip'` — and every tie resolves automatically via the existing best-judgment
heuristic in `lib.ts`'s `pickAudioCandidate` (prefer an explicitly-labelled "Original" mix, then
highest channel count, then higher-quality codec, then lowest stream index).

## Shared Plex/TMDB connectivity

Like the other five Plex-touching workflows (`missing-tv-seasons`, `movie-recommendations`,
`plex-space-saver`, `tv-recommendations`, `plex-profiles`), this workflow reuses the shared,
self-contained `src/core/plex-client.ts` (`plexGet`/`tmdbGet`, DHCP-self-heal LAN scan) rather than
duplicating connectivity — see that file for the mechanism. Plex connectivity is metered via the shared
`plex` service (`callService('plex', ...)`). TMDB lookups route through the shared rate-limited `tmdb`
service (`callService('tmdb', ...)`, same as `missing-tv-seasons`). `lib.ts`'s `extractTmdbId` (used by
`discover.ts` to pull each title's tmdb id off its Plex Guid array) is a thin re-export of
`src/core/plex-client.ts`'s shared `extractTmdbId` (T586), not a separate implementation.

**Plex reads are response-cached for a 3-hour window (T477).** Every `lib.ts` Plex read helper
(`fetchSections`, `fetchSectionItems`, `fetchItemDetail`, `fetchAllLeaves` — all four used only by the
read-only `discover`/`evaluate` stages) passes a `cacheKey` derived from the request path
(`plex:<path>`) to `callService('plex', ..., { cacheKey })`, engaging the `plex` service's 3-hour
cache TTL (T476) — a second read of the SAME Plex resource within that window (e.g. another
Plex-touching workflow triggered back-to-back via the admin "Run all workflows" button) is served
from cache instead of hitting Plex again. This is separate from `resolve`'s own TMDB `cacheKey`
dedup above, which caches the `tmdb` service's 5-minute default TTL, not `plex`'s. Each `lib.ts`
Plex read helper takes an optional low-level `fetchPlex` override (defaulting to the real `plexGet`),
still routed through `callService`, so the cache dedup itself is unit-tested (`lib.test.ts`) without a
live Plex call. **`plex-language-apply`'s mutating `plexPutStreams`/`triggerButlerBackup` calls are
NEVER cached** — a mutation must never be short-circuited by a stale cached response.

## Sections scanned

The movie and TV sections reuse the SAME `PLEX_MOVIE_SECTION`/`PLEX_TV_SECTION` env vars every other
Plex workflow already reads (no duplicate env vars). A third, lower-confidence "downloadable" section
is opt-in only: `PLEX_DOWNLOADABLE_SECTION` is unset by default (excluded from the scan); setting it to
a Plex section key includes that section too.

## Testing — every Plex/TMDB touchpoint is an injectable seam

None of `discover`/`resolve`/`evaluate`'s exported `run*` functions call `plexGet`/`tmdbGet` directly —
each accepts an `opts` object (`PlexFetchOverrides` / `TmdbLookupOverrides`) whose fields default to the
real `lib.ts` functions, mirroring `apply.ts`'s pre-existing `PlexClientOverrides` pattern for
`putStreams`/`triggerBackup`. Tests inject fakes and assert real behaviour (ledger rows, call counts) —
never a live Plex/TMDB call, never `global.fetch` monkey-patching. `stages/*.test.ts` cover: correct
ledger keys/detail per stage, a second run not re-processing an already-done file (proving the
"process once, ever" idempotency), the resolve-stage TMDB cacheKey dedup (one real lookup for many
episodes of the same show), and apply never re-touching an already-applied file even after evaluate
re-flags it. `lib.test.ts` covers the pure `evaluatePart` tie-breaking logic directly.

## Retained from validated exploration, don't simplify away

The commentary/description stoplist and the "Signs & Songs"-only English subtitle classifier
(`isSignsOrSongsOnly`/`SIGNS_SONGS_PATTERN`/`FULL_DIALOGUE_OVERRIDE` in `lib.ts`) — both were found live
against the owner's real library and catch real bugs (a Songs & Signs-only subtitle paired with foreign
audio leaves dialogue unsubtitled).
