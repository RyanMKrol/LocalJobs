# F16: Per-workflow improvements batch — TMDB collection caching, the no-GUID dead end, capped-recs memory, post-evaluate drift tool

**Type**: feature (batch) · **Priority**: P3 · **Effort**: S–M per item
**Area**: workflows
**Backlog cross-ref**: item 1 relates T477/T479 (pending: service response-caching adoption decisions) — decide alongside them. `plex-profiles` phase 2 (Claude narration) is already documented-deferred with a clean extension point; not re-proposed here.

## Items

1. **`franchise-gaps` re-fetches `/movie/{id}` for the ENTIRE library monthly** just to
   re-learn the mostly-static `belongs_to_collection` mapping — the single biggest TMDB spend in
   the repo, and the direct cause of B16's quota-hit scenario. Cache `tmdbId → collectionId` in
   a ledger (a `work_items` keyspace fits) or via the T451 `cacheKey` service-cache mechanism
   with a long TTL, the way `plex-language-resolve` already caches. Re-resolve only unknown ids
   + a small monthly refresh sample. Cuts the monthly TMDB burn by ~an order of magnitude.
2. **missing-tv-seasons: a no-GUID show permanently fails every run**, and both Unstick and
   Ignore are documented non-fixes (the check stage re-marks it failed fresh each run). Real
   fix: `tmdb-season-check` consults `ignoredItemKeys('tmdb-season-check')` before re-marking,
   so an owner's Ignore actually silences a show with no TMDB id. (Documented "accepted rough
   edge" in the workflow's CLAUDE.md — this closes it properly.)
3. **Recommenders discard verified-but-genre-capped suggestions unremembered**
   (`merge.ts` ~379–383 logs and keeps nothing): next month can re-suggest the same title and
   re-spend TMDB verification on it. Feed capped survivors into `alreadySuggested`/history, or
   mark them `skipped` in the recs ledger so the dedup sees them. (Fold into R01 if that lands
   first.)
4. **plex-language-fix post-evaluate drift**: each file is processed exactly-once-ever by
   design, so a later-added audio track or changed edition is never re-examined — documented
   trade-off. Close it cheaply with a manual, never-scheduled admin script
   (`scripts/plex-language-reevaluate.ts --older-than <date>`) that deletes the evaluate/apply
   ledger rows for selected keys so the next run re-processes them — the same manual-tool shape
   as `plex-language-undo.ts`.
5. **`stocks-watch` breach threshold hardcoded at 30%** — the only non-env-overridable knob of
   its kind; add `STOCKS_WATCH_BREACH_PCT` (+ `.env.example`, docs). *(Also listed in Q07 —
   implement once.)*

## Acceptance criteria

Per item: behavior verified by a unit test (1: second run's TMDB call count ≈ 0 for known ids;
2: ignored no-GUID show produces no failed row; 3: a capped title isn't re-suggested next
cycle; 4: script re-queues exactly the selected keys, dry-run by default). Workflow CLAUDE.mds
updated where a documented limitation is closed (docs-as-Done).
