# CLAUDE.md — src/workflows/workouts-sync/

Two stages: `hevy-sync` → `workouts-progress` (`dependsOn: ['hevy-sync']`). Runs monthly on the
1st at 06:00 (`0 6 1 * *`); nothing reads the result in real time, so a fresher cadence is not
needed. There is no static input list: workouts are discovered from Hevy on each run, and no stage
declares `inputKeys()`, so the workflow is not limitable. `category: 'regular-maintenance'`.
`maxConcurrency: 1`. Both stages have a 300 second timeout and 3 retries.

## Stage 1: `hevy-sync`

Pages through the whole Hevy workout list (`https://api.hevyapp.com/v1/workouts`, 10 per page,
every page on every run), with each request going through the `hevy` service
(`src/services/hevy.service.ts`). It then keeps the workouts the ledger does not already have and
adds their full data (title, exercises, sets) to the local history file
`data/out/workouts-history.json`. No DynamoDB. Credentials: `HEVY_API_KEY` (the stage fails if it
is not set).

A workout is synced once. A workout edited in Hevy after it was synced is not fetched again. The
history file is never pruned.

**The history file is saved BEFORE the workouts are marked synced**, and it is written
atomically. The file is what `workouts-progress` reads; the ledger only says "this workout is
already synced". The old order marked each workout done and wrote the file once at the end, so a
run killed in between left those workouts "synced" for ever while missing from the history.
A kill after the save but before the marks means the same workouts are synced again next run, so
the save replaces by workout id instead of appending, and nothing is duplicated.

## Stage 2: `workouts-progress`

Reads the history and computes a per-exercise 6-month comparison. The **current period** is the
most recently completed calendar month. The **baseline period** is the calendar month exactly 6
months before that. Three metrics:

- best single set (highest `weight_kg`, ties broken by `reps`)
- total volume (`sum(weight_kg * reps)`)
- estimated 1-rep-max (Epley: `weight_kg * (1 + reps / 30)`, the highest in the period)

Sets with a null `weight_kg` or `reps` (duration or distance exercises) are left out of all
three, and an exercise with no usable set in either period is left out entirely.

The comparison is written to `data/out/progress-data.json` on every run. It is then given to the
shared `runClaude` helper (`src/services/claude.ts`; model `WORKOUTS_PROGRESS_CLAUDE_MODEL`,
default `claude-sonnet-5`) to narrate into `data/out/workouts-progress-<YYYY-MM>.md`, named for
the current period. So the run on 1 July writes the June report. There is one file per month so
that earlier reports survive. A re-run in the same month rewrites that month's file.

Claude's reply goes through `salvageReport` (the same idea as the perfumes build stage's
`salvageProfile`): anything before the first markdown heading is dropped, because a shipped
report once began with a leaked "I can't write files..." preamble. A reply with no heading at all
fails the run so it is retried. A Claude usage limit is not a failure: the stage logs a warning,
writes no report, and the next run tries again. Any other Claude error fails the stage.

## How the stages hand data to each other (ports)

A ports workflow (see "Ports" in the root `CLAUDE.md`; artifact types in `contracts.ts`):

| Stage | Inputs | Outputs |
|---|---|---|
| `hevy-sync` | none | `history` (`workouts-history`, `workouts-history.json`, cumulative) |
| `workouts-progress` | `history` | `data` (`workouts-progress-data`, `progress-data.json`), `reports` (`workouts-progress-reports`, the monthly `workouts-progress-*.md` files in `data/out`, cumulative) |

The history grows as workouts are synced, so a run with nothing new carries it forward. An empty
history is valid: on a fresh install the stage commits an empty list. The progress stage is
handed the history the sync stage committed in the same run. `data` is recomputed every run. A
run that hits a Claude usage limit writes no report and carries the reports folder forward. The
reports share `data/out` with the other two files, so the artifact type names its own files
(`files`).

## The ledger

| Job name | Key | Row |
|---|---|---|
| `hevy-sync` | the Hevy workout id | `success` with the title, start time, and exercise and set counts. This is what makes a workout a one-time sync. |
| `workouts-progress` | the report's month (`YYYY-MM`) | `success` with the path of that month's markdown report. A re-run in the same month re-records the same row. |

The `workouts-progress` rows are read by another workflow: `vault-sync` copies one file per row
into the second-brain vault, so do not drop them. `vault-sync` also names this workflow in its
`after` list, so it waits if a `workouts-sync` run is in progress.
