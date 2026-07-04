# CLAUDE.md — src/workflows/workouts-sync/

Two-stage DAG: `hevy-sync` → `workouts-progress` (`dependsOn: ['hevy-sync']`). Runs monthly (1st,
06:00) — a same-day-fresh cadence isn't needed since nothing downstream reads it in real time.
No static input list — workouts are discovered live from Hevy each run (like the Plex audit
workflows). `category: 'regular-maintenance'`.

**Stage 1 (`hevy-sync`)** paginates the Hevy workout API (`https://api.hevyapp.com/v1/workouts`,
rate-limited via `src/services/hevy.service.ts`) and appends each newly-synced workout's full data
(title, exercises, sets) to a local, full-history JSON file (`data/out/workouts-history.json`) — no
DynamoDB. Idempotent per workout id via the `work_items` ledger: already-synced ids are skipped, new
ones are appended, so the history file only ever grows (never rewritten/pruned). Credentials:
`HEVY_API_KEY`.

**Stage 2 (`workouts-progress`)** reads the full history file and computes a per-exercise 6-month
progress comparison — **baseline period = the calendar month exactly 6 months before the current
period; current period = the most recently completed calendar month** — across three metrics:
- best single set (highest `weight_kg`, ties broken by `reps`)
- total volume (`sum(weight_kg * reps)`)
- estimated 1-rep-max (Epley: `weight_kg * (1 + reps / 30)`, max across the period)

Sets with a null `weight_kg`/`reps` (duration/distance-based exercises) are skipped from all three
metrics; an exercise with no usable sets in either period is excluded entirely. The raw comparison is
written to `data/out/progress-data.json`, then fed to the shared `runClaude` helper
(`src/services/claude.ts`) to narrate it into `data/out/workouts-progress.md`. Idempotent per
calendar month via the `work_items` ledger (mirrors `listening-digest`) — a manual re-run the same
month regenerates the report (same static filename) rather than duplicating it.
