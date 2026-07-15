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
   jobs are not. Top-level `src/workflows/*.job.ts` files are gitignored. The `places/`
   and `perfumes/` subfolders are tracked as published examples — any new private
   workflow should live in its own subfolder added to `.gitignore`. Do not
   force-add private files.

Before any commit: `git status` and confirm no `.env`, no real `*.job.ts`, and
no credentials are staged. If you ever spot a secret about to be committed, stop
and tell the user.

## 🚫 Broker / trading APIs are READ-ONLY, always (non-negotiable)

Any job or service that talks to a stock/investment broker API (e.g. Trading212)
must be **strictly read-only**. This repo must **NEVER** issue a mutating request
to a broker — no placing, cancelling, or modifying an order; no transfers; no
account changes. Only `GET`/read endpoints (portfolio holdings, prices, account
value, order history as data) are permitted. This applies to every broker
integration added to this repo, present or future, not just the first one — treat
it the same way as the secrets rule above: a hard constraint, not a default that
can be relaxed for convenience. If a task would require a mutating call to
accomplish its goal, that's a sign the task is out of scope for this repo — stop
and flag it rather than making the call.

## ⚠️ Commit + push as you go — not optional (non-negotiable)

Make small, atomized commits **as each coherent change lands** — one per layer/feature,
not a big-bang at the end of a session — and **push each commit immediately**. Don't
batch work up "for later," don't defer a commit while you move on to the user's next
request, and don't wait to be asked. (Respect the git hygiene rules above: never commit
credentials or the gitignored private job folders / `TODO.md`.)

**Why this is a hard rule in THIS repo specifically, not just good practice:** the
autonomous build harness (`.harness/scripts/loop.sh`, run via `.harness/scripts/supervise.sh`) has
`LOOP_AUTORESET=1` by default (see `.harness/config/harness.env`). If the working tree is dirty
when a run starts, the loop **auto-stashes everything and hard-resets to `origin/main`**
before building — on purpose, so an unattended run always has a clean tree to start from.
An uncommitted session's work (a backlog sweep, a new workflow, a doc rewrite) can
silently disappear from view this way: not lost forever (`git stash list` recovers it),
but the loop will build against **stale state** — an old `TASKS.json`, missing doc
updates — until a human notices the stash and reconciles it. This has already happened
once: a full `/implementation-harness-convert-ideas` sweep (13 new backlog tasks + supporting doc
changes) sat uncommitted across an entire session before anyone caught it via
`/implementation-harness-pre-loop-checkin` — one skipped commit away from the loop silently stashing
away a whole idea-conversion sweep. Treat "uncommitted" as "not durable" here: the moment
a unit of work is coherent (a finished idea conversion, a completed doc update, a working
job), commit it and push it — don't let it accumulate.

## What this project is

`local-jobs` is a self-hosted job orchestrator + dashboard that runs on an
always-on **Mac Mini**. Its purpose is to host **long-running / headless local
work** that doesn't fit serverless or a web request.

### Shipped example workflows — one folder, one `CLAUDE.md`, each

The repo ships 17 worked-example workflows under `src/workflows/`. Each workflow's full
current-state documentation — DAG stages, file paths, ledger conventions, credentials, schedule,
and any non-obvious invariant worth protecting — lives in its OWN `CLAUDE.md` inside its folder
(auto-loaded by Claude Code when working in that directory, same mechanism as this file and
`src/services/CLAUDE.md`). This root file stays a thin index — do not re-inflate it by pasting
per-workflow detail back in here; add it to the workflow's own `CLAUDE.md` instead.

| Workflow | Folder | What it does |
|---|---|---|
| **places** | `src/workflows/places/` | Google Saved Places enrichment: CSVs → resolve CIDs → Google Places API → Gemini LLM summaries → markdown profiles |
| **perfumes** | `src/workflows/perfumes/` | Fragrantica profile builder: find URL → headless-Chrome fetch → parse → Claude CLI profile write |
| **missing-tv-seasons** | `src/workflows/missing-tv-seasons/` | Plex TV new-seasons audit: snapshot → check TMDB for complete missing seasons → weekly digest |
| **missing-movies** | `src/workflows/missing-movies/` | Weekly Plex movie franchise-gap audit: snapshot → check TMDB Collections for released-not-owned films → weekly digest |
| **movie-recommendations** | `src/workflows/movies/` | Monthly Plex movie recommender: snapshot → an 8-branch Claude recommender fan-out → merge/verify/dedupe → digest |
| **tv-recommendations** | `src/workflows/tv-recs/` | Monthly Plex TV show recommender: snapshot → 8 Claude branches → merge/verify/dedupe → digest |
| **workouts-sync** | `src/workflows/workouts-sync/` | Monthly Hevy workout ingestion + a 6-month progress report (Claude-narrated) |
| **listening-digest** | `src/workflows/listening-digest/` | Monthly Last.fm top-albums/top-tracks digest — writes both a current-month AND a trailing-3-month markdown digest per run |
| **projects-sync** | `src/workflows/projects-sync/` | Weekly GitHub repo catalog + a Claude-summarized markdown profile per project |
| **claude-warmer** | `src/workflows/claude-warmer/` | Proactive Claude usage-window warmer, twice daily at 08:00 and 16:00 |
| **stocks-sync** | `src/workflows/stocks-sync/` | Daily Trading212 portfolio snapshot + gain-alert (strictly read-only) |
| **stock-digest** | `src/workflows/stock-digest/` | Weekly Claude-narrated stock holdings/performance/sector digest |
| **vercel-daily-redeploy** | `src/workflows/vercel-daily-redeploy/` | Daily safety-net production deploy trigger for the owner's separate `ryankrol.co.uk` site |
| **plex-space-saver** | `src/workflows/plex-space-saver/` | Weekly, report-only audit of where Plex library disk space is going |
| **plex-language-fix** | `src/workflows/plex-language-fix/` | Weekly, 4-stage DAG (discover → resolve → evaluate → apply): resolves each title's true original language via TMDB, decides per-file audio/subtitle defaults, and APPLIES them via Plex's own API — fully unattended, with a Plex Butler backup + a per-file undo log (`scripts/plex-language-undo.ts`) as the safety net instead of manual sign-off. Each file is processed exactly once, ever, via the per-item work_items ledger (not a whole-library re-scan every run) |
| **plex-profiles** | `src/workflows/plex-profiles/` | Weekly: writes one markdown profile per Plex title (movie + TV show) — summary, cast, per-source ratings, technical detail, file size — sourced purely from the Plex API, no LLM (phase 2, an optional Claude-narrated layer, is a deferred future task) |
| **overrides-audit** | `src/workflows/overrides-audit/` | Weekly, report-only audit of dashboard `_overridden` flags (service limits, workflow schedule/concurrency/notify, job timeout) that have been live 2+ weeks or are unknown-age — a reminder to fold a stable override into its manifest/service-definition code default; never auto-patches anything |

Seven workflows (`missing-tv-seasons`, `tv-recommendations`, `movie-recommendations`,
`missing-movies`, `plex-space-saver`, `plex-language-fix`, `plex-profiles`) share one Plex/TMDB
connectivity client, `src/core/plex-client.ts` — see that file, or any of the seven workflows' own
`CLAUDE.md`, for the DHCP-self-heal mechanism.

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
- **Independent stages run in PARALLEL by default (T156).** `executeDag` launches
  every ready stage (deps all succeeded) up to a concurrency cap; `runWorkflow`
  passes the **effective** maxConcurrency (see T169 below) where the default is
  **4** (raised from 1). So a DAG with independent same-wave stages — e.g. the
  `movie-recommendations` 8 recommender branches all hanging off `movie-snapshot`
  — runs them concurrently (up to 4) once their shared dependency finishes, instead
  of one-after-another. Strictly-linear workflows (places, perfumes, the TV
  `missing-tv-seasons` workflow) are unaffected: only ever one stage is ready at a time. A workflow
  overrides the cap with **`maxConcurrency`** on its `WorkflowDefinition` — raise it
  for a wider fan-out, or set **`1`** to force strict sequential order (the `movie-recommendations`
  workflow sets `4` so its branches fan out; the cap is kept modest because each
  parallel stage spawns its OWN child process, and `executeDag` queues the excess).
  The cap is also **user-editable from the dashboard + code-reconciled (T169)** —
  see the `maxConcurrency` editable-property note in Conventions: `runWorkflow`
  reads the **effective** value (DB `max_concurrency` = override when set, else the
  synced manifest value, else the default) FRESH each run via
  `effectiveWorkflowConcurrency(def)`, so an edit takes effect on the next run with
  no daemon restart.
  Parallelism does NOT loosen spend governance: paid stages still route through
  `callService` → the shared SQLite `service_usage` meter, so rate limits + monthly
  quotas are enforced GLOBALLY across processes regardless of concurrency — the
  service quota is the spend governor, not the cap.
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
- **Workflow notifications are aggregate-only (T189, supersedes T112 per-stage dedup).** `runWorkflow` emits ONLY the aggregate `notifyWorkflow(...)` call at the end of a run — there are NO per-stage push notifications (success, failure, timeout, or cycling). The former `notifyStage` per-stage push and the `lastNotifiedStatus` cycling-dedup map were removed in T189. `notifyStage` still exists in `src/core/notifier.ts` but is no longer called by the executor. The dashboard's per-stage run status is unaffected — member runs still record `running`/`succeeded`/`failed`/`cancelled` to the DB exactly as before.
- **Latest-run-per-stage ordering is rowid-deterministic (T112).**
  `listRunsForWorkflowRun` orders by `(started_at, rowid)`, NOT `started_at` alone.
  `started_at` is second-granularity, so during fast cycling an earlier cycle's
  settled run and the current cycle's fresh `running` run can share a second; without
  the `rowid` tiebreaker the dashboard's last-write-wins "latest per stage" could
  pick the stale settled run over the live one — the succeeded→running→succeeded
  status flicker. Keep any "latest run" derivation ordering by `(started_at, rowid)`.
- **The product dashboard is a pure read/refresh client of the API — NO write
  exceptions.** It never touches SQLite directly, is not required for jobs to run, and
  the product API is entirely read-only. The harness's owner-overlay writes
  (`reviewed`/`done`/`failed`) live in the **self-contained harness backlog dashboard**
  (`.harness/dashboard/server.js`, run as its own launchd agent on `:4791`), NOT in this
  product: its `POST /api/mark-{reviewed,done,failed}` endpoints shell out to
  `.harness/scripts/mark-*.sh`, which atomically write the overlay files AND commit+push
  them `[skip ci]` under the SAME mkdir repo lock the loop uses (`.harness/scripts/repo-lock.sh`).
  The overlays are unchanged owner-owned files under `.harness/tracking/`
  (`reviews.json` T136, `human-done.json` T208, `manual-fail.json` manual-fail-signal),
  each a disjoint git path so no writer conflicts. The loop still READS `manual-fail` for
  calibration (a false success is re-counted as a failure and dropped from its
  `(layer×workType)` audited-success count) and RECONCILES `human-done`/`manual-fail` →
  `TASKS.json` `status` (done / failed) at pre-flight (T261/T279, `reconcile_overlays` in
  `loop.sh`) — so the overlays are the owner's write-surface and `TASKS.json` status is
  the authoritative reconciled state. Full design: `.harness/docs/designs/manual-fail-signal.md`.
- **A `status="blocked"` task is the LOOP's own failure signal — distinct from the owner's
  `status="failed"` above, and NOT an overlay.** When `block_task()` (in `loop.sh`) gives up on
  a task (either the agent itself reports `failed:blocked` mid-attempt, or `MAX_ATTEMPTS` is
  exhausted at the top model tier), it writes the usual `failed:blocked <id> — <reason>` worklog
  marker AND now also calls `set_task_status "$id" blocked` directly — the loop already
  unconditionally owns `TASKS.json` `status`, so this needs no overlay/reconcile indirection
  (that indirection exists only because the *dashboard* isn't allowed to write `TASKS.json`
  directly; the loop has no such restriction on itself). `blocked` is terminal for selection
  (`task_blocked()` in `loop.sh`/`postflight.sh` checks `status=="blocked"` first, falling back
  to the legacy worklog-marker grep for tasks blocked before this existed — never backfilled,
  so both paths are kept). **Calibration was already correctly aligned even before this status
  existed:** `policy.jq`'s tier-selection branch already treats a `blocked:true` outcome row
  exactly like an owner manual-fail (`(.blocked or (manual-fail id)) as $failed`), and
  `audit_gate()`'s confirmed-audited-success count already required `.blocked==false` — a
  blocked row was never counted as a success to begin with. So `status="blocked"` is purely a
  **visibility** upgrade (dashboard-queryable the same way `failed` is), not a new calibration
  mechanism.

## File map

| Path | Responsibility |
|---|---|
| `src/config.ts` | Env-driven config: ports, bind host, CORS allowlist, auth token, db path, ntfy, shared Chrome profile dir |
| `src/daemon.ts` | Long-lived entrypoint: sync jobs + workflows, reap orphans, start scheduler + API |
| `src/runJob.ts` | Child entrypoint: run one job, emit NDJSON |
| `src/core/types.ts` | `JobDefinition`, `WorkflowDefinition`, `ServiceDefinition`, `JobContext`, event types — the contracts |
| `src/core/executor.ts` | Spawn child, parse events, enforce timeout, retries, overlap-prevention; **cancellation** — an `AbortSignal` threaded into the attempt loop hard-kills the in-flight child (SIGTERM→SIGKILL, the timeout path) and settles the run `cancelled` (terminal, never retried) |
| `src/core/scheduler.ts` | croner triggers for scheduled **workflows** (the only schedule owner; drives member jobs — jobs never get their own cron); respects `enabled`; registers each cron from the **effective** (DB) schedule, and `rescheduleWorkflow(name, schedule)` re-registers it LIVE after a dashboard edit — no restart (T135) |
| `src/core/dag.ts` | Workflow DAG: build + validate topological order, cycle detection; `executeDag` honours an `AbortSignal` (stops launching new stages, drains in-flight) |
| `src/core/workflow-executor.ts` | Orchestrate a workflow run: member jobs in DAG order, stage gates, retries, completed-stage progress roll-up; `repeatUntilStable` cycling with a **no-forward-progress early stop** (T112, via `workflowProgressSignature`/`noForwardProgress`); owns the **active-run registry** (`workflowRunId → AbortController`) + `cancelWorkflowRun()` that powers run cancellation; the **authoritative "one active run per workflow" guard** — `workflowRunInProgress(name)` + a synchronous per-name claim in `runWorkflow` (see below); emits ONLY the aggregate `notifyWorkflow` at run end (no per-stage pushes — T189) |
| `src/core/notifier.ts` | Run alerts (success/failure/timeout) with item counts + stuck heads-up: ntfy push + macOS notification. `notifyWorkflow` is called once per workflow run at completion (aggregate). `notifyStage` is exported but no longer called by the executor (T189) |
| `src/core/services.ts` | `callService`: cross-job shared rate-limit + quota middleware (coordinated via SQLite) |
| `src/core/browser.ts` | Shared headless-browser helper: persistent-profile + real-Chrome-channel launch (bundled-chromium fallback, stale-lock cleanup) for reputation-gated scrapes, plus a jittered-delay pacing helper |
| `src/core/plex-client.ts` | Shared, self-contained Plex + TMDB connectivity (`plexGet`/`tmdbGet`/`resolvePlexHost`, DHCP-self-heal LAN scan, plus the mutating `plexPutStreams`/`triggerButlerBackup` used by `plex-language-apply`) — used by all 7 Plex-touching workflows (`missing-tv-seasons`, `tv-recommendations`, `movie-recommendations`, `missing-movies`, `plex-space-saver`, `plex-language-fix`, `plex-profiles`), owned by none of them. The shared `plex` service now sits in front of every `plexGet`/`plexPutStreams`/`triggerButlerBackup` call — every one of those 7 workflows routes its Plex reads/mutations through `callService('plex', ...)`, giving call-count metering + per-job consumer tracking on the Integrations page |
| `src/db/schema.sql` | `jobs`, `runs`, `run_logs`, `work_items` (+ `root_key`/`parent_key` lineage), `work_item_runs` (run→work-item attribution, T139), `job_usage`, `workflows`, `workflow_jobs`, `workflow_runs` (+ `run_limit`/`selected_roots`), `workflow_run_logs`, `services`, `service_usage`, `service_consumers` (runtime-recorded job→service mapping, T186) |
| `src/db/index.ts` | SQLite connection + schema bootstrap (WAL mode) |
| `src/db/store.ts` | A pure barrel (`export * from './store/<domain>.js'`, zero logic) — every symbol is still importable from `../db/store.js` exactly as before (T529) |
| `src/db/store/` | ALL queries live here, split by domain — add new ones to the matching domain file, not inline. `lib.ts` (shared path helpers), `jobs.ts`, `runs.ts` (+ global log feed), `workItems.ts` (per-item ledger, lineage, stuck/ignored), `usage.ts` (per-job spend meter), `workflows.ts` (workflow defs, workflow runs, progress roll-up, framework logs), `services.ts` (service defs, rate/quota meter, consumers, response cache), `admin.ts` (stale-override audit, output reset, definition deletes, read-only DB browser + canned queries) |
| `src/workflows/registry.ts` | Auto-discovers `*.job.ts` + `*.workflow.ts` under `src/workflows/` AND `*.service.ts` under BOTH `src/services/` and `src/workflows/` (no manual registration); fails loud if any job belongs to no workflow (`orphanJobNames`) |
| `src/services/*.service.ts` | **Top-level, daemon-wide** service definitions, default-exporting a `ServiceDefinition` (shared rate-limited / quota'd dependencies — gemini, google-places, fragrantica, claude-cli). **Self-contained**: each owns its limits from env and imports NOTHING from a workflow |
| `src/services/lib.ts` | Shared service spend-cap math: `DAILY_SPEND_DIVISOR` (=30) + `dailyFromMonthly()` — the `daily = monthly/30` rule for paid daily-scheduled services |
| `src/services/claude.ts` | Shared, self-contained Claude Code CLI helper (`runClaude`/`extractJsonObject`) — gates every call through the `claude-cli` service, reads `LOCALJOBS_CLAUDE_BIN`/`_TIMEOUT_MS` from env. Used by the movies recommender branches (T146). (Perfumes still has its own `perfumes/claude.ts` — migrating it onto this is a follow-up; see `.harness/docs/LIMITATIONS.md`.) |
| `src/workflows/<workflow>/` | One folder per example workflow (`places/`, `perfumes/`, `missing-tv-seasons/`, `missing-movies/`, `movies/`, `tv-recs/`, `workouts-sync/`, `listening-digest/`, `projects-sync/`, `claude-warmer/`, `stocks-sync/`, `stock-digest/`, `vercel-daily-redeploy/`, `plex-space-saver/`, `plex-language-fix/`, `plex-profiles/`, `overrides-audit/`). Shared files at the workflow root (`*.workflow.ts`, `config.ts`, `types.ts`, `contracts.ts`, helpers, the template, `data/`); per-stage code grouped under a flat `stages/` subfolder. **Each folder has its own `CLAUDE.md`** with the workflow's full current-state documentation (see "Shipped example workflows" above) |
| `src/workflows/<workflow>/stages/*.job.ts` / `*.ts` | One stage per `<stage>.job.ts` (default-exports a `JobDefinition`) + its `<stage>.ts` impl (+ `<stage>.test.ts`). Root-level top-level `*.job.ts` files are gitignored; the `places/`+`perfumes/` stages are tracked |
| `src/workflows/*.workflow.ts` | Workflow manifests, default-exporting a `WorkflowDefinition` (DAG of jobs); live at the workflow-folder root |
| `src/api/server.ts` | Node `http` API (no framework). Routing is a declarative `routes: Route[]` table (`{ method, pattern, handler }`) matched by `matchRoute` — a small exact-segment-length matcher (T530) that replaced the old sequential `if (method === … && parts[N] === '…')` chain. A `:name`-style pattern segment matches any literal path segment and is captured into `ctx.params`; every other segment must match literally; the pattern and the path must have the SAME segment count. That length-exact requirement is the actual fix: the old chain had a real bug class where a check like `parts[3] === 'runs'` matched ANY path with `'runs'` at that position regardless of what followed, so `GET /api/workflows/foo/runs/extra` incorrectly matched the `:name/runs` handler instead of 404ing — `matchRoute` can't do that. Route order is otherwise irrelevant (no two routes share the same method + segment count with a possible overlap). Add a new endpoint by appending a `{ method, pattern, handler }` entry to `routes` |
| `dashboard/app/*` | Next.js App Router dashboard (client components, poll via `app/lib/api.ts`); all responsive CSS lives in `app/globals.css`. `dashboard/app/admin/page.tsx` (route `/admin`) is the single admin page, hosting both a "Delete all workflow output" action and a "Cached responses" section + "Clear all cached responses" action (`POST /api/cache/clear`) for the per-service `service_cache` (T451) table — the two destructive actions are functionally distinct (separate API calls), neither touches the other's data |
| `dashboard/scripts/_dashboard-harness.mjs` | Shared hermetic test harness (the SINGLE living artifact): `PAGES` list + synthetic API fixtures + `next start` spawn + `/api/**` interception + theme seeding; imported by both checks below. Update it when the UI surface changes |
| `dashboard/scripts/mobile-check.mjs` | Hermetic phone-viewport (402px) styling check — overflow/box-spill; local only, not in CI |
| `dashboard/scripts/visual-check.mjs` | Hermetic desktop-viewport SCREENSHOT capture for visual confirmation (the thing actually renders) — writes PNGs to the gitignored `visual-out/`; no appearance assertions; local/loop only, not in CI |
| `scripts/*` | launchd install scripts + start wrapper, plus one-off manual admin scripts (`backfill-service-usage.ts`, `cleanup-listens-spotify.ts`, `reset-stock-sector-lookup-null-successes.ts`, `plex-language-undo.ts` — a manual, never-scheduled revert tool for `plex-language-apply`, dry-run by default, `--apply` to actually revert) |

## How to add a job (the common request)

**Every job must belong to a workflow** — there are no standalone jobs. A lone job
is a one-stage workflow with its own `*.workflow.ts` manifest (no implicit
wrapping). The workflow owns the `schedule`; a job with no manifest fails loud at
load.

1. Create `src/workflows/<name>.job.ts`:
   ```ts
   import type { JobDefinition } from '../core/types.js';

   const job: JobDefinition = {
     name: 'unique-name',           // stable; it's the DB primary key
     description: 'A paragraph (a few sentences) explaining what this stage ' +
       'actually does step by step, what it reads/writes, and any notable ' +
       'behavior (rate limiting, retries, idempotency, gating) — NOT a short ' +
       'label. Plain prose only, no markdown, since it renders inside a plain ' +
       '<p> on both /jobs/[name] and /runs/[id].',
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
   not on the job. **Write `description` as a real paragraph, not a one-liner** — it
   renders on TWO dashboard surfaces: the job's own page (`/jobs/[name]`) and every
   individual run of that job (`/runs/[id]`), so a terse label under-serves both.
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

**Multi-stage workflow layout (the example folders).** A workflow folder keeps its
shared files at the JOB ROOT (`*.workflow.ts`, `config.ts`, `types.ts`,
`contracts.ts`, any helper modules + the template + `data/`) and groups its
per-stage code under a flat `stages/` subfolder — one `<stage>.job.ts` +
`<stage>.ts` impl (+ `<stage>.test.ts`) per stage. **Adding a new stage** = drop
its files in `<workflow>/stages/` and add the member to the `*.workflow.ts` — jobs
are discovered **recursively**, so a `*.job.ts` in `stages/` is picked up
automatically. A stage file imports root-level shared modules one level up
(`../config.js`, `../types.js`, `../contracts.js`, …) and framework code two more
(`../../../core/…`, `../../../db/…`); sibling stages stay `./`. Keep config/data
resolution (`resolve(here, …)`) anchored at the job root, so `config.ts`/`data/`
stay at the root, not in `stages/`.

**Adding a service** = create `src/services/<name>.service.ts` (top-level,
daemon-wide), default-exporting a self-contained `ServiceDefinition` that reads its
own limits from env and imports nothing from any workflow. The registry discovers
it from `src/services/` automatically (it also still scans `src/workflows/` so a private
job MAY colocate a service it owns).

> **Privacy — real jobs are local-only by default.** Top-level
> `src/workflows/*.job.ts` files are gitignored. The
> public repo ships the `places/`, `perfumes/`, `plex/`, `movies/`, `missing-movies/`, `tv-recs/`, `workouts-sync/`, `listening-digest/`, `projects-sync/`, `claude-warmer/`, `stocks-sync/`, `stock-digest/`, `vercel-daily-redeploy/`, `plex-space-saver/`, `plex-language-fix/`, `plex-profiles/`, and `overrides-audit/` subfolder workflows as
> worked examples, but their `data/` folders stay gitignored. New jobs you add as
> a root-level `*.job.ts` stay untracked by design. NEVER use `git add -f` on a
> private job file.
>
> For a **new private multi-file workflow**, create `src/workflows/<name>/` and add the
> line `src/workflows/<name>/` to `.gitignore`. Jobs are discovered **recursively**,
> so a `*.job.ts` inside that folder is picked up automatically while its helper
> modules stay private too.

### Job conventions
- Jobs must be **idempotent / safe to re-run** (they retry and can be run
  manually). Use guards / "skip if already done".
- **An item-loop job must fail its own run if it failed ANY item this run (2026-07, T416).**
  The per-item `try/catch` / `markWorkItem(..., 'failed', ...)` / `continue` pattern inside a
  processing loop is UNCHANGED and still correct — one bad item must not stop the loop from
  attempting every other item this run. BUT at the END of that loop, if this run's own tally
  shows `failed > 0` (a genuine `'failed'` outcome — NOT a `'skipped'` soft-stop like a
  quota/rate-limit pause, which is an intentional defer-to-later-run, not a failure), the job's
  `run()` function MUST `throw` a summarizing `Error` (e.g.
  `` throw new Error(`${failed}/${processed} item(s) failed this run — see logs above`) ``)
  instead of returning normally. This needs NO new framework mechanism — it reuses machinery that
  already exists: the thrown error correctly marks the RUN `'failed'` (`src/runJob.ts` →
  `src/core/executor.ts`), which correctly blocks every downstream DAG dependent (`executeDag`'s
  ready-stage loop already treats any status other than exactly `'success'` as blocking), and
  correctly triggers the job's own retry budget (`runAttempts`/`maxRetries`, unchanged) — a retry
  (or the next scheduled run) naturally skips already-`isWorkItemDone` items and resumes at the
  first not-yet-done one, since that idempotency filtering is already how every compliant
  item-loop job works (the rule above). Most jobs already compute an `{ ok, failed, ... }` tally
  for their own logging/return value — for those, the fix is usually just a couple of added lines
  at the very end: `if (failed > 0) throw new Error(...)`. Applies ONLY to genuine item-PROCESSING
  loops where a per-item failure is currently silently swallowed — not to a stage with no
  per-item "did work" concept (e.g. a pure notify-trigger that either sends a push or doesn't).
  This is a documentation-only convention (no job has been retrofitted yet — that's separate
  per-workflow follow-up work).
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
  **`detail.markdown`/`detail.path` are stored relative to the workflows root, not as a
  frozen absolute path (T447).** `markWorkItem` (`src/db/store.ts`) normalizes both keys
  via `toStoredPath` before persisting — a job author still just passes its natural
  absolute path (`resolve(dataDir, 'out', ...)`); the store makes it relative
  (`<workflow>/data/out/...`) transparently, so no job call site needs to change. This
  fixes a real incident: the 2026-07 `src/jobs` → `src/workflows` rename (T331) froze
  every already-recorded row's absolute path, permanently orphaning the "View" preview
  for ~500 rows across 13 jobs until a one-time repair (`scripts/backfill-fix-stale-output-paths.ts`)
  fixed them. A future workflow-folder rename can't strand new rows the same way.
  `safeOutputMarkdown`/`safeOutputFile` in `server.ts` resolve a relative candidate
  against the freshly-computed `WORKFLOWS_ROOT`; an absolute candidate (legacy rows,
  or rows outside the workflows tree) still resolves exactly as before.
- **Every stage's success `detail` must describe what THAT STAGE produced — not just restate
  the item's identity (2026-07, generalizes T110).** `work_items` is fundamentally an
  idempotency/retry ledger, but its `detail` blob is also the ONLY evidence the dashboard's
  Inputs & Outputs panel (`StageIoPanel`, T382+) can show for what happened at a stage — the
  panel has no way to see a `ctx.log` line or a file on disk, only what's recorded in `detail`.
  A `detail` of just `{ name }` (or `{ name, attempts }`) reads as if the stage did nothing, even
  when it performed real work (a browser scrape, an LLM extraction, a resolved value) — found
  live on `perfumes-fetch`/`perfumes-parse`, whose successful `detail` never referenced the raw
  page or parsed-JSON files they actually wrote to `data/out/`. Concretely, on every stage's
  SUCCESS `markWorkItem` call:
  - **Stage writes a file** → reference it. Reuse `detail.markdown` for a markdown artifact
    (T110, unchanged) or, for any OTHER file type, `detail.path` + `detail.format` — the SAME
    pair the T262 output-form convention already defines for a workflow's terminal/output stage,
    generalized here to EVERY stage, not just the terminal one. Both are already served by the
    read-only `GET /api/workflow-runs/:id/output?job=&key=` endpoint via `resolveOutputForm`
    (`safeOutputFile` accepts any extension under `data/out/`), and the dashboard's
    `StageIoPanel` recognizes either field to show a "click to preview" link
    (`dashboard/app/components/StageIoLists.tsx`).
  - **Stage discovers/computes a value, writes no file** → put the value itself in `detail`
    (a resolved URL, an industry classification, a count, a rating) — `perfumes-find-url`'s
    `{ name, url }` and `stock-sector-lookup`'s `{ name, industry }` are the worked examples.
  - **Stage is a genuine, deliberate pass-through** with nothing of its own to show (rare) —
    minimal `detail` is fine, but this should be a conscious exception a stage author chooses,
    not the unexamined default every stage falls back to.
  This is convention, not mechanically enforced (unlike the gate-coverage test) — there is no
  structural way to distinguish "identity-only because there's genuinely nothing to show" from
  "identity-only because the author never considered it" without reading the stage's own code.
- **Unified Output section on the workflow detail page (T205).** Every workflow's detail
  page shows a consolidated **Output** section backed by `GET /api/workflows/:name/output-items`
  → `workflowTerminalItems(lastWave)` in `src/db/store.ts`. The convention is:
  - **The terminal stage's `work_items` ledger IS the output list.** `workflowTerminalItems`
    queries `work_items` for the DAG's final-wave job names with `status='success'`, ordered
    newest first. Items are de-duped by `(job_name, item_key)` by construction (the ledger has
    a UNIQUE key per pair), so each produced item appears exactly once regardless of how many
    runs have processed it.
  - **Markdown artifact workflows** (places, perfumes): the terminal stage records
    `detail: { name, markdown: <path> }` on each `markWorkItem` call (T110). The output
    section shows a "View" button per item that fetches `GET /api/workflows/:name/output?job=&key=`
    (same guard as the per-run endpoint: `safeOutputMarkdown`, confined to `data/out/` tree)
    and opens the content in a markdown popover.
  - **Audit-style workflows** (movie-recommendations, missing-tv-seasons): these already have
    dedicated, richer output managers (`MovieRecsManager`, `MovieGapsManager`,
    `MissingSeasonsManager`) on the detail page. They are EXCLUDED from the generic section
    (the `WORKFLOWS_WITH_SPECIFIC_MANAGERS` set in `page.tsx`). New dedicated managers should
    be added to that set; standard build workflows use the generic section automatically.
  - **Adding a new workflow that produces output**: make the terminal stage call
    `markWorkItem(ctx, key, 'success', { detail: { name: ..., markdown: <path> } })` for
    markdown artifact items, OR just `markWorkItem(ctx, key, 'success')` for non-markdown
    items. The output section renders automatically — no extra wiring needed.
  - **`outputJob` override for a non-terminal output stage (T348).** Some workflows are
    shaped build-then-notify, where the DAG's TERMINAL stage is a pure notify-trigger that
    structurally never records `work_items` rows (e.g. `stocks-sync`'s `stocks-notify`, which
    just reads `fresh-breaches.json` and optionally sends one push) — for these the generic
    Output section would always be empty even though a real, meaningful ledger exists one
    stage earlier. `WorkflowDefinition.outputJob` (an optional field on the manifest, like
    `category`) names a different member job whose ledger the Output section should read
    instead; `GET /api/workflows/:name/output-items` uses it (falling back to the terminal
    wave if unset or if the name isn't an actual member) in place of `lastWave`. It's
    opt-in and manifest-owned only — no dashboard edit UI, no `_overridden` column, same as
    `category`.
  - **Output-form convention (T262) — how to add a new render form.** An output
    item declares its render form via `detail.format` (a string, defaults to `"markdown"`
    when absent). The read-only output endpoint (`GET /api/workflow-runs/:id/output` and
    `GET /api/workflows/:name/output`) dispatches on `detail.format` and serves the file
    through the matching safety guard — both guards confine reads to the job's own
    `data/out/` tree, so all forms inherit the same path-safety properties:
    - **`markdown` (default)**: the path comes from `detail.markdown`; served via
      `safeOutputMarkdown` (must end in `.md`). Existing places/perfumes outputs use
      this form with no change — `detail.format` is optional for backward compat.
    - **Any other form** (e.g. `"json"`, `"table"`): the path comes from `detail.path`;
      served via `safeOutputFile` (any extension allowed, same `data/out/` + realpath
      guards). The response payload includes `format` so the dashboard renderer
      (T282) can dispatch to the right viewer.
    - **To add a new form**: record `{ name, format: '<key>', path: <absPath> }` in
      `detail` via `markWorkItem`; the API serves it automatically. The renderer
      dispatch (T282) then adds a viewer for `<key>` in the dashboard — no endpoint
      changes needed. Keep output files under `data/out/` (the guard rejects anything
      outside that tree).
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
- **A workflow's `schedule` is user-editable + code-reconciled (T135).** Like the
  `enabled` toggle and the editable service limits, the cron `schedule` is
  **user-owned**: `POST /api/workflows/:name/schedule { schedule }`
  (`updateWorkflowSchedule` in `store.ts`) persists an override and flips
  `schedule_overridden = 1`, so a later `syncWorkflow` PRESERVES it
  (`schedule = CASE WHEN schedule_overridden = 1 THEN schedule ELSE excluded.schedule END`
  in `upsertWorkflowStmt`) instead of reverting to the manifest value. An empty/blank
  value clears it to `null` = manual-only. The scheduler registers each cron from the
  **EFFECTIVE** (DB) schedule — override when set, else the synced code default — and
  `rescheduleWorkflow(name, schedule)` re-registers the live `Cron` after an edit so it
  takes effect **without a daemon restart** (mirroring the fire-time `enabled` check).
  The API VALIDATES the cron server-side (`new Cron(expr, { paused: true })`) and
  rejects an invalid expression with **400** before it ever reaches the scheduler;
  it's a mutating endpoint behind the same loopback/token guard as `/toggle`, `/run`,
  `/limits`. `schedule_overridden` is added by `schema.sql` (fresh DBs) + an additive
  `ALTER TABLE` migration in `index.ts` (existing DBs, per the T098 rule).
- **A workflow's `maxConcurrency` is user-editable + code-reconciled (T169).** The
  bounded-parallelism cap (T156) joins `schedule` + `enabled` + service limits as a
  user-owned, override-flagged, code-reconciled workflow property — same mechanism
  end-to-end. `POST /api/workflows/:name/concurrency { maxConcurrency }`
  (`updateWorkflowConcurrency` in `store.ts`) persists the value and flips
  `max_concurrency_overridden = 1`, so a later `syncWorkflow` PRESERVES it
  (`max_concurrency = CASE WHEN max_concurrency_overridden = 1 THEN max_concurrency ELSE excluded.max_concurrency END`
  in `upsertWorkflowStmt`) instead of reverting to the manifest value; the manifest's
  `maxConcurrency` SEEDS `max_concurrency` on sync (a non-overridden value still
  refreshes from code). `runWorkflow` reads the **EFFECTIVE** value
  (`effectiveWorkflowConcurrency(def)` = DB `max_concurrency` ?? `def.maxConcurrency`
  ?? `DEFAULT_WORKFLOW_CONCURRENCY`) FRESH each run, so an edit takes effect on the
  **next run without a daemon restart** (mirroring the fire-time schedule/enabled
  checks). The API VALIDATES it server-side (positive integer ≥ 1, else **400**)
  before it reaches the store and exposes `effective_max_concurrency` on the
  `GET /api/workflows/:name` payload for the detail page's editable "Max concurrency"
  row (number input + Save, like Schedule); it's a mutating endpoint behind the same
  loopback/token guard as `/toggle`, `/run`, `/schedule`, `/limits`. The
  `max_concurrency` + `max_concurrency_overridden` columns are added by `schema.sql`
  (fresh DBs) + an additive `ALTER TABLE` migration in `index.ts` (existing DBs, per
  the T098 rule — no index on the new columns).
  **Unlimited (no cap, T201).** Setting `maxConcurrency = 0` (the
  `UNLIMITED_CONCURRENCY_SENTINEL`) expresses "no concurrency cap — launch ALL ready
  stages together". The API accepts `0` alongside ≥1 (still rejects negatives/garbage
  with **400**); `updateWorkflowConcurrency` in `store.ts` allows `0`; and
  `effectiveWorkflowConcurrency` maps `0 → Infinity` so `executeDag` skips the slot
  check entirely. The dashboard's "Max concurrency" editor exposes an explicit
  **Unlimited** checkbox — when checked, `0` is persisted and the read view shows
  "Unlimited" instead of a number. `effective_max_concurrency = 0` in the API payload
  signals the unlimited state to the UI (Infinity cannot serialise as JSON).
- **A workflow's push notifications are user-editable + code-reconciled (T285).**
  Whether the run-end aggregate push notification (T189) fires joins `schedule` +
  `maxConcurrency` + `enabled` + service limits as a user-owned, override-flagged,
  code-reconciled workflow property — same mechanism end-to-end, binary on/off only
  (no per-status "only notify on failure" mode). `POST /api/workflows/:name/notify
  { notifyEnabled }` (`updateWorkflowNotifyEnabled` in `store.ts`) persists the value
  and flips `notify_enabled_overridden = 1`, so a later `syncWorkflow` PRESERVES it
  (`notify_enabled = CASE WHEN notify_enabled_overridden = 1 THEN notify_enabled ELSE
  excluded.notify_enabled END` in `upsertWorkflowStmt`) instead of reverting to the
  manifest value; the manifest's `notifyEnabled` (default `true`) SEEDS
  `notify_enabled` on sync. `runWorkflow` reads the **EFFECTIVE** value
  (`effectiveWorkflowNotifyEnabled(def)` = DB `notify_enabled` ?? manifest
  `notifyEnabled` ?? `true`) FRESH each run and gates ONLY the single T189 aggregate
  `notifyWorkflow(...)` call at the end of `runWorkflowInner` (not per-stage — there
  are none since T189) — when disabled it logs a clear "Notifications disabled…"
  line instead so the run's own log still narrates why no push went out. An edit
  takes effect on the **next run without a daemon restart**. The API VALIDATES the
  body is a boolean (else **400**) before it reaches the store and exposes
  `effective_notify_enabled` on the `GET /api/workflows/:name` payload for the
  detail page's click-to-toggle "Notifications" row (same affordance as the
  `enabled` toggle — no Save button); it's a mutating endpoint behind the same
  loopback/token guard as `/toggle`, `/run`, `/schedule`, `/concurrency`, `/limits`.
  The `notify_enabled` + `notify_enabled_overridden` columns are added by
  `schema.sql` (fresh DBs, default `1` = ON) + an additive `ALTER TABLE` migration in
  `index.ts` (existing DBs, per the T098 rule — no index on the new columns).
- **A workflow's `certified` flag is a plain user-set toggle — deliberately simpler
  than the three above, no `_overridden` column at all (T497).** Unlike `schedule`/
  `maxConcurrency`/`notifyEnabled`, `certified` has no code/manifest source to seed
  from or reconcile against — it exists purely so the owner can mark a whole
  workflow "reviewed & settled" (distinct from the harness's own per-task
  reviewed/done overlays under `.harness/tracking/`) and stop re-reviewing its output
  every session. `POST /api/workflows/:name/certify { certified }`
  (`setWorkflowCertified` in `store.ts`) does a plain `UPDATE workflows SET
  certified = ?` — no override flag to flip, no `_overridden_at` timestamp, and
  `syncWorkflow`'s upsert never references `certified` at all, so a code-sync can
  never reset it either way. It persists until manually un-set and is purely
  informational: no functional, scheduling, or notification side effects. The API
  validates the body is a boolean (else **400**) before it reaches the store; it's a
  mutating endpoint behind the same loopback/token guard as `/toggle`, `/run`,
  `/schedule`, `/concurrency`, `/notify`. `certified` is exposed on both
  `GET /api/workflows` and `GET /api/workflows/:name` with no extra wiring — both
  already spread the raw `WorkflowRow`. The `certified` column is added by
  `schema.sql` (fresh DBs, default `0`) + an additive `ALTER TABLE` migration in
  `index.ts` (existing DBs, per the T098 rule — no index on the column, and since
  there's no `_overridden` companion column, no bootstrap-index trap either).
- **A dashboard override is provisional, not a place to retire a value (T475).** Every
  `_overridden` flag above (service limits, workflow schedule/concurrency/notify, job
  timeout) exists so a dashboard edit can temporarily take ownership away from the
  manifest/service-definition code default — it is not meant to be the value's permanent
  home. Once an override has been stable for 2+ weeks, fold it into the manifest's code
  default and clear the override flag by hand (there is no automated "reset to code
  default" action). Each setter also stamps a matching `_overridden_at` timestamp
  (`limits_overridden_at`, `schedule_overridden_at`, `max_concurrency_overridden_at`,
  `notify_enabled_overridden_at`, `timeout_ms_overridden_at`), and the weekly
  `overrides-audit` workflow (`src/workflows/overrides-audit/`) reports any override that's
  either unknown-age (set before that column existed) or 2+ weeks old — the reminder
  mechanism for this rule, report-only, never auto-patching anything.
- **A workflow's `category` is manifest-owned only — no dashboard edit UI (T292).**
  Unlike `schedule`/`maxConcurrency`/`notifyEnabled`, `category` is a pure grouping
  label for the workflows-list page with NO `_overridden` column and NO edit
  endpoint: `syncWorkflow` always refreshes it from the manifest's `category` field
  on every sync (same as `description`), so there is nothing for the owner to
  override. Controlled values in use: `second-brain` (places, perfumes),
  `recommendations` (movie-recommendations, tv-recommendations,
  missing-tv-seasons, missing-movies), and `regular-maintenance` (workouts-sync, listening-digest,
  projects-sync, claude-warmer, stocks-sync). A manifest with no `category` set
  defaults to `'uncategorized'`. The `category` column is added by `schema.sql`
  (fresh DBs, `NOT NULL DEFAULT ''`) + an additive `ALTER TABLE` migration in
  `index.ts` (existing DBs, per the T098 rule — no index on the new column).
- **Per-workflow "Clear output data" reset action (T203).** `POST /api/workflows/:name/reset-output`
  (mutating — loopback/token guard, refuses with **409** while a run is active) wipes all
  output state for a workflow so it re-processes from scratch on the next run.
  **What is cleared:** `work_items` + `work_item_runs` (the per-item ledger), `run_logs` +
  `runs` (all member job run history), `workflow_run_logs` + `workflow_runs` (all workflow run
  history), and the contents of the workflow's `data/out/**` directory (output files only —
  NOT the `data/out` directory itself, which is left in place).
  **What is preserved:** `data/raw/**` (input data), `data/chrome-profile/`, `.env`, the
  definition tables (`workflows`, `jobs`, `workflow_jobs`), all user-owned settings
  (`enabled`, schedule override, concurrency override, service limit overrides), and
  `service_usage` (the spend meter — lifetime call counts are never erased).
  The filesystem cleanup (`findWorkflowDataOut` + `deleteDataOutContents` in `server.ts`)
  locates the workflow's folder by scanning `JOBS_ROOT` for `*.workflow.ts` files and
  dynamically importing each to match by `default.name` (fast — already in module cache after
  registry startup). Two path-safety guards in `deleteDataOutContents` enforce that the target
  is (1) within `JOBS_ROOT` AND (2) contains `/data/out/` in its path — neither check alone
  is sufficient. The DB reset (`resetWorkflowOutput` in `store.ts`) uses subquery-based deletes
  (`DELETE … WHERE run_id IN (SELECT id FROM runs WHERE job_name IN (…))`) to avoid SQLite's
  999-variable limit. The dashboard's workflow detail page exposes a **Danger zone → Clear
  output data** button (disabled while a run is active, confirms via the browser native dialog
  before posting) and shows a green success line or red error message after the call.
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
  - **Variant — "re-scan + notification-log" idempotency (the `missing-tv-seasons`
    workflow; folder `src/workflows/missing-tv-seasons/`).** Some workflows have NO static input list to skip-against: their inputs
    are DISCOVERED live each run (the plex audit re-reads the whole Plex library +
    re-checks TMDB every time). Such a workflow **declares no `inputKeys()`** (so it
    is NOT limitable — scheduled-only, always unlimited) and its scan/check stages
    deliberately **re-compute fresh every run** (no skip-if-done). Idempotency then
    lives ONLY in the FINAL stage, which uses the `work_items` ledger not as a
    "work-done" log but as a **"have I already notified this?" log**: it keys each
    actionable result `(notify-job, "<id>::S<n>")`, treats rows NOT yet `success` as
    newly-detected, sends ONE digest of just those, and marks them done so each is
    announced exactly once (first run = the whole current backlog). Record ledger
    rows ONLY for actionable items so the IO panel highlights those, not the 600+
    "up to date" rows. Same-key stages → `root_key = item_key` naturally (no lineage
    args). Use this shape when the work is a periodic audit/alert, not a build.
  - **Plex client self-heals a changed DHCP IP.** The owner's Plex server gets its IP
    via DHCP, so a hardcoded `PLEX_HOST` goes stale — the shared `src/core/plex-client.ts`
    (`resolvePlexHost`, used by all 4 Plex-touching workflows) confirms the configured
    host first and otherwise scans the local LAN for a live Plex, self-healing the
    address. Full mechanism + tests: `src/core/plex-client.ts` /
    `src/core/plex-client.test.ts`.
  - **Run→work-item attribution (`work_item_runs`, T139).** `work_items` stays the
    CUMULATIVE, idempotent ledger keyed by `(job_name, item_key)` with NO run
    linkage. The separate append-only `work_item_runs` table
    (`(workflow_run_id, job_name, item_key, root_key, at)`, UNIQUE per run+item)
    attributes WHICH workflow run advanced each item: `markWorkItem` records a
    linkage row (using the SAME resolved `root_key`) whenever it runs inside a
    workflow run — it reads the run id from its optional `workflowRunId` param,
    defaulting to `process.env.LOCALJOBS_WORKFLOW_RUN_ID` (set by the executor for
    every child), so existing call sites are UNCHANGED and a standalone run records
    nothing. This powers the **genuinely run-scoped** workflow-run Inputs & Outputs
    panel: `stageIoLists(outputJobNames, inputJobNames, runId)` (T386, superseding
    the original T139 `workItemIoRows` joined-table function, removed in T389)
    lists every ledger row THIS run recorded for the given stage(s), as two
    independent, un-paired lists — see the `<StageIoPanel>` entry above. Being a
    brand-new table, `work_item_runs`' index lives in `schema.sql` (the columns
    exist on creation for fresh AND existing DBs, so it does NOT hit the T098 trap).
  - **The FIRST stage owns the per-item list (convention).** A multi-stage
    workflow's first stage must record the canonical per-item work-item list that
    the rest of the pipeline keys on — one `markWorkItem` per input item, keyed by
    the stable id every downstream stage uses (e.g. places-ingest records one item
    per CID-bearing place, keyed by CID). Do this **even for a bulk-prep first stage**
    that produces a single file: it parses the CSVs into `places.json` *and* emits the
    ledger list (`recordIngestLedger`). Why: the work-item ledger — and the
    workflow-run **Input → Output mapping**, which pairs the FIRST stage's work_items
    with the LAST stage's by `root_key` — is anchored from stage one. If the first
    stage records nothing, the IO panel has no input side and renders **empty**
    (the places bug: ingest used to produce only a file, so the panel was blank). A
    bulk first stage re-records the full current list each run (idempotent upsert; it
    doesn't skip). Keep the first stage's item key == the downstream `root_key` so the
    mapping joins cleanly. **It must still filter by `ctx.rootAllowed`** like every stage
    (T094) — on a *limited* manual run only the selected roots are recorded, so the ledger
    + IO mapping reflect the limited subset (the full catalog file is still written; only
    the ledger is scoped). This is SEPARATE from the **root stage** (the first member
    declaring `inputKeys()`, which drives the limit): that stays the first stage whose
    ledger *meaningfully tracks per-item completion* (for places that's the resolver, not
    ingest — ingest marks every item `success` at once, which would break the limit's
    "pick the first N not-yet-done roots" logic if ingest were the root).
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
    - **"Pending" is propagation through the TERMINAL stage, not just past the entry
      stage (T163).** `selectPendingRoots` takes the DAG's **terminal wave** job names
      (`dag.waves[last]`, threaded from `runWorkflow`) and `isRootPending` decides a
      root is pending unless it's *fully processed*: (1) any retryable not-done row
      anywhere → pending; else (2) a *done* terminal-stage row for that `root_key` →
      fully done; else (3) a "gave-up" marker (an `ignored` or retry-exhausted
      `failed` row at any stage) with no retryable work → stuck below the terminal,
      treated as done so the selector can't **livelock** on an unprogressable root;
      else (4) it has un-attempted downstream work (entry done, a later stage has NO
      row at all — e.g. a resolved-but-not-enriched place) → **pending**. Step (4) is
      the bug fixed: the old logic asked only "is the *entry* stage done OR is there an
      existing outstanding row", so a root whose later stages simply hadn't been
      attempted (no row) looked complete and a limited backlog catch-up selected **0
      roots and silently no-op'd** while reporting success. Guard: when a limited run
      computes an EMPTY `selected_roots` from a NON-empty candidate set, `runWorkflow`
      logs a clear **WARN** on the run ("limit N … 0 originating inputs were
      selectable — N candidate(s), all already complete") instead of quietly
      succeeding. (Unlimited/scheduled runs never call `selectPendingRoots`; each stage
      just processes its own not-done items — unaffected.)
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
  - **Ignore-to-suppress a SURFACED (non-failed) item (T145).** The audit-style
    workflows (`missing-tv-seasons`/`missing-movies`) whose ledger tracks "have I notified this?" rather
    than work-done need to ignore a still-VALID surfaced item (a franchise film the
    owner owns some-but-not-all of and deliberately doesn't want) — NOT a `failed`
    one. `ignoreSurfacedItem(jobName, itemKey)` in `store.ts` EXTENDS ignore to this
    case: it UPSERTS the ledger row to `ignored` (creating it if absent — a surfaced
    gap is typically `success` after its one notification, or has no row yet),
    whereas `ignoreWorkItem` requires a `failed` row. The notify stage then excludes
    ignored keys from BOTH the report (`ignoredItemKeys(jobName)`) AND notifications
    (`isWorkItemDone` already treats `ignored` as done, so it's never re-notified).
    Wired for the franchise-gap audit (owned by the `missing-movies` workflow since T468) via
    `POST /api/movie-gaps/:tmdbId/ignore` + a "Recommendations &
    gaps" management section that is STILL, PENDING T469, rendered on the **movie-recommendations
    workflow detail page** (`/workflows/movie-recommendations`, gated to render only for that
    workflow — T152 folded it in from the old dedicated top-level `/movie-gaps` page; T469 moves it
    onto `missing-movies`'s own detail page); still MANUAL-ONLY (nothing auto-ignores). Reuse this
    shape for any future periodic-audit workflow that needs the owner to permanently silence a
    factual-but-unwanted finding. The movie-recommendations **recommendation layer** (T146) reuses
    it verbatim for recs: `ignoreSurfacedItem('movie-recs', <tmdbId>)` excludes a rec
    from both the merge (it filters `isWorkItemDone`) and the digest/report — so an
    ignored ("not interested") rec never resurfaces. The owner-facing trigger is
    `POST /api/movie-recs/:tmdbId/ignore` with a dashboard Recommendations section on the
    movie-recommendations workflow detail page (T209, mirroring the franchise-gaps section).
    A `movie-recs` ledger row keyed by
    the recommended film's tmdb id also serves as the **never-re-recommend** dedup log
    (`success` = already recommended), distinct from the `movie-gaps-notify` ledger.
  - **Reversing an ignore — `unignoreSurfacedItem` (T391).** All four ignore lists
    (movie franchise gaps, movie recs, TV recs, missing TV seasons) previously had no
    way back once dismissed. `unignoreSurfacedItem(jobName, itemKey)` in `store.ts` is
    the OPPOSITE of `ignoreSurfacedItem`: it **DELETES** the `ignored` ledger row
    (mirroring `unstickWorkItem`'s delete-and-refresh pattern) rather than resetting it
    to some other status — a deliberate design choice, since "un-ignore" means "forget
    my decision", not "keep it marked notified but merely make it visible again".
    **Consequence, not a bug:** because these workflows use the "have I already
    notified this?" ledger pattern (T144), deleting the row means an un-ignored item is
    genuinely treated as brand-new and CAN be re-notified/reappear in a future digest —
    exactly like an un-stuck item is retried fresh. Per-item only, no bulk variant
    (there's no analogous "un-ignore a whole group" action requested). Four endpoints
    mirror their `ignore` counterparts exactly (same validation/guard pattern):
    `POST /api/movie-gaps/:tmdbId/unignore`, `POST /api/movie-recs/:tmdbId/unignore`,
    `POST /api/tv-recs/:tmdbId/unignore`, `POST /api/missing-seasons/:tmdbId/:season/unignore`
    — each returning `{ ok: true, unignored: <rows affected> }`. Each of the 4
    managers' `IgnoredSection` table (`dashboard/app/workflows/[name]/page.tsx`) has a
    per-row **"↺ Un-ignore"** button (confirm-gated, reusing the manager's existing
    `busy`/`err` state keyed the same way the active-list Ignore button already is) —
    on success the item reappears in the active list on the next 5s poll.
  - **Bulk collection/show dismiss (T210).** Each grouped output section on the
    workflow detail page (`dashboard/app/workflows/[name]/page.tsx`) — movie franchise
    gaps grouped by collection (`MovieGapsManager` / `groupByCollection`) and missing TV
    seasons grouped by show (`MissingSeasonsManager` / `groupByShow`) — shows an
    **"✕ Ignore all"** button at each group header. After a confirm it ignores all
    currently-active items in that group via `ignoreSurfacedItems(jobName, itemKeys[])`
    in `src/db/store.ts` (a transactional batch of the per-item upsert). **CRITICAL
    semantics: this is NOT a standing rule on the collection.** Only the exact item
    keys surfaced right now are ignored; a new item key appearing in a later run (a
    4th film in the collection, a new missing season) surfaces fresh and is NOT
    auto-ignored. Do NOT persist any collection-level "ignored" flag. Backed by two
    endpoints: `POST /api/movie-gaps/ignore-bulk { tmdbIds: number[] }` (each →
    `ignoreSurfacedItem(MOVIE_GAPS_JOB, gapKey(id))`) and `POST /api/missing-seasons/ignore-bulk
    { items: { tmdbId, season }[] }` (each → `ignoreSurfacedItem(PLEX_SEASONS_JOB,
    pairKey(tmdbId, season))`), both behind the global loopback/token mutation guard.
    Client helpers: `api.ignoreMovieGapBulk(tmdbIds)` and
    `api.missingSeasonsIgnoreBulk(items)` in `dashboard/app/lib/api.ts`.
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
  a single day's run can never blow it (see `src/services/lib.ts`'s
  `DAILY_SPEND_DIVISOR`). Caps live in the job's config (or, for service-governed
  paid calls, on the service), env-overridable.
  **One governor only:** if a paid call already goes through a shared **service**
  (below), the service quota is the SINGLE source of truth — do NOT also stack a
  per-job `job_usage` cap on the same calls (it shadows the service's
  `QuotaExceededError` soft-fail and double-meters). The places paid jobs
  (`places-enrich`→`google-places`, `enrich-with-llm`→`gemini`) govern spend
  purely via their service quota; `src/services/lib.ts`'s `DAILY_SPEND_DIVISOR`
  feeds the *service* caps.
  Use the per-job `job_usage` meter only when the metered call is NOT routed
  through a service.
- **Services are a TOP-LEVEL, daemon-wide concern (`src/services/`).** A service's
  rate-limit/quota is coordinated GLOBALLY by service NAME (via the SQLite
  `service_usage` meter), so a service is NOT owned by any one workflow — it lives
  in the top-level `src/services/` folder (sibling of `src/core`/`src/workflows`),
  default-exporting a `ServiceDefinition` from `src/services/<name>.service.ts`.
  Each service is **self-contained**: it owns its limits, reading them from env
  with sensible defaults, and imports **NOTHING from any workflow's `config.ts`**.
  The `daily = monthly / 30` spend-cap math for paid daily-scheduled services lives
  with the services (`src/services/lib.ts`'s `DAILY_SPEND_DIVISOR` /
  `dailyFromMonthly`), NOT in a workflow config. The registry discovers services
  from `src/services/` (and still scans `src/workflows/` so a private job MAY colocate a
  service it owns).
- **A service's `category` is manifest-owned only — no dashboard edit UI (T305,
  mirrors workflow `category` from T292).** Like workflow `category`, a service's
  `category` is a pure grouping label (for the Services dashboard page) with NO
  `_overridden` column and NO edit endpoint: `syncService` always refreshes it from
  the manifest's `category` field on every sync (same as `description`/`paid`), so
  there is nothing for the owner to override. Controlled values: `'cli-tool'`
  (`claude-cli`), `'website-scrape'` (`fragrantica`), `'api'` (the remaining
  services — `gemini`, `github`, `google-places`, `hevy`, `lastfm`, `tmdb`,
  `trading212`, `trading212-instruments`, `dynamodb`, `openfigi`). A manifest with no `category` set defaults to
  `'uncategorized'`. The `category` column is added by `schema.sql` (fresh DBs) +
  an additive `ALTER TABLE` migration in `index.ts` (existing DBs, per the T098
  rule — no index on the new column).
- **`openfigi` service (`src/services/openfigi.service.ts`)** — free, read-only ISIN -> ticker
  symbol resolution via Bloomberg's OpenFIGI mapping API
  (https://www.openfigi.com/api/documentation), for jobs that need to turn a broker's ISIN into a
  current real-world ticker. `OPENFIGI_API_KEY` is optional (raises the free-tier rate limit).
- **Services (cross-job shared APIs).** For an external dependency called from
  multiple jobs (e.g. Gemini, Google Places, Fragrantica, Claude CLI), define a
  self-contained `ServiceDefinition` in `src/services/<name>.service.ts` and call
  the API through `callService(name, fn)` from `src/core/services.ts`. This
  coordinates rate
  limits and quotas across all job processes via the SQLite `service_usage` meter,
  and is the SOLE spend governor for those calls — a hit day/month quota throws
  `QuotaExceededError`, which the caller catches to stop the run gracefully (the
  item is left un-done and the next run resumes). See `src/services/gemini.service.ts`
  and `src/services/fragrantica.service.ts` for worked examples. The simpler per-job
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
  - **Runtime-recorded service consumers (T186).** `callService` upserts a row in
    the `service_consumers` table (`service_name`, `job_name`, `last_used` — UNIQUE on
    the pair) whenever a job calls a service, recording WHICH job used WHICH service.
    The job name is read from `process.argv[2]` (the child process entrypoint always
    receives the job name there). `GET /api/services/:name/consumers` (read-only) returns
    the consumers grouped by workflow (joined via `workflow_jobs`), powering the
    Services page's click-to-expand consumer list. The table is a brand-new schema
    addition (no T098 trap).
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
- **Validation gates between workflow stages (typed artifacts).** See
  `src/workflows/CLAUDE.md` for the short, hard-requirement statement of this rule
  (every DAG edge needs a gate; a trivial `check(): { ok: true }` is an
  acceptable minimum) — it's the one that surfaces automatically when working
  inside `src/workflows/`. This is now **mechanically enforced**:
  `src/core/gate-coverage.test.ts` walks every workflow the registry loads and
  fails `npm test` if any DAG edge is missing a matching gate. A job may
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
  contracts live in `src/workflows/places/contracts.ts` and
  `src/workflows/perfumes/contracts.ts` as small **factory functions** (each takes an
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
  `dashboard/app/components/DagFlow.tsx` renders a gate mark per gate as a React Flow edge label
  on the connecting edge between the specific producer and consumer nodes it guards (T204). The
  graph layout uses topological columns (each node's column = max(parent columns) + 1) with dagre
  computing the vertical ordering — every edge reflects the actual `dependsOn` relationship, so
  there are no false wave-barrier implications (e.g. `franchise-gaps` and `rec-merge` in
  movie-recommendations have no implied ordering). EVERY mark (passed/failed/pending alike) links
  directly to that gate's dedicated detail page
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
  - **Collapse identical producer/consumer sides to ONE panel (T138).** In this
    codebase every gate references the SAME contract factory on both sides
    (`fragranticaDataContract()` is both parse's `produces` and build's `consumes`),
    so the **Produced →** and **→ Consumed** `SideCard`s show an IDENTICAL shape +
    identical actuals — pure redundancy. Both gate detail pages therefore COLLAPSE
    to a single consolidated panel (boundary + ONE **Expected shape** + the run's
    actual ✓/✗ + sample, keeping the centre **Gate** block and the producer/consumer/
    violation log links) whenever the two sides are identical, and fall back to the
    full two-sided `Produced → | Gate | → Consumed` diff when they DIFFER. "Identical"
    is decided server-side: BOTH gate inspection endpoints return an `identical:
    boolean` computed by `shapesIdentical(a, b)` (pure, in `src/core/dag.ts`,
    unit-tested) — a deep compare of the two sides' DECLARED `shape` (`summary` +
    `format` + the `expectations` array by `label`+`detail`); a missing shape on
    either side is treated as NOT identical (never hide a side we can't confirm).
    The framework genuinely supports **asymmetric / fan-in** gates — `deriveGates`
    is edge-scoped (one gate per producer→consumer edge, so ≥2 producers feeding one
    consumer derive one gate each) and the executor's `enforceGate` checks the
    producer's `produces[key]` and the consumer's `consumes[key]` INDEPENDENTLY, so
    differing shapes both run + are enforced. The places/perfumes jobs keep the
    one-factory-per-key convention (so they always collapse); asymmetry is exercised
    only by test fixtures (`dag.test.ts`, `server.test.ts`, `workflow-executor.test.ts`).
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
    at all (purely static contract metadata). `DagFlow`'s structural gate chips take a
    `workflowName` prop to build these definition-view links; run-view chips use
    `workflowRunId` → the run-scoped page.
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
  `data/` folder next to the code (e.g. `src/workflows/places/data/{raw,out}`),
  referenced relative to the job's file — not in a far-off top-level folder.
  These are gitignored via `src/workflows/**/data/`.
- **The repo is self-contained — no absolute paths to other folders on the
  machine.** A job's config/template/resource files live in-project and are
  resolved relative to the job dir (`resolve(here, '…')`), never hardcoded to an
  external repo. Make them env-overridable where a path might legitimately vary
  (e.g. `PERFUMES_TEMPLATE_PATH` defaults to the in-project
  `src/workflows/perfumes/profile.template.md`). A bare `/Users/...` in tracked job
  code is a bug — it leaks the machine's topology and breaks on any other host.
- **Run the checks on every change** — `npm test` (the unit suite) AND
  `npx tsc --noEmit` (daemon typecheck), plus `npm run build` in `dashboard/` for UI
  changes — before declaring done. For a UI **surface** change, also run
  `node dashboard/scripts/visual-check.mjs` (after building) and LOOK at the screenshots
  (see the visual-confirmation rule below). Keep the suite green; **add unit tests for new
  behaviour as you build it** (tests live in `*.test.ts`; `npm test` discovers + runs
  them against a scratch DB). Never declare done on red.
- **Tests can NEVER touch the production DB (guarded).** `npm test` points
  `LOCALJOBS_DB` at a scratch file, but a DIRECT run (`tsx --test src/x.test.ts` or
  `tsx src/x.test.ts`) sets no such env and would otherwise fall back to
  `data/jobs.db` and pollute production — this once leaked test-fixture workflows
  (`bulk-api-wf`, `t110-wf`, …) into the live dashboard. `src/config.ts` now guards
  this: `isTestEnv()` detects any test invocation (the `LOCALJOBS_TEST=1` flag
  `run-tests.ts` sets, `NODE_TEST_CONTEXT`, a `--test` arg, or a `*.test.ts` /
  `run-tests` entry in argv) and `resolveDbPath()` refuses the production default in
  that case, redirecting to a unique per-process scratch DB (with a warning).
  `config.dbPath` goes through this. Don't bypass it — never hardcode
  `data/jobs.db` in a test, and keep new test invocations covered by `isTestEnv`.
- **Dashboard must stay mobile-responsive.** Every page has to survive a phone-width
  (~402px) viewport with no horizontal page overflow and nothing crossing an
  element's boundary. Responsive rules live in one place — the `@media (max-width:
  640px)` block in `dashboard/app/globals.css` (wide tables scroll inside their
  `.panel` via `.panel:has(> table){overflow-x:auto}`, dense grids collapse, `.kv`
  blocks stack). After any dashboard UI change, build it and run
  `node dashboard/scripts/mobile-check.mjs` (hermetic — no daemon, synthetic API
  fixtures) and keep it green. The check is local-only, not part of CI.
  ⚠️ The mobile check only exercises the DEFAULT theme/font (it sets no
  localStorage), so it guards the default look; non-default themes are
  mobile-safe by design + spot-checked manually at phone width.
- **Dashboard UI changes must get VISUAL confirmation, not just structural checks.**
  A UI element can pass `tsc`, the unit suite, the dashboard build, AND mobile-check
  yet never actually be PAINTED — the T223 gate-padlock bug shipped exactly that (an
  icon present in the DOM but invisible, because every check is structural and
  mobile-check only measures overflow on whatever rendered). So for any change to the
  dashboard's rendered surface: build it, run `node dashboard/scripts/visual-check.mjs`
  (hermetic like mobile-check — `next start` + synthetic `/api/**` fixtures, no daemon /
  SQLite / paid calls), and **LOOK at the screenshots** it writes to the gitignored
  `dashboard/scripts/visual-out/` — confirm with your own eyes the thing you changed
  renders (painted/visible, nothing blank/overlapping/clipped). It loads every page at a
  desktop viewport and waits for async/polled content (selector wait + a 1–5s settle).
  It is **vision-only** — it captures screenshots for judgment and asserts NO appearance
  invariants (NOT golden-image diffing, so no baselines / no cross-machine pixel drift);
  it fails only on a hard error (page didn't load, a wait selector never appeared, a
  console error). Local/loop-only, **not** in CI (no browser there).
  - **LIVING ARTIFACT RULE (non-negotiable).** The page list, fixtures, theme seeding,
    and **interaction flows** live in ONE place — `dashboard/scripts/_dashboard-harness.mjs`,
    shared with mobile-check. `PAGES` is one baseline shot per route; `FLOWS` adds shots of
    states that need an interaction first (a collapsed section expanded, a popover opened) —
    each a `{ name, path, actions(page) }` that drives Playwright before the screenshot. Any
    UI-surface change — adding a page, adding/removing a workflow or gate, removing UI, or
    adding an interactive state worth seeing — **MUST update that file in the SAME change** so
    future runs stay accurate and don't start failing on intentionally-removed things. Treat a
    stale `PAGES`/`FLOWS`/fixture exactly like stale docs: it's a bug, and it's part of Done. (The
    autonomous loop enforces this for `facets.layer == ui` tasks — it injects the
    look-at-the-screenshots step into both the builder and the sampled auditor, and
    auto-exempts these script files from the scope gate so keeping them current is never
    punished.)
- **Shared dashboard UI components (T268) — reuse, don't re-implement.** Common
  dashboard elements live in `dashboard/app/components/` and `dashboard/app/ui.tsx`
  (the existing shared layer: `StatusBadge`, `ThemeControls`, `StuckPopover`, etc.).
  New dashboard UI MUST reuse these instead of duplicating markup + class names:
  - **`<RunButton>`** (`dashboard/app/components/RunButton.tsx`) — the workflow run-
    trigger button wrapping `.btn.btn-run`. Props: `isRunning` (disable + show
    "Running…" when a run is active), `busy` (disable + show "Started…" while the
    click is in flight), `onClick`, `label`/`runningLabel` overrides, `className`.
  - **`<Pill>`** (`dashboard/app/components/Pill.tsx`) — any label/chip wrapping
    `.pill`. Pass `kind` for the modifier class (e.g. `kind="on"` → `className="pill
    on"`). Existing kinds in `globals.css`: `on`/`off`, `reviewed`/`unreviewed`,
    `done`, `failed`, `buildable`, `human`, `dep-waiting`, `paid`/`free`. New
    enumeration labels must use `<Pill>`, not bare `<span className="pill ...">`.
  - `DagFlow`, `WorkflowOutputSection` — existing components for the workflow DAG
    graph and unified output panel.
  - **`<CategoryTable>`** (`dashboard/app/components/CategoryTable.tsx`, T471) — the
    "one category group" wrapper for pages that group a list into labelled sections
    (`workflows/page.tsx`, `integrations/page.tsx`): owns the `.panel` wrapper, the
    `<h2>` category label, and the `<table>`/`<thead>` scaffold (with an optional
    `<colgroup>` when a column declares a `width`). Props: `label`, `columns:
    { key, label, align?, width? }[]`, optional `tableClassName`, and `children` for
    the `<tbody>` — each page still authors its own `<tr>`/`<td>` markup and
    interactivity. Stacked instances get spacing for free via the existing `.panel +
    .panel` rule in `globals.css` — don't add new spacing CSS.
  - **`renderOutputBody`/`OUTPUT_RENDERERS`** (`dashboard/app/components/OutputRenderer.tsx`,
    T458) — the SINGLE format-keyed output-artifact renderer dispatch, keyed by an output
    item's declared `WorkflowRunOutput.format` (T262/T282: `markdown` when unset). Owns the
    renderer bodies themselves: `MarkdownOutputBody` (frontmatter header + `react-markdown`
    body — the `markdown` form), `JsonOutputBody` (`JSON.parse` + `JSON.stringify(…, null, 2)`
    pretty-print inside a monospace `<pre>`, falling back to the raw content on a parse
    failure — the `json` form), and `RawOutputBody` (plain monospace, preserved whitespace —
    both the registered `text` form AND the fallback for any unrecognized format, e.g.
    `plex-space-saver`'s `size-table`). `renderOutputBody(result: WorkflowRunOutput)` is the
    entry point — call it, don't hand-roll a new dispatch. Both `WorkflowOutputSection` (the
    workflow-definition-page Output section popover) and `StageIoPanel`/`StageIoLists.tsx`
    (the workflow-RUN-page Stage I/O popover) import from here — before T458 each surface had
    its OWN copy of this dispatch, and `StageIoLists.tsx` didn't consult `format` at all
    (always forced content through `MarkdownModal`, collapsing e.g. a pretty-printed JSON
    artifact into one unbroken paragraph). Add a new form's renderer HERE, once — never
    re-duplicate a third copy of this dispatch table in a new component.
  - **`<MarkdownModal>`** (`dashboard/app/components/MarkdownModal.tsx`, extracted
    from `workflow-runs/[id]/page.tsx` in T382) — the full-markdown preview popover
    (frontmatter parsed to a compact key-value header + `react-markdown` body,
    XSS-safe). Also exports `parseFrontmatter`. This is the renderer `OutputRenderer`'s
    `markdown` form delegates to conceptually (each keeps its own small
    `MarkdownOutputBody`/`parseFrontmatter` copy since `MarkdownModal` is a full modal
    wrapper, not just a body) — do not re-implement the popover chrome per component.
  - **`<StageIoPanel>`** (`dashboard/app/components/StageIoLists.tsx`, T382 →
    T386 → T389 → T458) — the workflow-run page's ONLY Inputs & Outputs panel.
    Originally built for workflows with a genuine fan-out/fan-in shape a single
    "input → output" row can't represent honestly (see `stock-digest.workflow.ts`'s
    file comment), **T386 made it the default for EVERY workflow's run page**, not
    just `stock-digest`, and **T389 deleted the old generic joined `IoPanel`
    entirely** (component, its `workItemIoRows` store function, and the
    `GET /workflow-runs/:id/io` endpoint) — `StageIoPanel` is no longer an
    alternative to anything, it's the only mechanism. Renders one block per DAG
    member with two independent, un-paired lists (its predecessor(s)' ledger rows
    this run as Inputs, its own ledger rows this run as Outputs — the lists are
    never forced into a 1:1 join, so a genuine many-to-one or one-to-many stage
    shows every row honestly, not just a representative one), backed by
    `GET /workflow-runs/:id/stage-io` → `stageIoLists` in `src/db/store.ts`. Every
    new workflow gets this same honest, un-paired treatment automatically; there
    is no per-workflow opt-in to make.
  - **`<IgnoredSection>`** (`dashboard/app/components/IgnoredSection.tsx`, T390) —
    the "Ignored (N)" panel used by `TvRecsManager`/`MovieRecsManager`/
    `MovieGapsManager`/`MissingSeasonsManager` on `workflows/[name]/page.tsx`. Owns
    only the panel chrome (padding + heading/subtitle spacing via `.ignored-section`/
    `.ignored-section-heading`/`.ignored-section-subtitle` in `globals.css`) — props
    are `count`, `subtitle`, and `children` (each manager's own table, since the
    columns differ per manager).
  When adding a new reusable element, add it to `dashboard/app/components/` (NOT
  inline in a page) and document it here. Do NOT introduce a new styling system —
  wrap the existing `globals.css` class idiom.
- **Boxed empty-state convention (T345) — `.empty-state-panel`.** A "nothing here
  yet" message should render inside `<div className="panel"><p
  className="empty-state-panel">…</p></div>`, NOT as a bare `<p className="muted">`
  floating on the page background. `.empty-state-panel` (`globals.css`) horizontally
  AND vertically centres a short sentence within its `.panel` wrapper — reuse it for
  future empty states instead of duplicating ad-hoc centring CSS. (A related,
  IO-panel-specific class, `.io-empty-state`, predates this and is left as-is.)
- **Dashboard appearance is CSS-variable-driven + has a live theme/font switcher
  (T142 → T154 evaluation, curated down in T184).** All colours/fonts come from
  `:root` custom properties; a header **🎨** control (`ThemeControls` in
  `dashboard/app/ui.tsx`) flips persisted (localStorage) html attributes on
  `document.documentElement`. The curated set (T184) is:
  - **`data-theme` — the theme FAMILY, exactly 3:** `default` (plain), `pixel-picnic`,
    `sunny-8bit`. The switcher only picks the family.
  - **`data-mode` — the RESOLVED value is always `light` | `dark`; the user's CHOICE
    is `dark` | `light` | `system` (T344, reintroducing System on top of T308's
    binary toggle — a deliberate owner UX reversal).** The header **🎨**-successor
    control — a single compact icon button (`ThemeControls`/`useMode` in
    `dashboard/app/ui.tsx`), not a popover — CYCLES the choice Dark → Light →
    System → Dark on each click, persisted as `localjobs.mode` (the literal string
    `'dark'`/`'light'`/`'system'`; `'system'` is written explicitly, not just left
    unset). Each state has its own icon: 🌙 dark, ☀️ light, 🖥️ system. In System
    state — also the default when nothing is stored — `data-mode` follows the OS
    `prefers-color-scheme` live via a `matchMedia` change listener attached only
    while in System state; Dark/Light force a fixed `data-mode` and detach that
    listener. Each of the 3 theme families has a **light + dark palette** in
    `globals.css` (6 total). The family's BASE rule carries its DARK palette (so a
    JS-less viewer still gets a coherent theme) and a `[data-mode="light"]` rule
    overrides to light; the `default` family is the exception — its DARK palette IS
    `:root` (unchanged, the original pre-T142 dark look) and only its light override
    is defined. `data-mode` is set BEFORE first paint by the pre-paint inline script
    in `layout.tsx` (reads `localjobs.mode`; `'dark'` forces dark, `'light'` forces
    light, anything else — `'system'` or unset — follows `prefers-color-scheme`) and
    kept in sync after hydration by `useMode()`. The pure `resolveMode(stored,
    osPrefersDark)` helper in `ui.tsx` maps the stored choice → effective
    `data-mode` (`null`/`'system'` both follow the OS preference).
  - **`data-font` — exactly 3:** unset = System default, `baloo` (Baloo 2, a rounded
    face; uses a lighter `--heading-weight: 500` so headers read crisp), `spacemono`
    (Space Mono everywhere). Only **two faces are loaded** via `next/font/google` in
    `layout.tsx` (Baloo 2 + Space Mono) — no other faces are shipped.
  - **`data-motion="reduced"`** — dampens animations + hides emoji; defaults to the
    OS `prefers-reduced-motion`.
  Hard rules to preserve: the **untouched default** (default family, no attributes
  set) — and the default family's DARK mode generally — must render exactly as the
  pre-T142 dark look, so joyful accents are gated by
  `html[data-theme]:not([data-theme="default"])` and `--heading-weight` defaults to
  `700` (the original bold headings); **logs keep a fixed dark-terminal palette**
  (`--logs-*` in `:root`, never overridden by a theme or by light mode) so streaming
  logs stay legible in both modes; and display/rounded faces only ever map to
  `--font-display`/`--font-body`, never the log/mono surfaces (except the deliberate
  Space Mono everywhere). Confine theme/font/accent CSS to `globals.css`, the
  switcher+hooks to `ui.tsx`, and font loading + the pre-paint script to
  `layout.tsx`.
- **Commit + push as you go.** See the "⚠️ Commit + push as you go" section near the top
  of this file — it's a hard rule here, not a style preference, because of how
  `LOOP_AUTORESET` treats a dirty tree.
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
- **Never let `data/` folders be scanned for code, by anything.** The job registry
  (`src/workflows/registry.ts`), `tsconfig.json`, and the test runner
  (`scripts/run-tests.ts`) all now explicitly exclude any directory literally named
  `data` from their recursive walks. This was a real incident: `projects-sync`'s
  clone-and-summarize stage (T288) shallow-clones the owner's own GitHub repos into
  `src/workflows/projects-sync/data/repos/<name>/` — cloning `LocalJobs` (this very repo)
  produced a full copy of every `*.job.ts`/`*.workflow.ts` file under `src/workflows/`,
  nested inside a `data/` tree. Job/workflow lookup is by NAME not file path
  (`jobs.find(j => j.name === name)`), and `findFiles(...).sort()` orders by full
  path string — so for any workflow whose folder name sorts alphabetically AFTER
  `projects-sync` (`stocks-sync`, `tv-recs`, `workouts-sync`, and even
  `projects-sync` itself via its own nested self-clone), the STALE CLONED COPY
  silently won and shadowed the real one. Workflows have a duplicate-name guard
  (logs `is invalid — skipped: duplicate workflow name`) but jobs did not — a
  shadowed job's relative imports (`../../../db/store.js` etc.) resolve INSIDE the
  clone, so it ran against its own copy of the ENTIRE framework, including a
  separate SQLite file it created inside the clone (`data/repos/LocalJobs/data/jobs.db`).
  Symptom: workflow runs reporting "skipped (nothing to do)" or writing real output
  to the wrong path, while the real `data/out/` stayed stale or was never created.
  If you ever see a job/workflow behaving as if it's running OLD code that doesn't
  match the current source, or writing output somewhere unexpected, suspect this
  class of bug first — check for any `data/repos/`-style generated tree under
  `src/workflows/**` that a workflow might have produced, and confirm the registry
  still excludes `data/` (`src/workflows/registry.test.ts`'s sibling
  `registry-find-files.test.ts` is the hermetic regression guard for this).

## Autonomous build harness (Ralph loop)

An autonomous builder (`.harness/scripts/loop.sh`, design in `.harness/docs/HARNESS.md`) can grind through a
curated backlog one fully-verified task at a time. The whole harness lives under the hidden
`.harness/` folder, separate from project source. **When you are invoked by the loop**, obey
this in addition to everything above:

- **You work directly on `main` in this checkout** — NO worktree, NO new branches, NO push,
  NO merge. Build ONE task, commit it, and stop. The loop pushes and gates on CI.
- **The backlog is shell-owned — `status` especially.** `.harness/tracking/TASKS.json` is committed; the
  loop sets a task's `status` to `done` (via a `jq` field-scoped edit that preserves every other
  field) — **never edit `status` (or any field) of `.harness/tracking/TASKS.json` yourself.** Write your
  attempt notes to `.harness/worklog/<TASK>.md` and the result line to `.harness/worklog/.result`.
  - **The owner-authorized exceptions are the `reviewed` flag (T136), the `done` flag (T208), and
    the `failed` flag (manual-fail-signal) — all human/dashboard-owned overlay files, NOT fields in
    TASKS.json.** The loop NEVER WRITES any of them (it only writes TASKS.json `status` + the
    worklog), so the writers stay decoupled.
    - **`reviewed` (T136):** lives in `.harness/tracking/reviews.json` (`id → { reviewed, at }`). Set via
      the harness backlog dashboard (`.harness/dashboard/server.js` → `mark-reviewed.sh`), which
      atomically writes the file AND commits+pushes `[skip ci]` under the repo lock (fetch+rebase+retry;
      failed push = non-fatal warning).
    - **`done` (T208):** lives in `.harness/tracking/human-done.json` (`id → { done: true, at }`). Set via
      the harness dashboard's "Mark done" on needs-human tasks (→ `mark-done.sh`). Same atomic
      write+commit+push pattern; done implies reviewed.
    - **`failed` (manual-fail-signal):** lives in `.harness/tracking/manual-fail.json` (`id → { failed,
      reason, at }`). The owner's "this DONE task actually failed" correction. Set via the harness
      dashboard's "Mark failed" on done tasks (→ `mark-failed.sh`; reason required; `{failed:false}`
      undoes). Same atomic write+commit+push pattern. **The loop READS this overlay** (it still never
      WRITES it) to correct calibration — `policy.jq`/`pick_base` re-count the task as a failure for
      tier tuning, and `audit_gate` drops it from its cell's confirmed-audited count (built stronger +
      audited more). It ALSO reconciles it → `TASKS.json` `status=failed` (see below). Design:
      `.harness/docs/designs/manual-fail-signal.md`.
    The agent must not hand-edit any of these overlay files — they are owner actions via the harness
    dashboard. (To mark a task failed when asked, use the harness dashboard's "Mark failed" button.)
    - **Overlay → status reconcile (T261/T279, `reconcile_overlays` in `loop.sh`).** The loop NEVER
      writes the overlay files, but at PRE-FLIGHT it reads `human-done`/`manual-fail` and promotes their
      verdicts into `TASKS.json` `status`: human-done → `status=done` (so a needs-human blocker actually
      unblocks dependents — the loop keys on status, not the overlay), and manual-fail → `status=failed`
      (a terminal status the loop skips; NOT an auto-reopen). So the overlays are the owner's
      write-surface and `TASKS.json` status is the authoritative reconciled state; the dashboard still
      never touches `TASKS.json`.
- **Task `do`/`doneWhen` live in a per-task Markdown spec (T131).** A task's *what to build* and
  *bar for done* are NOT flat strings in `.harness/tracking/TASKS.json` — they live in `.harness/tasks/TNNN.md`
  with two sections, `## Do` and `## Done when`, referenced by the JSON task's `spec` field (a
  repo-relative path). **A task authored via `/implementation-harness-convert-ideas` also gets a leading `##
  Overview`** — one or two sentences of plain, human-readable language capturing the point of the
  task at a glance, before the denser `## Do`/`## Done when` detail. This is a later addition to the
  convention: existing specs written before it don't have one and are NOT backfilled — it only applies
  going forward, to newly-authored specs. TASKS.json keeps every OTHER field (`status`, `dependsOn`, `gate`,
  `model`/`effort`/`escalation`, `scope`, `tags`, `verify`, `design` — but NOT `reviewed`, which
  lives in `.harness/tracking/reviews.json` since T136). The loop's prompt
  reads the orchestration fields from JSON and appends the spec MD verbatim; the harness backlog
  dashboard (`.harness/dashboard/server.js`) inlines each spec into its Backlog view and renders it
  as markdown. **Authoring a NEW task = a JSON object with a `spec` field PLUS its
  matching `.harness/tasks/TNNN.md` (no `do`/`doneWhen` in JSON), created in the same edit.**
- **Backlog authoring: pair every "options/chooser" task with a review task (T129) — the GENERAL
  pattern for "a human must sign off on this deliverable before dependents proceed" (2026-07).**
  Whenever a backlog task builds MULTIPLE OPTIONS for the owner to choose between (toggleable styles,
  strategy variants, etc.), a PAIRED `needs-human` review task **must** also be authored that: (a)
  `dependsOn` the chooser task, (b) records the owner reviewing the options and committing to a
  choice, and (c) unblocks a follow-up that hardcodes the winner and removes the toggle + unused
  paths. Example chains: T099/T113/T116 (choosers) → T126/T127/T128 (review tasks). Never author
  a chooser task alone; always add the paired review task in the same backlog edit. **This is also
  the correct pattern for ANY task whose deliverable needs a human sign-off before dependents run**
  — e.g. a risky deletion of shared framework code. There used to be a THIRD `gate` value,
  `"gate"`, meant to express "the loop builds this unsupervised, then a human reviews it before
  dependents proceed" directly on the task itself — it was **removed** (T389/T405 migration) once
  it turned out `loop.sh`'s task-selection treats any non-null `gate` identically (never selects
  it), so a `gate:"gate"` task could never be built OR marked done — a dead end, not just a
  redundant concept. `gate` is now strictly binary: `null` (buildable) or `"needs-human"` (a human
  must do the work). Express "review this after it's built" the same way as a chooser: author a
  separate `gate:"needs-human"` task depending on the built task, and point real successors at the
  review task instead of the original.
- **Backlog authoring → invoke the `ralph-loop-add-to-backlog` skill (see `.harness/CLAUDE.md`).**
  Adding tasks goes through that skill (it assigns facets, pairs chooser/review tasks, runs the
  poor-fit/layer gate). Floor even on a direct `TASKS.json` edit: every BUILDABLE task carries
  `facets` from `.harness/config/facets.json` (`needs-human` tasks omit them); the loop pre-flight warns
  about misses. Full rule lives in `.harness/CLAUDE.md` (loaded when you work in `.harness/`).
- **Definition of Done mirrors CI** (`.harness/docs/HARNESS.md` §5): `npx tsc --noEmit`, `npm test`, and
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
