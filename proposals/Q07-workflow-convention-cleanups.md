# Q07: Workflow convention cleanups — rootAllowed miss, invisible StageIoPanels, rate-limit-as-hard-failure, log-prefix noise, nameless ledger rows, one real gate for the mutating stage

**Type**: quality/convention (batch) · **Priority**: P3 · **Effort**: M
**Area**: workflows

## Items

1. **`github-sync` ledger ignores `ctx.rootAllowed`** (`github-sync.ts` ~188–202) — the only
   T094 first-stage-rule violation found in a full lineage audit (everything else, including all
   key-changing stages' `rootKey` args, is clean). On a LIMITED manual run of projects-sync the
   first stage marks EVERY catalog entry, so the ledger/IO panel reflect the full set instead of
   the selected roots. Fix: `entries.filter((e) => ctx.rootAllowed(e.repoId))` around the
   marking loop only (the catalog file stays full, mirroring places-ingest).
2. **movies/tv-recs stages record NO `work_items`** for snapshot/branch/merge — so the run
   page's StageIoPanel is empty for 10 of 11 stages in each. `missing-tv-seasons` stages 1–2
   were retrofitted for exactly this visibility. Fix: one combined row per run — snapshot
   `{ movies: N, path, format: 'json' }`, per-branch `{ suggestions: n, path }`, merge
   `{ balanced: n, path }` — the stocks/stock-digest day/week-key pattern. (Coordinate with R01;
   trivial to add inside the shared pipeline.)
3. **Claude rate-limit treated as hard failure in 3 jobs** (`workouts-progress.ts` ~247–249,
   `stock-digest-build.ts` ~271–273, `project-summarize.ts` ~244–246): `if (!result.ok) throw`
   collapses `result.rateLimited` into generic failure — the job burns `maxRetries` against a
   limit that won't clear in minutes, and project-summarize keeps hammering every remaining repo
   after the first rate-limited one. Perfumes/movies/tv-recs treat rateLimited as a soft pause.
   Fix: check `rateLimited` → warn + soft-return (single-artifact stages) / break the loop
   (project-summarize).
4. **`"info:"/"warn:"` prefixes baked into log messages**, sometimes WITHOUT the matching level
   arg (`stocks-resolve-names.ts:82`, `stock-portfolio-snapshot.ts:106` log `warn:`-prefixed
   text at info level → the dashboard won't colour them). Sweep the T415-era workflows: drop the
   prefixes, always pass the level.
5. **`stocks-watch` per-run check rows have no `name`** (`stocks-watch.ts` ~136–138:
   `{ gainPct, breaching }`) — the only nameless ledger rows in the repo; the IO panel renders
   them blank-labeled. Add the ticker/name.
6. **`plex-language-fix` gates assert nothing** (`contracts.ts` ~37, 54, 71 — all three return
   `ok: true` unconditionally). Sanctioned as a trivial minimum, BUT this DAG ends in the repo's
   ONLY externally-mutating stage. The evaluate→apply gate can cheaply assert something real:
   "every `status:'change'` row has a numeric `proposedAudio.streamId` and a `currentAudio`" —
   exactly the malformation `apply.ts` (~53–56) currently skips at runtime — catching
   evaluate-logic drift BEFORE mutation. ~15 lines, high leverage.
7. **`BREACH_THRESHOLD_PCT` hardcoded 30** (`stocks-watch.ts:12`) — the only
   non-env-overridable tuning knob of its kind. Add `STOCKS_WATCH_BREACH_PCT` (+ `.env.example`
   + docs).
8. **`listening-digest` two near-identical ~70-line passes inline** — refactor to
   `runPass(period, key, label)` loop (pairs with B28's month-label fix).

## Acceptance criteria

Per item: existing tests green; new small tests for 1 (limited-run ledger scoping), 3
(rateLimited → soft outcome), 6 (gate rejects a malformed change row). Docs updated where a
convention example changes.
