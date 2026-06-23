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
   jobs are not. Top-level `src/jobs/*.job.ts` files are gitignored. The `places/`
   and `perfumes/` subfolders are tracked as published examples — any new private
   workflow should live in its own subfolder added to `.gitignore`. Do not
   force-add private files.

Before any commit: `git status` and confirm no `.env`, no real `*.job.ts`, and
no credentials are staged. If you ever spot a secret about to be committed, stop
and tell the user.

## What this project is

`local-jobs` is a self-hosted job orchestrator + dashboard that runs on an
always-on **Mac Mini**. Its purpose is to host **long-running / headless local
work** that doesn't fit serverless or a web request. The repo ships two
worked-example workflows: **places** (headless CID→place_id resolution → Google
Places API enrichment → Gemini LLM summaries, writing enriched JSON + markdown
profiles to local files) and **perfumes** (Fragrantica scrape → headless Chrome
fetch → parse → Claude CLI profile build). Private workflows are added as
gitignored subfolders.

Keep it **simple, local, and dependency-light**. This is a personal tool, not a
distributed system. Do not introduce Docker, external databases, message
queues, or cloud infra unless explicitly asked.

## Architecture (how it fits together)

```
launchd ──keeps alive──▶ daemon (src/daemon.ts)
                            │  scheduler (croner) ──schedules──▶ workflow-executor
                            │  HTTP API on :4789                  (orchestrates member
                            │  (manual run ─┐                      jobs in DAG order)
                            │   ─▶ executor)│                            │
                            │               └────────┬───────────────────┘
                            │                        ▼
                            │                     executor ──spawns──▶ child (src/runJob.ts)
                            │                  (single job,              runs ONE job,
                            ▼                   timeout/retries)          emits NDJSON
                         SQLite (data/jobs.db, WAL)  ◀── parent is sole writer
                            ▲
                         dashboard (Next.js, :4788) ── polls the API, read-only
```

- **The daemon is the only long-lived process.** launchd keeps ONE daemon
  alive; the daemon schedules ALL workflows internally (and workflows drive their
  member jobs). Never create one launchd agent per job.
- **Each job runs in an isolated child process** so a hang/crash can't take down
  the daemon, and timeouts can hard-kill it (SIGTERM→SIGKILL).
- **Workflows compose jobs into a DAG — and EVERY job belongs to one.** There are
  no standalone jobs: a lone job is just a one-stage workflow with its own manifest.
  The workflow owns scheduling + the enable toggle; it drives its member jobs. A job
  discovered with no `*.workflow.ts` manifest is a config error and the registry
  **fails loud at load** (the daemon refuses to start). The workflow executor runs
  member jobs in topological order (respecting `dependsOn` edges and bounded
  parallelism) via the same executor. A workflow run is a first-class DB record
  distinct from each member job's own run.
- **The child only emits events; the parent (executor) is the sole DB writer.**
- **A running workflow run is cancellable.** `runWorkflow` registers each run in an
  in-process `workflowRunId → AbortController` map (so BOTH the scheduler and the
  manual `POST /api/workflows/:name/run` path register, since both flow through it)
  and removes it when the run settles. `POST /api/workflow-runs/:id/cancel`
  (mutating — loopback/token guard) looks the run up and `abort()`s it; the signal
  threads `runWorkflow → executeDag → runJobForWorkflow → runAttempts →
  executeAttempt`. On abort the in-flight member's child is **hard-killed**
  (SIGTERM→SIGKILL, reusing the timeout kill path — never just resolving early, which
  would orphan the child), no further stages launch, and the executor (still the sole
  writer) records the workflow run + killed member run `cancelled`. A cancelled member
  is terminal (not retried); not-yet-started stages simply never spawn. Idempotency
  means the next run resumes outstanding work.
- **One active run per workflow (T105).** A given workflow may have only ONE run
  active at a time — but DIFFERENT workflows still run concurrently (this is
  per-workflow, NOT a global lock). The executor is the **authoritative, race-safe
  guard**: `runWorkflow` does a check-and-claim with NO await between them
  (`workflowRunInProgress(name)` → claim `name` in an in-process `startingWorkflows`
  set) BEFORE its first await, so two near-simultaneous starts of the same workflow
  can't both pass — the loser returns `{ skipped: true, reason: 'already running' }`.
  The claim is held for the whole run (released in a `finally`) so the window before
  the DB run row exists (the `await inputKeys()` of a limited run) is also covered.
  `workflowRunInProgress(name) = startingWorkflows.has(name) || hasActiveWorkflowRun(name)`
  — the in-process claim PLUS the DB's `running` check (the latter catches a run still
  going from a prior tick). The API mirrors this: `POST /api/workflows/:name/run`
  returns **409 Conflict** (`{ error: '… already has an active run', running: true }`)
  when `workflowRunInProgress` is true, instead of firing-and-forgetting a 202 that the
  executor would silently skip — so the caller knows it didn't start. The dashboard's
  Run buttons (Workflows LIST + workflow DETAIL) disable and show **"Running…"** while
  `last_run.status === 'running'`, so the UI never lets you click into a duplicate.
- **`repeatUntilStable` cycling stops on no forward progress (T112).** A workflow
  with `repeatUntilStable` re-runs its DAG in cycles until `workflowRetryableCount`
  hits 0 OR a whole cycle advances NOTHING. The framework snapshots the member
  work-item ledger each cycle via `workflowProgressSignature` (row count + summed
  attempts + retryable count); if a cycle leaves the signature unchanged AND the
  retryable count didn't drop (`noForwardProgress`), the loop **breaks early** rather
  than spinning to `maxCycles`. This is the robust fix for a genuinely-unfindable
  input (e.g. a perfume with no Fragrantica page) that is counted "retryable" every
  cycle yet never actually re-attempts/increments — without it EVERY scheduled run
  burned all 40 cycles re-running all stages for nothing. The early stop logs a warn
  telling you to unstick/ignore the stuck item.
- **Per-stage notifications are deduped during cycling (T112).** `runWorkflow`
  notifies a stage (`notifyStage`) only when its status **changes** from the last
  push for that stage — so a `repeatUntilStable` run that re-runs 4 stages × 40
  cycles no longer fires ~160 pushes and trips ntfy's 429 rate-limit. Single-cycle
  workflows (the dedup map starts empty) still notify each stage exactly once —
  unchanged. The aggregate `notifyWorkflow` at the end is always sent.
- **Latest-run-per-stage ordering is rowid-deterministic (T112).**
  `listRunsForWorkflowRun` orders by `(started_at, rowid)`, NOT `started_at` alone.
  `started_at` is second-granularity, so during fast cycling an earlier cycle's
  settled run and the current cycle's fresh `running` run can share a second; without
  the `rowid` tiebreaker the dashboard's last-write-wins "latest per stage" could
  pick the stale settled run over the live one — the succeeded→running→succeeded
  status flicker. Keep any "latest run" derivation ordering by `(started_at, rowid)`.
- **The dashboard is a pure read/refresh client of the API.** It never touches
  SQLite directly and is not required for jobs to run. There is **exactly ONE
  deliberate write exception** (T124): the human-owned `reviewed` flag on a backlog
  task — `POST /api/backlog/:id/reviewed` does a field-scoped, atomic
  read-modify-write of `.harness/TASKS.json` (see the harness section below).
  Everything else stays read-only.

## File map

| Path | Responsibility |
|---|---|
| `src/config.ts` | Env-driven config: ports, bind host, CORS allowlist, auth token, db path, ntfy, shared Chrome profile dir |
| `src/daemon.ts` | Long-lived entrypoint: sync jobs + workflows, reap orphans, start scheduler + API |
| `src/runJob.ts` | Child entrypoint: run one job, emit NDJSON |
| `src/core/types.ts` | `JobDefinition`, `WorkflowDefinition`, `ServiceDefinition`, `JobContext`, event types — the contracts |
| `src/core/executor.ts` | Spawn child, parse events, enforce timeout, retries, overlap-prevention; **cancellation** — an `AbortSignal` threaded into the attempt loop hard-kills the in-flight child (SIGTERM→SIGKILL, the timeout path) and settles the run `cancelled` (terminal, never retried) |
| `src/core/scheduler.ts` | croner triggers for scheduled **workflows** (the only schedule owner; drives member jobs — jobs never get their own cron); respects `enabled` |
| `src/core/dag.ts` | Workflow DAG: build + validate topological order, cycle detection; `executeDag` honours an `AbortSignal` (stops launching new stages, drains in-flight) |
| `src/core/workflow-executor.ts` | Orchestrate a workflow run: member jobs in DAG order, stage gates, retries, completed-stage progress roll-up; `repeatUntilStable` cycling with a **no-forward-progress early stop** (T112, via `workflowProgressSignature`/`noForwardProgress`) + **per-stage notification dedup** (only push on a status change while cycling); owns the **active-run registry** (`workflowRunId → AbortController`) + `cancelWorkflowRun()` that powers run cancellation; the **authoritative "one active run per workflow" guard** — `workflowRunInProgress(name)` + a synchronous per-name claim in `runWorkflow` (see below) |
| `src/core/notifier.ts` | Run alerts (success/failure/timeout) with item counts + stuck heads-up: ntfy push + macOS notification. `notifyStage` is fired per-stage by the executor, which DEDUPES it during `repeatUntilStable` cycling (status-change-only) so cycling can't trip ntfy's 429 |
| `src/core/services.ts` | `callService`: cross-job shared rate-limit + quota middleware (coordinated via SQLite) |
| `src/core/browser.ts` | Shared headless-browser helper: persistent-profile + real-Chrome-channel launch (bundled-chromium fallback, stale-lock cleanup) for reputation-gated scrapes, plus a jittered-delay pacing helper |
| `src/db/schema.sql` | `jobs`, `runs`, `run_logs`, `work_items` (+ `root_key`/`parent_key` lineage), `job_usage`, `workflows`, `workflow_jobs`, `workflow_runs` (+ `run_limit`/`selected_roots`), `workflow_run_logs`, `services`, `service_usage` |
| `src/db/index.ts` | SQLite connection + schema bootstrap (WAL mode) |
| `src/db/store.ts` | ALL queries live here — add new ones here, not inline |
| `src/jobs/registry.ts` | Auto-discovers `*.job.ts`, `*.workflow.ts`, and `*.service.ts` files (no manual registration); fails loud if any job belongs to no workflow (`orphanJobNames`) |
| `src/jobs/*.job.ts` | One job per file, default-exporting a `JobDefinition` (root-level files gitignored; subfolder jobs in `places/`+`perfumes/` are tracked) |
| `src/jobs/*.workflow.ts` | Workflow manifests, default-exporting a `WorkflowDefinition` (DAG of jobs) |
| `src/jobs/*.service.ts` | Service definitions, default-exporting a `ServiceDefinition` (shared rate-limited dependencies) |
| `src/api/server.ts` | Node `http` API (no framework). Add routes here |
| `dashboard/app/*` | Next.js App Router dashboard (client components, poll via `app/lib/api.ts`); all responsive CSS lives in `app/globals.css` |
| `dashboard/scripts/mobile-check.mjs` | Hermetic phone-viewport (402px) styling check — headless Chromium + synthetic API fixtures; local only, not in CI |
| `scripts/*` | launchd install scripts + start wrapper |

## How to add a job (the common request)

**Every job must belong to a workflow** — there are no standalone jobs. A lone job
is a one-stage workflow with its own `*.workflow.ts` manifest (no implicit
wrapping). The workflow owns the `schedule`; a job with no manifest fails loud at
load.

1. Create `src/jobs/<name>.job.ts`:
   ```ts
   import type { JobDefinition } from '../core/types.js';

   const job: JobDefinition = {
     name: 'unique-name',           // stable; it's the DB primary key
     description: 'what it does',
     timeoutMs: 600_000,            // 0 = no timeout
     maxRetries: 3,
     async run(ctx) {
       ctx.log('message');          // -> run_logs, shown live in dashboard
       ctx.progress(50, 'halfway'); // -> progress bar 0..100
       // ...work... throw to fail the run
     },
   };
   export default job;
   ```
   A job carries NO workflow-level properties (T070): no `schedule`, no `enabled`
   toggle, no `instructions`, and no run-now — those live ONLY on the workflow. The
   `JobDefinition` is just identity + execution params (`timeoutMs`/`maxRetries`) +
   `run`/`produces`/`consumes`. You run a WORKFLOW, never a job; a job runs when its
   prerequisites are met inside its workflow, and `/jobs/[name]` is a read-only
   member view (status · run history · logs). Put any setup/run docs in the README,
   not on the job.
2. Declare it in a `*.workflow.ts` manifest — a one-stage workflow for a lone job;
   the workflow carries the cron `schedule` (or `null` for manual-only):
   ```ts
   import type { WorkflowDefinition } from '../core/types.js';

   const workflow: WorkflowDefinition = {
     name: 'unique-name',           // distinct from every job name
     description: 'what it does',
     schedule: '0 3 * * *',         // croner cron, or null for manual-only
     jobs: [{ job: 'unique-name' }],
   };
   export default workflow;
   ```
3. That's it for wiring — jobs and workflows are **auto-discovered** by filename
   glob (`*.job.ts` / `*.workflow.ts`). There is **no registry to edit**.
4. Tell the user to restart the daemon (jobs are loaded at startup):
   `launchctl kickstart -k gui/$(id -u)/com.ryankrol.localjobs`

> **Privacy — real jobs are local-only by default.** Top-level
> `src/jobs/*.job.ts` files are gitignored. The
> public repo ships the `places/` and `perfumes/` subfolder workflows as
> worked examples, but their `data/` folders stay gitignored. New jobs you add as
> a root-level `*.job.ts` stay untracked by design. NEVER use `git add -f` on a
> private job file.
>
> For a **new private multi-file workflow**, create `src/jobs/<name>/` and add the
> line `src/jobs/<name>/` to `.gitignore`. Jobs are discovered **recursively**,
> so a `*.job.ts` inside that folder is picked up automatically while its helper
> modules stay private too.

### Job conventions
- Jobs must be **idempotent / safe to re-run** (they retry and can be run
  manually). Use guards / "skip if already done".
- Use `ctx.log` and `ctx.progress` generously — that's the entire visibility
  story. No `console.log` (it still gets captured, but prefer `ctx`).
- **Item-loop jobs report progress per item, not just at the end.** Any job that
  processes N items must call `ctx.progress(i/N*100)` and log an `i/N` line as it
  finishes each one, so the job's own run % advances live (the workflow bar only
  steps when the whole stage finishes — see the progress roll-up note below)
  instead of jumping 0→100 at the finish. Use a sensible denominator — the count
  it will actually attempt this run (e.g. `Math.min(todo.length, runLimit)`). The
  perfumes stages share `reportItemProgress(ctx, done, total, suffix?)` in
  `perfumes/lib.ts` for this; the places stages emit it inline. All 8 example-job
  loops do this — match it in new jobs.
- Keep secrets in `.env` (read via `process.env`); never hardcode. The child
  inherits the daemon's env.
- **Record a produced markdown artifact's path in the work item's `detail.markdown`
  (T110).** A job whose final output is a markdown file should pass the file's
  absolute path as `markWorkItem(…, { detail: { name, markdown: mdPath } })`
  (places-llm-enrich and perfumes-build both do). The dashboard's workflow-run
  **Input → Output** panel reads it via `workItemMarkdownPath` and the read-only,
  path-safe `GET /api/workflow-runs/:id/output?job=&key=` endpoint to preview the
  artifact + open the full markdown in a popover. The popover renders content as
  formatted markdown via `react-markdown` (XSS-safe — no `rehype-raw`, raw HTML is
  escaped not executed; T115). YAML frontmatter is stripped and shown as a compact
  key-value header. The endpoint confines reads to a `.md` file inside a job's own
  `data/out/` tree (`safeOutputMarkdown` in `server.ts` — resolve + realpath +
  prefix + `/data/out/` checks; no traversal, files only, no paid/remote calls),
  so keep output artifacts under `data/out/`.
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
- **Every job belongs to a workflow — no standalone jobs.** A job must be a member
  of a workflow declared in a `*.workflow.ts` manifest (a lone job = a one-stage
  workflow with its own manifest; there is no implicit wrapping). The workflow owns
  scheduling + the enable toggle and drives its members — a job never gets its own
  cron. The registry enforces this at load via `orphanJobNames` and **throws** (the
  daemon refuses to start) if any discovered job has no workflow. When you add a
  job, add its manifest in the same change.
- **No workflow-level properties on a job (T070).** Because a job is only ever a
  workflow member, ALL workflow-level concerns live on the workflow, never the job:
  a job has NO `schedule`, NO `enabled` toggle, NO `instructions`, and NO run-now.
  There is no `POST /api/jobs/:name/run` or `/toggle`, no per-job scheduling, and
  the `jobs` table has no `schedule`/`enabled` columns (dropped by the
  `migrateDropJobColumns` migration in `src/db/index.ts`). `/jobs/[name]` is a
  read-only MEMBER view (status · run history · logs); you run + enable a WORKFLOW.
  Don't add any of these back to `JobDefinition` or the job page.
- All SQL goes through `src/db/store.ts`. Don't scatter `db.prepare` calls.
- **Schema bootstrap must NEVER reference a migration-added column (T098).**
  `openDb()` (in `src/db/index.ts`) runs `db.exec(schema.sql)` FIRST, then the
  additive migrations. On a **fresh** DB `schema.sql`'s `CREATE TABLE` already
  carries every column, so a bootstrap `CREATE INDEX … ON t(new_col)` works — but
  on an **existing** DB the column is only added by a LATER `ALTER TABLE` in a
  migration, so that same bootstrap index throws `no such column` and crash-loops
  the daemon at startup (the T094 regression, fixed in 2748c58). **Rule:**
  `schema.sql` must NOT create an index/constraint on a column that an additive
  migration adds — put such an index INSIDE the migration, AFTER its `ALTER TABLE`
  (see `migrateRunLimitLineage` in `src/db/index.ts`: it ALTERs in `root_key`,
  backfills, then `CREATE INDEX … idx_work_items_root`). The unit suite can't catch
  this on its own because it always starts from a fresh scratch DB; the regression
  guard `src/db/migrate-existing-db.test.ts` runs the REAL `openDb(path)` against a
  pre-seeded OLD-shape DB (tables/rows lacking the newer columns) and asserts it
  doesn't throw and ends correctly migrated — it FAILS if pointed at the pre-fix
  buggy `schema.sql`. (`openDb(dbPath?)` takes an optional path solely so this test
  can drive it; the daemon uses the default.)
- **Idempotency — per-item work ledger (the standard).** For jobs that process
  many items, record each item's outcome in the `work_items` SQLite table via
  `src/db/store.ts` (`isWorkItemDone`, `markWorkItem`, `workItemCounts`), keyed by
  `(jobName, itemKey)`. Re-runs skip items already done (success, manually
  `ignored`, or failed past `maxAttempts`) so work is never reprocessed. The whole places workflow uses this
  (resolver by CID, enrich + LLM by place_id); the rich output still goes to the
  job's `data/` files — the ledger just tracks *what's done*. Don't use ad-hoc
  "skip if it's in the JSON file" checks.
  - **Pruning orphaned ledger rows (manual only).** When a job's input keys
    change (e.g. a source id is corrected), the old keys leave orphaned
    `work_items` behind. A job can expose its current input key-set via an
    optional `inputKeys()` on its `JobDefinition`; a **manual** prune
    (`POST /api/jobs/:name/prune`, or `pruneOrphanedWorkItems`/`orphanedWorkItems`
    in `store.ts`) then removes ledger rows whose key is no longer in that set and
    reports exactly what it removed. This is **never automatic** — nothing in the
    run/schedule path calls it. The API accepts an explicit `{ keys: [...] }`
    (used when a job has no `inputKeys()`), a `{ dryRun: true }` preview, and
    refuses an empty current set unless `{ force: true }` (an empty set would
    orphan every row — a guard against a misbehaving `inputKeys()`).
  - **Input lineage + manual run-limits (T094).** A manual workflow run can be
    capped to **N originating inputs** (`POST /api/workflows/:name/run { limit: N }`,
    or the number box beside ▶ Run now); **all** fan-out of each selected root runs
    to completion (the cap bounds roots, not per-stage counts), and **scheduled runs
    are always unlimited**. The framework tracks lineage via two nullable
    `work_items` columns — `root_key` (the originating input an item descends from)
    and `parent_key` — resolved in `markWorkItem` (`store.ts`): rule 1 explicit
    `rootKey` wins, rule 2 inherit the `parentKey` row's root, rule 3 default
    `root_key = item_key`. So **same-key stages need NO lineage args** (perfumes:
    every stage keys by `p.id`); only **key-changing / fan-out stages pass `rootKey`**
    (places enrich/llm pass `rootKey: cid` since they key by `place_id`). The **root
    stage** is the first member (topological order) declaring `inputKeys()` — its
    keys are the candidate roots; selection (`selectPendingRoots` in `store.ts`)
    freezes the first N *pending* roots on the run row (`run_limit` +
    `selected_roots` JSON) in `runWorkflow`. The id is threaded to each child via the
    `LOCALJOBS_WORKFLOW_RUN_ID` env (`executor.ts`); the child (`runJob.ts`) loads
    `getWorkflowRunRoots` into `ctx.selectedRoots()`/`ctx.rootAllowed(rootKey)`. **Every
    stage MUST filter its work-list by `ctx.rootAllowed(root)`** — when unlimited it's
    a no-op (the set is null → always true), so unlimited runs behave exactly as
    before. A workflow is *limitable* (the API surfaces `limitable`; the dashboard
    shows the box) only when some member declares `inputKeys()`. ⚠️ A key-changing
    stage that marks a derived item WITHOUT `rootKey`/`parentKey` makes it its own
    root → silently skipped under a limit; always pass lineage on such stages.
  - **Stuck vs ignored: unstick vs ignore (both manual only).** An item that
    failed past `maxAttempts` is **stuck** — it won't retry and surfaces on the
    dashboard front page / alerts (`stuckItems`, `stuckCount`). Two manual
    controls resolve it, and they are opposites: **unstick**
    (`POST /api/stuck/unstick`, `unstickWorkItem`) DELETES the failed ledger row
    so the item is RETRIED fresh next run; **ignore**
    (`POST /api/stuck/ignore`, `ignoreWorkItem`) marks the failed row
    `ignored` — a permanent "give up on this one" for genuinely bad data. There
    is exactly ONE manual-park concept (`ignored`, not a separate "dismissed"):
    an ignored item drops off the stuck list, is **never counted as stuck**, is
    never reprocessed or resurrected by a re-run (`isWorkItemDone` treats
    `ignored` as done), and surfaces ONLY on the overview's **Ignored** tile
    (`GET /api/ignored`, `ignoredItems`) — not on the workflows tab or
    workflow/job detail. Both controls act ONLY on a currently-`failed` row and
    are **never automatic** — nothing in the run/schedule path ignores anything.
    (DB note: the legacy `dismissed` status is migrated to `ignored` on startup
    in `src/db/index.ts`.)
  - **Bulk unstick/ignore with scope (T118).** The per-item controls above are
    complemented by bulk operations: `bulkUnstickItems(scope)` /
    `bulkIgnoreItems(scope)` in `src/db/store.ts`, backed by
    `POST /api/stuck/unstick-bulk` and `POST /api/stuck/ignore-bulk` in
    `src/api/server.ts`. Both act ONLY on currently-`failed` rows (same semantic as
    the single-item operations). The scope parameter limits the action to a subset:
    `{ type: 'all' }` (default — every stuck item), `{ type: 'job', jobName }` (one
    job), or `{ type: 'workflow', jobNames }` (member jobs of a named workflow; the
    API resolves the workflow name to its member list via `getWorkflowJobs`).
    The API request body is `{}` / `{ scope: 'all' }` for all, `{ scope: 'job', job
    }` for one job, or `{ scope: 'workflow', workflow: 'name' }` — the server
    returns `{ ok, unstuck }` / `{ ok, ignored }` with the count of rows affected.
    An unknown workflow name returns **400**. The bulk endpoints obey the same
    global loopback/token mutation guard as all other POST endpoints.
    The **`StuckPopover`** component in `dashboard/app/ui.tsx` is the reusable UI:
    it takes `items: StuckItem[]`, an optional `scope?: BulkScope`, `onClose`, and
    `onAction`. It renders the item table with per-item ↻ Unstick / ✕ Ignore
    buttons plus "Unstick all" / "Ignore all" bulk actions — bulk actions prompt a
    confirmation before calling the API. The Overview page opens it from the Stuck
    tile and the "Manage all…" header button; T119 wires it from the Workflows view.
    The `StuckPopover` reuses the existing `.db-modal-overlay` / `.db-modal`
    chrome and adds only `.stuck-popover` (wider width) and `.stuck-popover-bulk`
    (footer action row) in `dashboard/app/globals.css`.
- **Spend / usage caps.** For jobs that make metered external calls (paid APIs),
  enforce per-day AND per-month caps via the `job_usage` meter in `src/db/store.ts`
  (`recordUsage`, `capStatus`). Call `recordUsage(jobName)` once per real action;
  check `capStatus(jobName, dailyCap, monthlyCap)` in the loop and stop gracefully
  when `!allowed`. Convention: daily cap = monthly cap / 10 (so manual re-runs
  don't blow the month) — but a **daily-scheduled** job/workflow must use daily =
  monthly / 30, so a full month of daily runs exactly fits the monthly ceiling and
  a single day's run can never blow it (see the places workflow's
  `DAILY_SPEND_DIVISOR`). Caps live in the job's config, env-overridable.
  **One governor only:** if a paid call already goes through a shared **service**
  (below), the service quota is the SINGLE source of truth — do NOT also stack a
  per-job `job_usage` cap on the same calls (it shadows the service's
  `QuotaExceededError` soft-fail and double-meters). The places paid jobs
  (`places-enrich`→`google-places`, `enrich-with-llm`→`gemini`) govern spend
  purely via their service quota; `DAILY_SPEND_DIVISOR` feeds the *service* caps.
  Use the per-job `job_usage` meter only when the metered call is NOT routed
  through a service.
- **Services (cross-job shared APIs).** For an external dependency called from
  multiple jobs (e.g. Gemini, Google Places, Fragrantica, Claude CLI), define a
  `ServiceDefinition` in a `*.service.ts` file and call the API through
  `callService(name, fn)` from `src/core/services.ts`. This coordinates rate
  limits and quotas across all job processes via the SQLite `service_usage` meter,
  and is the SOLE spend governor for those calls — a hit day/month quota throws
  `QuotaExceededError`, which the caller catches to stop the run gracefully (the
  item is left un-done and the next run resumes). See `places/gemini.service.ts`
  and `perfumes/fragrantica.service.ts` for worked examples. The simpler per-job
  `recordUsage`/`capStatus` on `job_usage` still exists for single-job-only
  metering when cross-job coordination isn't needed. (When migrating an existing
  job onto a service, top up `service_usage` from its historical `job_usage` once
  with `scripts/backfill-service-usage.ts` so the month's count carries over.)
  - **Limits are code-seeded but user-overridable.** `ratePerMinute` / `dailyCap`
    / `monthlyCap` from the `ServiceDefinition` seed the `services` row on sync,
    but the Services dashboard page can edit them
    (`POST /api/services/:name/limits` → `updateServiceLimits` in `store.ts`).
    An edit flips `limits_overridden = 1`; from then on a code-sync PRESERVES the
    user's values (description/paid stay code-owned and refresh) — the same
    reconcile the user-owned `enabled` flag gets. `callService` enforces the
    EFFECTIVE limit (`effectiveLimits` in `core/services.ts`): the override when
    set, else the code default — so an edit takes effect for the next call without
    a code change. `minIntervalMs`/`maxJitterMs` are NOT editable (code-only).
- **Headless-browser scrapes (shared launch helper).** Any job that drives a
  real browser to scrape a reputation-gated site (Cloudflare et al.) should launch
  via `launchPersistentBrowser` from `src/core/browser.ts` rather than calling
  `chromium.launchPersistentContext` inline. It encapsulates the proven learnings:
  a persistent on-disk profile (keeps the clearance cookie across pages AND runs),
  the real-Chrome channel with a bundled-chromium fallback, an anti-automation
  flag + realistic UA/viewport/locale, and stale-`Singleton*`-lock cleanup. The
  block is rate/reputation-based, not per-request detection — so this owns only
  the *launch*; the job still **paces** its requests (jittered min-interval),
  ideally via a shared **service** (the `fragrantica` service does the spacing
  while `core/browser` does the launch). `jitteredDelayMs` in the same module is
  for jobs that pace their own loop instead of routing through a service. See
  `perfumes/fetch.ts` for the worked example.
  **Shared Chrome profile:** the persistent profile lives at the framework level
  (`data/chrome-profile/`, env-overridable via `LOCALJOBS_CHROME_PROFILE`),
  exported from `src/core/browser.ts` as `defaultChromeProfileDir`. All scrape
  jobs should use it via `perfumesConfig.profileDir` / `defaultChromeProfileDir`
  rather than defining a job-local path — one shared, warmed, trusted profile
  means any job benefits from cookies accumulated by others.
- **Validation gates between workflow stages (typed artifacts).** A job may
  declare `produces` and/or `consumes` — arrays of `ArtifactContract`
  (`{ key, description?, shape?, check() }`) in `src/core/types.ts`. For every workflow
  **edge** where the upstream `produces` a key the downstream `consumes`, the
  workflow executor runs both contracts' `check()` at that boundary — producer
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
  in `src/core/workflow-executor.ts`. Both example workflows declare these: the
  contracts live in `src/jobs/places/contracts.ts` and
  `src/jobs/perfumes/contracts.ts` as small **factory functions** (each takes an
  optional path defaulting to the job's real `data/` artifact, so the jobs wire
  `produces:[…()]`/`consumes:[…()]` while unit tests point them at synthetic
  fixtures). The checks are deliberately SHAPE + NON-EMPTY (exists · non-empty ·
  expected fields/columns) — enough to catch real drift without brittle
  full-schema validation. Each workflow derives 3 gates (one per stage boundary).
  Gate **state** is surfaced on the dashboard's workflow-run DAG: `classifyGates`
  (also in `src/core/dag.ts`, pure) maps each gate to `passed`/`failed`/`pending`
  from the run's member runs — a gate is `failed` when its consumer's latest run
  is a gate-failure (matched via the shared `gateFailurePrefix`, the SAME format
  `recordGateFailure` writes), `passed` once the consumer actually ran, else
  `pending`. The `GET /api/workflow-runs/:id` endpoint returns this as `gates[]`
  — each gate carries its `description` (what the producer's `produces[key]` and
  consumer's `consumes[key]` contracts ASSERT, enriched in the API's
  `gatesForWorkflow`), so a gate is inspectable, not just coloured.
  `dashboard/.../Dag.tsx` renders a gate mark per gate ON THE CONNECTING ARROW between
  the producer and consumer waves it guards (not under either node) — at both
  desktop (`→`) and phone (`↓`) widths; a non-adjacent producer→consumer edge that
  can't sit on a single inter-wave arrow falls back to rendering under the consumer
  node rather than being dropped or mis-placed. **Gate display is currently
  TOGGLEABLE (T099, an evaluation aid).** Both graph views show a small "Gate style"
  selector and the user can switch live between five compact styles — `icon` (bare
  ⛒ glyph), `dot` (bare state-coloured dot), `key` (tiny pill of just the artifact
  key), `connector` (no chip — the arrow glyph itself is state-coloured + clickable),
  `lock` (bare 🔒 glyph) — persisted to `localStorage` (`localjobs.gateStyle`) via
  `useGateStyle()` in `app/ui.tsx` (`GATE_STYLES` is the source of truth). All five
  keep every gate clickable to its detail page, keep the passed/failed/pending +
  structural state colouring distinguishable, and work at desktop and phone widths.
  Once a favourite is picked, a FOLLOW-UP task will hardcode the winner and remove
  the toggle + unused styles. EVERY mark (passed/failed/pending
  alike) links directly to that gate's dedicated detail page
  (`/workflow-runs/<id>/gates/<producer>/<key>`), which shows what the gate
  validates (key + description, producer→consumer), its outcome, and links to the
  producer/consumer/violation run logs. Gates render ONLY when a run's `gates` prop is passed — the
  structure-only `/workflows/[name]` graph omits it. The executor also LOGS each
  gate check to the workflow run's framework logs: a `⛒ checking gate …` line
  naming the boundary, artifact, and both contracts' assertions
  (`gateAssertions`), then a `✓ gate ok …` / `⨯ Gate violation …` result line —
  so the run page tells you what each gate verified and why it passed or failed.
  - **Expected-vs-actual gate page (black box).** Each gate has a dedicated page
    (`dashboard/app/workflow-runs/[id]/gates/[producer]/[key]/page.tsx`) that
    explains the gate to a NON-EXPERT with no knowledge of internals. It lays the
    boundary out left-to-right — **Produced →** → **Gate** (what it checks) →
    **→ Consumed** — and on each side shows the contract's declared
    **expected shape** alongside the **actual** artifact's per-expectation ✓/✗ and
    a small sample. To support it, an `ArtifactContract` may declare a
    machine-readable `shape: ArtifactShape` (`{ summary, format?, expectations[] }`,
    each expectation a plain-English `{ label, detail? }`), and its `check()`
    returns `GateResult.checks[]` (per-expectation `{ label, ok, actual? }`, aligned
    to the shape BY LABEL) plus a `sample` string. `ok`/`violations` are still
    derived from the failed checks (the contract helper `fromChecks` does this), so
    executor enforcement is unchanged — keep the labels in `shape.expectations`
    identical to the ones the `check` emits. The page is served by
    `GET /api/workflow-runs/:id/gates/:producer/:key`, which classifies the gate
    state for the run and runs each side's contract `check()` LIVE (produced =
    producer's `produces[key]`, consumed = consumer's `consumes[key]`). That endpoint
    reads `data/` files only — NEVER a paid/remote call — so it is safe to poll;
    keep any future contract `check()` cheap + side-effect-free for the same reason.
  - **Definition-level (run-agnostic) gate page (T102).** The run-scoped page above
    belongs to a SPECIFIC run. The workflow DEFINITION view (`/workflows/[name]`)
    instead links each structural gate chip to a run-AGNOSTIC gate page at
    `dashboard/app/workflows/[name]/gates/[producer]/[key]/page.tsx` — mirroring how a
    job node there links to the read-only `/jobs/<name>` rather than into one run. It
    explains the gate ITSELF (the contract: artifact key, enriched description,
    producer→consumer, and each side's declared **expected shape**) with NO run state
    and NO actuals. It's served by `GET /api/workflows/:name/gates/:producer/:key`,
    which returns the structural gate from `gatesForWorkflow` (`deriveGates` +
    contract descriptions) plus each side's `shape` ONLY — it does **NOT** run any
    contract `check()`, so it touches no `data/` files and makes no paid/remote calls
    at all (purely static contract metadata). `Dag`'s structural gate chips take a
    `workflowName` prop (replacing the old `lastRunId`) to build these definition-view
    links; run-view chips still use `workflowRunId` → the run-scoped page, UNCHANGED.
- **Workflow progress is rolled up from member jobs (don't set it by hand).** A
  workflow run's `progress` is a first-class roll-up that counts **only completed
  stages** over the workflow's total stage count — a member in a terminal state
  contributes a full stage (1); a still-running or not-yet-started member
  contributes 0 (**no partial credit** for in-flight work). So with N stages the
  bar stays at 0% until the first stage finishes, then **steps in 100/N
  increments** per completed stage (4 jobs → 0/25/50/75/100; 5 jobs →
  0/20/…/100). `setProgress` (the executor's per-member progress writer) calls
  `rollUpWorkflowProgress` in `src/db/store.ts` whenever a workflow member emits
  progress or settles, but a mid-run member's `progress` no longer moves the bar —
  only crossing into a terminal state does. The denominator comes from the
  `workflow_jobs` table (member count), so no new column is needed. Use
  `rollUpWorkflowProgress`, not ad-hoc `setWorkflowProgress(settled/total)`, when
  surfacing workflow progress.
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
- **Dashboard must stay mobile-responsive.** Every page has to survive a phone-width
  (~402px) viewport with no horizontal page overflow and nothing crossing an
  element's boundary. Responsive rules live in one place — the `@media (max-width:
  640px)` block in `dashboard/app/globals.css` (wide tables scroll inside their
  `.panel` via `.panel:has(> table){overflow-x:auto}`, dense grids collapse, `.kv`
  blocks stack). After any dashboard UI change, build it and run
  `node dashboard/scripts/mobile-check.mjs` (hermetic — no daemon, synthetic API
  fixtures) and keep it green. The check is local-only, not part of CI.
- **Commit + push as you go.** Make small, atomized commits as each coherent change
  lands (one per layer/feature — not a big-bang), and **push each commit immediately**
  — don't wait to be asked. (Respect the git hygiene rules above: never commit
  credentials or the gitignored private job folders / `TODO.md`.)
- **Always restart what you changed — a change isn't live until you do (part of Done).**
  The daemon loads job/daemon code at startup and the dashboard serves a prebuilt
  bundle, so editing files changes nothing in the running product until you restart.
  Whenever you touch:
  - **`src/` (daemon/jobs):** restart the daemon —
    `launchctl kickstart -k gui/$(id -u)/com.ryankrol.localjobs`
  - **`dashboard/` (UI):** rebuild **and** restart it —
    `npm --prefix dashboard run build && launchctl kickstart -k gui/$(id -u)/com.ryankrol.localjobs-dashboard`

  Do this in the same step as the change so what's running always matches `main`.
  (DB-only data fixes don't need a restart, but they do need to be safe to re-run.)

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
- **The backlog is shell-owned — `status` especially.** `.harness/TASKS.json` is committed; the
  loop sets a task's `status` to `done` (via a `jq` field-scoped edit that preserves every other
  field) — **never edit `status` (or any field) of `.harness/TASKS.json` yourself.** Write your
  attempt notes to `.harness/worklog/<TASK>.md` and the result line to `.harness/worklog/.result`.
  - **The ONE owner-authorized exception is the `reviewed` flag (T124).** Each task carries a
    `reviewed` boolean (human-review tracking) that is **human/dashboard-owned, not shell-owned**:
    the owner toggles it from the Backlog page via `POST /api/backlog/:id/reviewed`, which does a
    field-scoped, atomic (temp-file + rename) read-modify-write that sets ONLY that task's
    `reviewed` and preserves all other fields/tasks. This is the deliberate exception to both the
    read-only-dashboard rule and the shell-owns-the-file rule. `status` stays shell-owned; only
    `reviewed` is human-owned, and the loop's `jq` status-write preserves it. The agent still must
    not hand-edit `reviewed` in TASKS.json — it's a UI action. (Absent values default to false.)
- **Backlog authoring: pair every "options/chooser" task with a review task (T129).** Whenever
  a backlog task builds MULTIPLE OPTIONS for the owner to choose between (toggleable styles, strategy
  variants, etc.), a PAIRED `needs-human` review task **must** also be authored that: (a)
  `dependsOn` the chooser task, (b) records the owner reviewing the options and committing to a
  choice, and (c) unblocks a follow-up that hardcodes the winner and removes the toggle + unused
  paths. Example chains: T099/T113/T116 (choosers) → T126/T127/T128 (review tasks). Never author
  a chooser task alone; always add the paired review task in the same backlog edit.
- **Definition of Done mirrors CI** (`.harness/HARNESS.md` §5): `npx tsc --noEmit`, `npm test`, and
  `npm --prefix dashboard run build` for any `dashboard/` change — all green before you commit.
- **Verify correctness — paid calls allowed, frugally.** The ONE hard rule is **never exceed a
  service's monthly cap** (the `service_usage` quota enforces this — `callService` throws
  `QuotaExceededError` at the ceiling). Otherwise: prefer cached `data/` / synthetic fixtures / the
  scratch DB first, and make a live paid call (Google Places, Gemini) or live scrape only as a last
  resort to prove the work, with the smallest sample (1–2 items). **Never skip verification to save
  money** — an unverified task isn't done. Record `failed:blocked` only when verifying would have to
  exceed the monthly cap.
- **Privacy guard (non-negotiable):** never `git add` anything under a `data/` folder, a
  `chrome-profile/`, `.env*`, or a credential file; never `git add -A`/`git add .` — stage
  files explicitly. To publish job code, remove only the relevant code-folder line from
  `.gitignore` and `git add` the `.ts` files by name. The loop's pre-push guard HALTS the run if
  any sensitive path is staged.
