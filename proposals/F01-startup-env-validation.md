# F01: Startup validation of secrets/env for enabled workflows — config failures currently surface days later at 3am

**Type**: feature · **Priority**: P1 · **Effort**: M
**Area**: core / api / dashboard
**Backlog cross-ref**: not tracked.

## Problem

`daemon.ts` `main()` does sync → reap orphans → `startScheduler()` → `startApi()` — nothing
checks that an *enabled* workflow's credentials exist. Every workflow reads credentials lazily
inside stages (`PLEX_API_TOKEN`, `TRADING212_API_KEY_ID`, `HEVY_API_KEY`, `LAST_FM_API_KEY`,
`GEMINI_API_KEY`, …). Some stages soft-skip a missing key by design (`FINNHUB_API_KEY`,
`RYANKROL_CO_UK_PATH`), but for most, a missing/rotated key surfaces **days later at 03:00 as a
failed run**, not at deploy time. On a machine migration (F02) nothing tells you which of ~15
env vars you forgot. Loud-failure is this repo's own convention — `orphanJobNames` already makes
the daemon refuse to start over config errors.

## Design sketch

1. Optional `requiredEnv?: string[]` on `WorkflowDefinition` and/or `ServiceDefinition`
   (credentials naturally belong to services; a workflow-level list covers non-service vars
   like `PLEX_API_TOKEN`).
2. At daemon start, for each **enabled** workflow: union its own `requiredEnv` with the
   `requiredEnv` of every service its members consume — the `service_consumers` table (T186)
   already records the job→service mapping, so no new wiring.
3. Don't refuse to start (a missing Hevy key shouldn't stop Plex workflows): log
   `[daemon] CONFIG WARNING: workflow X missing env: A, B`, expose
   `configWarnings: [{ workflow, missing }]` on `GET /api/health`, render an amber banner on the
   Overview page + a warning row on the affected workflow's detail page, and optionally send ONE
   ntfy push at startup listing them.
4. Re-evaluate on workflow enable-toggle (an owner enabling a workflow with missing creds gets
   the warning immediately in the toggle response).

Pairs with: D03 (documenting the vars), B19 (validating their VALUES), F06 (the health surface).

## Acceptance criteria

- Deleting `HEVY_API_KEY` + restarting: daemon boots, logs the warning, `/api/health` lists it,
  Overview shows the banner, workouts-sync detail page shows the row.
- All keys present → zero new output.
- Docs updated (CLAUDE.md manifest field docs + README).

## Test plan

Unit: the union/validation function against fake definitions + env. API: health payload shape.
Dashboard: fixture + visual-check for the banner.
