# CLAUDE.md — working in this repo

Guidance for Claude when asked to change or extend this project.

## ⛔ Every session: read first, before any work

At the START of every session in this repo — before planning, answering, or
editing anything — **read these in full so you have current context:**

1. **This file (`CLAUDE.md`)** — architecture, conventions, how to add jobs.
2. **`README.md`** — what the app does and how it runs.

These are the source of truth for how this project works between sessions. They
are kept deliberately up to date (see the rule below), so trust them — but if
you find them contradicting the code, the code wins: fix the docs to match and
flag it to the user. Do not start work assuming you remember this project from a
previous session; re-read.

## ✅ Documentation is part of every change (Definition of Done)

**Any change to this repo is not "done" until the docs are updated in the same
change.** Keeping `CLAUDE.md` and `README.md` current is not optional cleanup —
it is part of the task. Treat stale docs as a bug.

Update the docs **as you go**, in the same edit/commit as the code, whenever you
change any of:

- **Jobs** — added/removed/renamed a job, or changed its schedule/behaviour
  → update the job list/roadmap in `README.md`.
- **Architecture or data flow** — new module, changed how the daemon/executor/
  scheduler/dashboard interact, new table/column → update the architecture
  section + file map in both files.
- **Commands, ports, or services** — new npm script, port change, new launchd
  agent, changed install/restart steps → update both files.
- **Conventions** — a new rule about how code in this repo should be written
  → add it to the Conventions section here.
- **Config** — new env var → update `.env.example` AND the config tables.

Before declaring a task complete, run this checklist:
1. Does `CLAUDE.md` still accurately describe how to work in the repo?
2. Does `README.md` still accurately describe what the app does and how to run it?
3. Did I add/rename anything that should appear in the file map, ports table, or
   job list?

If yes to a change and the docs don't reflect it, the task is **not done**.

## 🔐 Secrets & git hygiene (non-negotiable)

This repo is **public**. Two hard rules:

1. **Never commit credentials.** No API keys, AWS/GCP secrets, tokens, passwords,
   or private endpoints in any tracked file — not in code, not in docs, not in
   `.env.example` (use placeholders there). All secrets live in `.env`, which is
   gitignored and read via `process.env`. If a job needs a credential, document
   the env var name in `.env.example` and read it from the environment.
2. **Never commit private jobs.** The framework is public; the owner's actual
   jobs are not. Top-level `src/jobs/*.job.ts` files are gitignored (except
   `demo.job.ts`). The `places/` and `perfumes/` subfolders are tracked as
   published examples — any new private pipeline should live in its own subfolder
   added to `.gitignore`. Do not force-add private files.

Before any commit: `git status` and confirm no `.env`, no real `*.job.ts`, and
no credentials are staged. If you ever spot a secret about to be committed, stop
and tell the user.

## What this project is

`local-jobs` is a self-hosted job orchestrator + dashboard that runs on an
always-on **Mac Mini**. Its purpose is to host **long-running / headless local
work** that doesn't fit serverless or a web request — most importantly the
owner's "places second brain" pipeline (headless CID→place_id resolution, then
Google Places API enrichment, writing to DynamoDB). Those will be added here as
jobs. Until then there is a `demo` job for testing.

Keep it **simple, local, and dependency-light**. This is a personal tool, not a
distributed system. Do not introduce Docker, external databases, message
queues, or cloud infra unless explicitly asked.

## Architecture (how it fits together)

```
launchd ──keeps alive──▶ daemon (src/daemon.ts)
                            │  scheduler (croner) ──schedules─┬─▶ executor ──spawns──▶ child (src/runJob.ts)
                            │  HTTP API on :4789              │    (single job,           runs ONE job,
                            │                                 │     timeout/retries)       emits NDJSON
                            │                                 └─▶ pipeline-executor
                            │                                      (orchestrates member
                            ▼                                       jobs in DAG order)
                         SQLite (data/jobs.db, WAL)  ◀── parent is sole writer
                            ▲
                         dashboard (Next.js, :4788) ── polls the API, read-only
```

- **The daemon is the only long-lived process.** launchd keeps ONE daemon
  alive; the daemon schedules ALL jobs AND pipelines internally. Never create one
  launchd agent per job.
- **Each job runs in an isolated child process** so a hang/crash can't take down
  the daemon, and timeouts can hard-kill it (SIGTERM→SIGKILL).
- **Pipelines** compose existing jobs into a DAG. The pipeline executor runs member
  jobs in topological order (respecting `dependsOn` edges and bounded parallelism)
  via the same executor. A pipeline run is a first-class DB record distinct from
  each member job's own run.
- **The child only emits events; the parent (executor) is the sole DB writer.**
- **The dashboard is a pure read/refresh client of the API.** It never touches
  SQLite directly and is not required for jobs to run.

## File map

| Path | Responsibility |
|---|---|
| `src/config.ts` | Env-driven config: ports, db path, ntfy |
| `src/daemon.ts` | Long-lived entrypoint: sync jobs + pipelines, reap orphans, start scheduler + API |
| `src/runJob.ts` | Child entrypoint: run one job, emit NDJSON |
| `src/core/types.ts` | `JobDefinition`, `PipelineDefinition`, `ServiceDefinition`, `JobContext`, event types — the contracts |
| `src/core/executor.ts` | Spawn child, parse events, enforce timeout, retries, overlap-prevention |
| `src/core/scheduler.ts` | croner triggers for scheduled jobs + pipelines; respects `enabled` |
| `src/core/dag.ts` | Pipeline DAG: build + validate topological order, cycle detection |
| `src/core/pipeline-executor.ts` | Orchestrate a pipeline run: member jobs in DAG order, stage gates, retries |
| `src/core/notifier.ts` | Run alerts (success/failure/timeout) with item counts + stuck heads-up: ntfy push + macOS notification |
| `src/core/services.ts` | `callService`: cross-job shared rate-limit + quota middleware (coordinated via SQLite) |
| `src/db/schema.sql` | `jobs`, `runs`, `run_logs`, `work_items`, `job_usage`, `pipelines`, `pipeline_jobs`, `pipeline_runs`, `pipeline_run_logs`, `services`, `service_usage` |
| `src/db/index.ts` | SQLite connection + schema bootstrap (WAL mode) |
| `src/db/store.ts` | ALL queries live here — add new ones here, not inline |
| `src/jobs/registry.ts` | Auto-discovers `*.job.ts`, `*.pipeline.ts`, and `*.service.ts` files (no manual registration) |
| `src/jobs/*.job.ts` | One job per file, default-exporting a `JobDefinition` (root-level files gitignored except demo; subfolder jobs in `places/`+`perfumes/` are tracked) |
| `src/jobs/*.pipeline.ts` | Pipeline manifests, default-exporting a `PipelineDefinition` (DAG of jobs) |
| `src/jobs/*.service.ts` | Service definitions, default-exporting a `ServiceDefinition` (shared rate-limited dependencies) |
| `src/api/server.ts` | Node `http` API (no framework). Add routes here |
| `dashboard/app/*` | Next.js App Router dashboard (client components, poll via `app/lib/api.ts`) |
| `scripts/*` | launchd install scripts + start wrapper |

## How to add a job (the common request)

1. Create `src/jobs/<name>.job.ts`:
   ```ts
   import type { JobDefinition } from '../core/types.js';

   const job: JobDefinition = {
     name: 'unique-name',           // stable; it's the DB primary key
     description: 'what it does',
     instructions: 'optional setup steps shown on the dashboard job page',
     schedule: '0 3 * * *',         // croner cron, or null for manual-only
     timeoutMs: 600_000,            // 0 = no timeout
     maxRetries: 1,
     async run(ctx) {
       ctx.log('message');          // -> run_logs, shown live in dashboard
       ctx.progress(50, 'halfway'); // -> progress bar 0..100
       // ...work... throw to fail the run
     },
   };
   export default job;
   ```
2. That's it for wiring — jobs are **auto-discovered** by filename glob
   (`*.job.ts`). There is **no registry to edit**.
3. Tell the user to restart the daemon (jobs are loaded at startup):
   `launchctl kickstart -k gui/$(id -u)/com.ryankrol.localjobs`

> **Privacy — real jobs are local-only by default.** Top-level
> `src/jobs/*.job.ts` files are gitignored (only `demo.job.ts` is tracked). The
> public repo also ships the `places/` and `perfumes/` subfolder pipelines as
> worked examples, but their `data/` folders stay gitignored. New jobs you add as
> a root-level `*.job.ts` stay untracked by design. NEVER use `git add -f` on a
> private job file.
>
> For a **new private multi-file pipeline**, create `src/jobs/<name>/` and add the
> line `src/jobs/<name>/` to `.gitignore`. Jobs are discovered **recursively**,
> so a `*.job.ts` inside that folder is picked up automatically while its helper
> modules stay private too.

### Job conventions
- Jobs must be **idempotent / safe to re-run** (they retry and can be run
  manually). Use guards / "skip if already done".
- Use `ctx.log` and `ctx.progress` generously — that's the entire visibility
  story. No `console.log` (it still gets captured, but prefer `ctx`).
- Keep secrets in `.env` (read via `process.env`); never hardcode. The child
  inherits the daemon's env.
- Long jobs: set a realistic `timeoutMs` so a hang is killed, not left forever.
- Heavy external calls (Places API, headless browser): rate-limit inside the
  job, and make progress observable.

## Logging — be verbose by default

**Always prefer the most verbose logging you can get away with. Err on
over-logging, never under-logging.** Storage is not a concern — kilobytes of
logs per run is completely fine.

Every job should narrate itself through `ctx.log()` so its run page tells the
full story without anyone reading the code:
- What it's about to do, and the config/paths/inputs it's using.
- Each meaningful item as it's processed (per-list, per-record), not just totals.
- Every decision: skips, merges, dedupes, retries, fallbacks — and *why*.
- A detailed final summary: totals, per-category breakdowns, notable items
  enumerated, where output was written, and the validation result.

Use levels (`info` / `warn` / `error`) so the dashboard can colour them. When in
doubt, log it.

## Conventions
- TypeScript, ESM, **NodeNext** — always use `.js` extensions in relative
  imports (e.g. `import { x } from './foo.js'`), even for `.ts` files.
- All SQL goes through `src/db/store.ts`. Don't scatter `db.prepare` calls.
- **Idempotency — per-item work ledger (the standard).** For jobs that process
  many items, record each item's outcome in the `work_items` SQLite table via
  `src/db/store.ts` (`isWorkItemDone`, `markWorkItem`, `workItemCounts`), keyed by
  `(jobName, itemKey)`. Re-runs skip items already done (success, or failed past
  `maxAttempts`) so work is never reprocessed. The whole places pipeline uses this
  (resolver by CID, enrich + LLM by place_id); the rich output still goes to the
  job's `data/` files — the ledger just tracks *what's done*. Don't use ad-hoc
  "skip if it's in the JSON file" checks.
- **Spend / usage caps.** For jobs that make metered external calls (paid APIs),
  enforce per-day AND per-month caps via the `job_usage` meter in `src/db/store.ts`
  (`recordUsage`, `capStatus`). Call `recordUsage(jobName)` once per real action;
  check `capStatus(jobName, dailyCap, monthlyCap)` in the loop and stop gracefully
  when `!allowed`. Convention: daily cap = monthly cap / 10 (so manual re-runs
  don't blow the month) — but a **daily-scheduled** job/pipeline must use daily =
  monthly / 30, so a full month of daily runs exactly fits the monthly ceiling and
  a single day's run can never blow it (see the places pipeline's
  `DAILY_SPEND_DIVISOR`). Caps live in the job's config, env-overridable.
- **Services (cross-job shared APIs).** For an external dependency called from
  multiple jobs (e.g. Gemini, Google Places, Fragrantica, Claude CLI), define a
  `ServiceDefinition` in a `*.service.ts` file and call the API through
  `callService(name, fn)` from `src/core/services.ts`. This coordinates rate
  limits and quotas across all job processes via the SQLite `service_usage` meter.
  See `places/gemini.service.ts` and `perfumes/fragrantica.service.ts` for worked
  examples. The simpler per-job `recordUsage`/`capStatus` on `job_usage` still
  exists for single-job-only metering when cross-job coordination isn't needed.
- **Validation gates between pipeline stages (typed artifacts).** A job may
  declare `produces` and/or `consumes` — arrays of `ArtifactContract`
  (`{ key, description?, check() }`) in `src/core/types.ts`. For every pipeline
  **edge** where the upstream `produces` a key the downstream `consumes`, the
  pipeline executor runs both contracts' `check()` at that boundary — producer
  side (output well-formed) right before, consumer side (input acceptable) — and
  a `check` returning `ok:false` (or throwing) is a **gate violation**: the
  consumer never spawns, a first-class **failed** run is recorded
  (`recordGateFailure`, error = the exact drift), a stage notification fires, and
  the failure cascades to the consumer's own dependents. This is how an
  external-format drift (Takeout CSV layout, Fragrantica page structure) fails
  LOUD at the exact gate instead of feeding bad data downstream. The `check`
  should inspect the REAL artifact (read the `data/` file, sniff the scraped
  page) and return precise per-drift `violations`. Gate derivation
  (`deriveGates`) lives in `src/core/dag.ts` (pure, edge-scoped — a consumed key
  with no producing upstream is an external input, not a gate); enforcement lives
  in `src/core/pipeline-executor.ts`.
- **Job resources are job-local.** A job's input/output data lives in its own
  `data/` folder next to the code (e.g. `src/jobs/places/data/{raw,out}`),
  referenced relative to the job's file — not in a far-off top-level folder.
  These are gitignored via `src/jobs/**/data/`.
- **The repo is self-contained — no absolute paths to other folders on the
  machine.** A job's config/template/resource files live in-project and are
  resolved relative to the job dir (`resolve(here, '…')`), never hardcoded to an
  external repo. Make them env-overridable where a path might legitimately vary
  (e.g. `PERFUMES_TEMPLATE_PATH` defaults to the in-project
  `src/jobs/perfumes/profile.template.md`). A bare `/Users/...` in tracked job
  code is a bug — it leaks the machine's topology and breaks on any other host.
- **Run the checks on every change** — `npm test` (the unit suite) AND
  `npx tsc --noEmit` (daemon typecheck), plus `npm run build` in `dashboard/` for UI
  changes — before declaring done. Keep the suite green; **add unit tests for new
  behaviour as you build it** (tests live in `*.test.ts`; `npm test` discovers + runs
  them against a scratch DB). Never declare done on red.
- **Commit + push as you go.** Make small, atomized commits as each coherent change
  lands (one per layer/feature — not a big-bang), and **push each commit immediately**
  — don't wait to be asked. (Respect the git hygiene rules above: never commit
  credentials or the gitignored private job folders / `TODO.md`.)
- After ANY change to `src/`, the daemon must be restarted to take effect.
  After UI changes, rebuild the dashboard and restart its agent.

## Ports & services
- **API / daemon:** `http://127.0.0.1:4789`
- **Dashboard:** `http://localhost:4788`
- launchd agents: `com.ryankrol.localjobs` (daemon),
  `com.ryankrol.localjobs-dashboard` (dashboard). Install via
  `scripts/install-launchd.sh` and `scripts/install-dashboard-launchd.sh`.

## Gotchas
- The in-process scheduler can't fire while the Mac sleeps — the Mini must stay
  awake (`sudo pmset -a sleep 0 disablesleep 1`).
- Changing job code without restarting the daemon = no effect.
- SQLite datetimes are UTC strings without `Z`; the dashboard appends `Z` when
  parsing (see `app/ui.tsx`). Preserve that.

## Autonomous build harness (Ralph loop)

An autonomous builder (`.harness/loop.sh`, design in `.harness/HARNESS.md`) can grind through a
curated backlog one fully-verified task at a time. The whole harness lives under the hidden
`.harness/` folder, separate from project source. **When you are invoked by the loop**, obey
this in addition to everything above:

- **You work directly on `main` in this checkout** — NO worktree, NO new branches, NO push,
  NO merge. Build ONE task, commit it, and stop. The loop pushes and gates on CI.
- **The backlog is shell-owned.** `.harness/TASKS.json` is committed; the loop sets a task's
  `status` to `done` — **never edit `.harness/TASKS.json` yourself.** Write your attempt notes
  to `.harness/worklog/<TASK>.md` and the result line to `.harness/worklog/.result`.
- **Definition of Done mirrors CI** (`.harness/HARNESS.md` §5): `npx tsc --noEmit`, `npm test`, and
  `npm --prefix dashboard run build` for any `dashboard/` change — all green before you commit.
- **Never make live paid-API calls (Google Places, Gemini) in verification** — that spends the
  monthly cap. Use the existing fetched data under each job's `data/` folder, or synthetic
  fixtures, plus the scratch DB. If a check truly needs a paid call, record `failed:blocked`.
- **Privacy guard (non-negotiable):** never `git add` anything under a `data/` folder, a
  `chrome-profile/`, `.env*`, or a credential file; never `git add -A`/`git add .` — stage
  files explicitly. To publish job code, remove only the relevant code-folder line from
  `.gitignore` and `git add` the `.ts` files by name. The loop's pre-push guard HALTS the run if
  any sensitive path is staged.
