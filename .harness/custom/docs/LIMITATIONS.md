# custom/docs/LIMITATIONS.md — this project's trade-offs & limitations log

Customization overlay for `.harness/docs/LIMITATIONS.md`. **This is where your project's own
limitation/trade-off rows go** (golden rule 5): when a change introduces a trade-off, bottleneck, or known
limitation, add a row **here** — not in the pristine `docs/LIMITATIONS.md`, which is plugin-owned and
refreshed on upgrade. Harness upgrades never touch this file. (See `.harness/custom/CLAUDE.md`.)

Each row: what it is, *why* it was chosen, its **impact**, and *when to revisit*.

<!-- Add your project-specific limitation rows here. -->

---

## Harness

- **Works in-place on `main`, with no worktree isolation.**
  *Why:* the loop verifies against real local data. Each workflow's `data/` folder, `.env` and the
  SQLite database are untracked and exist only in this checkout. A clean worktree off
  `origin/main` has the code but none of that. Git revert is also a simpler safety net than
  worktree quarantine.
  *Impact:* an interrupted task can leave the working tree dirty. Do not hand-edit or commit to the
  repo while the loop runs. Safety is: sequential, a lock, the local Definition of Done before
  each commit, stop on red CI, and a one-line `git revert`.
  *Revisit:* if the loop stops needing local `data/` to verify (fixtures checked in, or data kept
  outside the tree), the worktree variant becomes viable.

- **Autonomous `git push` to a public `main`.**
  *Why:* the loop integrates by pushing; there's no human in the loop to click merge.
  *Impact:* a bad/secret-leaking commit could in principle reach GitHub.
  *Mitigation / revisit:* the pre-push guard (HARNESS.md §4) halts on any sensitive path; CI-red
  stops the loop. Tighten the guard's regex if new sensitive paths appear.

- **CI-green-after-push, stop-on-red (not gate-before-merge).**
  *Why:* CI can only run on pushed commits, and the local DoD mirrors CI, so red is rare.
  *Impact:* `main` can be briefly red until a human reverts.
  *Revisit:* if red happens often, move to a push-to-branch → ff-main gate.

- **No live paid-API calls in verification.**
  *Why:* Google Places / Gemini are metered with monthly caps we must not blow.
  *Impact:* job logic is verified against fixtures / already-fetched local data, not a fresh live
  call — a live-only regression could slip past.
  *Revisit:* add an opt-in smoke test behind a manual flag. Paid calls already go through
  `callService`, whose service quota enforces the monthly cap, so such a test cannot overspend.

- **`--dangerously-skip-permissions` removes per-action guardrails.**
  *Why:* a headless loop has no human to answer prompts.
  *Impact:* no per-action confirmation; the pre-push guard, CI gate, and reviewable per-task commits
  are the backstop.

- **The harness pushes its own backlog status commits to `main`.**
  *Why:* `.harness/tracking/TASKS.json` is committed and the shell flips `status` to `done` after green CI.
  *Impact:* one extra tiny `[skip ci]` commit per completed task in history.
  *Revisit:* squash/clean up if the noise ever bothers you.

- **Engine and service tests spawn real child processes and use real (short) sleeps.**
  *Why:* the executor spawns each stage as a child process, and `callService` has no injectable
  clock. So the executor tests point `config.runJobScript` at a fake script that emits NDJSON, the
  scenario tests under `src/engine/scenarios/` run made-up stages through the production child
  runtime, and the throttle tests bound their waits with a small or negative `maxWaitMs` instead of
  mocking timers.
  *Impact:* the suite is slower than a mocked one (process spawns, plus a min-interval spacing
  test that really waits about two seconds), and the scheduler and throttle tests are mildly
  timing-sensitive. Generous margins keep them stable.
  *Revisit:* inject a clock and a `spawn` factory if these ever flake or the suite gets too slow.

- **Task do/doneWhen split across two files (JSON + per-task MD).** (T131)
  *Why:* Markdown specs (`.harness/tasks/TNNN.md`) say far more than a flat JSON string and render
  cleanly on the backlog dashboard. Orchestration fields stay in `TASKS.json`.
  *Impact:* a new task is two coupled files: a JSON object with a `spec` path, plus its MD. A
  missing or renamed spec file leaves the task with an empty body. The loop prompt prints a
  warning and the backlog dashboard shows no spec. The two can drift if edited carelessly.
  *Revisit:* if drift becomes a problem, add a backlog linter asserting every task has a readable
  spec with both sections.

- **Owner marks (reviewed / done / failed) are written by shell scripts under the loop's repo lock.** (T136)
  *Why:* the marks live in owner-owned overlay files under `.harness/tracking/` (`reviews.json`,
  `human-done.json`, `manual-fail.json`). The loop never writes them, so the two writers cannot
  clobber each other and merges are always clean. The harness dashboard
  (`.harness/dashboard/server.js`, port 4791) runs `.harness/scripts/mark-*.sh`, which write the
  file, commit it and push it while holding the same mkdir lock as `loop.sh`. Both take the lock
  path from one place, `.harness/scripts/repo-lock.sh`. The product daemon and its API no longer
  write any of this.
  *Impact:* (a) the push is best-effort: three tries with a fetch and rebase between them. If all
  three fail the commit stays local, the script says so, and it goes out with the next successful
  push. (b) The scripts refuse to run unless the checkout is on the main branch. (c) `loop.sh`
  takes the lock once and holds it until it exits, and a mark waits for it. The dashboard gives
  the script 30 seconds, so a click while the loop is running comes back as an error and has to
  be repeated once the loop has stopped.
  *Revisit:* if marking during a loop run matters, the loop would have to release the lock between
  tasks. That is plugin-owned script logic: raise it upstream, do not edit the script here.

- **Escalation ladder shrunk 5→3 rungs (2026-07-13).** *What:* the global tier ladder
  (`.harness/config/facets.json` `.tiers.ladder`) went from
  `[haiku/null, sonnet-5/low, sonnet-5/medium, sonnet-5/high, opus-4-8/high]` to
  `[haiku/null, sonnet-5/medium, opus-4-8/medium]` — removed sonnet-5 low + high, kept
  sonnet-5 medium, and lowered the top Opus rung high→medium. *Why:* fail faster / waste fewer
  build+audit cycles — with `MAX_ATTEMPTS=2`/rung a task now caps at 6 attempts before blocking
  (was 10), and there's no cheap sonnet-low warm-up rung. *Impact:* (1) coarser escalation — a
  task jumps sonnet-medium straight to opus-medium with no sonnet-high step between, and every
  non-Haiku task now starts at sonnet-medium (pricier per attempt than the old sonnet-low). (2)
  Calibration was preserved by a band-collapse ledger migration (all sonnet-5 low/high history
  folded into sonnet-medium, opus-high into opus-medium — verified 0/334 outcomes rows dropped
  under the new ladder vs 308 pre-migration), so no cell cold-starts; but cells once calibrated
  to sonnet-low now start at sonnet-medium (slightly over-provisioned) and cells that needed
  sonnet-high now under-provision at sonnet-medium and escalate to opus-medium. *Revisit:* if
  tasks that used to pass cheaply at sonnet-low routinely waste an opus-medium escalation (watch
  the ledgers' finalEffort distribution drifting toward opus), consider reintroducing a cheaper
  sonnet rung or a sonnet-high step — `implementation-harness-update-ladder` does the insert +
  calibration migration.

---

## Project

- **Publishing the perfumes pipeline exposes Fragrantica-scraping code.**
  *Why:* the owner chose to make all job code public to unblock the harness.
  *Impact:* the repo publicly documents Cloudflare-clearance / scraping technique against
  Fragrantica, whose site ToS disallows automated access. Data (incl. the browser profile) stays
  private.
  *Revisit:* if Fragrantica objects or ToS posture changes, re-privatise `src/workflows/perfumes`.

- **Fragrantica-vs-LLM confidence weighting is prompt-enforced, not post-checked.**
  `perfumes-build` computes a continuous sample-size confidence weight
  `votes/(votes+k)` (k = corpus-median votes) and feeds the blend + an explicit
  "state this in the profile" directive into the build prompt
  (`confidenceClause` in `src/workflows/perfumes/stages/build.ts`). The math, calibration,
  and clause wording are unit-tested against low- and high-sample fixtures, but
  the *actual* blend in the written markdown depends on the LLM honouring the
  directive — there's no post-build validator that re-reads the profile and
  asserts the stated confidence matches the votes (that would need either a live
  build or a parser over the generated prose).
  *Revisit:* add a cheap post-build check that the Community Sentiment section
  contains the expected "Community-signal confidence: NN%" line and that NN
  tracks the vote count, failing the run loud if the LLM dropped it.

- **Confidence calibration is a snapshot of the currently-scraped corpus.** `k`
  is the median vote count over whatever `data/out/fragrantica/*.json` exists at
  build time, so the same perfume can get a slightly different weight as the
  library grows and the median shifts. This is intended (high vs low is relative
  to *this* ecosystem), but it means a profile's stated confidence isn't stable
  across re-runs spanning corpus changes. Pin `PERFUMES_CONFIDENCE_K` for a fixed
  reference point if that matters.

- **Service migration leaves `job_usage` rows behind; backfill is month-scoped.**
  T013 removed the per-job `recordUsage`/`capStatus` from `places-enrich` and
  `enrich-with-llm` so the shared service quota (`google-places`, `gemini`) is the
  sole governor. `scripts/backfill-service-usage.ts` tops up `service_usage` from
  the legacy `job_usage` for **this calendar month only** (the window the live caps
  actually care about) and is idempotent (adds `max(0, job − service)`). It does
  NOT reconcile prior months, and the stale `job_usage` rows are left in place
  (harmless — nothing reads them for these jobs anymore). It was run once in-place;
  re-running is a safe no-op.
  *Side effect:* with the per-job cap gone, a `dryRun` pass of `enrich-with-llm`
  no longer increments any meter (it bypasses `callService`), so dry runs are now
  entirely unmetered — fine, since they cost nothing.
  *Revisit:* if cross-month accuracy ever matters, extend the backfill to walk
  per-month buckets instead of just the current month.

- **Orphaned ledger prune is manual and full-scan, not incremental.** T014 added
  a manual prune (`POST /api/jobs/:name/prune`, `pruneOrphanedWorkItems` in
  `src/db/store/workItems.ts`) that removes `work_items` whose `item_key` is no longer in a job's
  current input set. It is deliberately **never automatic** — a scheduled run that
  transiently sees a truncated/empty input could otherwise wipe a valid ledger, so
  the human pulls the trigger. Trade-offs: (a) the job must expose `inputKeys()`
  *or* the caller passes an explicit `{ keys: [...] }`; jobs without either can't
  be pruned through `inputKeys()`. (b) An empty current set would orphan every row,
  so the API refuses it unless `{ force: true }`. (c) It scans the job's full
  `work_items` set in memory to diff against the key set — fine at the current
  scale (thousands of rows), not built for millions.
  *Revisit:* if a job legitimately needs auto-prune, add an opt-in guard (min-size
  / change-ratio sanity check) rather than running it on every schedule.

- **Workflow progress counts finished stages only, and it is not monotonic under `repeatUntilStable`.**
  *Why:* `rollUpWorkflowProgress` (`src/db/store/workflows.ts`) takes the latest run of each member
  stage in the workflow run and counts the ones in a terminal state, over the member count in
  `workflow_jobs`. A running stage counts as zero whatever its own progress says, so the bar moves
  in steps of 100/N.
  *Impact:* (a) a long stage shows no movement on the workflow bar until it ends. Its own run page
  has the live percentage. (b) Under `repeatUntilStable` each cycle starts new member runs, so the
  bar drops by one step each time a stage starts again and otherwise sits near 100% through the
  later cycles. (c) The denominator is the current `workflow_jobs` count. If a workflow were
  re-synced with a different member set during a run the percentage would shift. Syncs happen at
  daemon start, so this does not occur in practice. (d) `setProgress` re-runs the per-member query
  on every progress event of every member. That is fine at this scale and not built for hundreds
  of chatty stages.
  *Revisit:* clamp to the highest value seen in a cycle if the dips bother. Persist a
  `total_stages` snapshot on the workflow run if membership can ever change mid-run.

- **Editable service limits are all-or-nothing per service, with no one-click reset.**
  *Why:* the Integrations page edits a service's `rate_per_minute`, `daily_cap`, `monthly_cap` and
  `timeout_ms` together (`POST /api/services/:name/limits`, `updateServiceLimits` in
  `src/db/store/services.ts`). The first edit sets `limits_overridden = 1`, and from then on a
  code-sync keeps the user's values for all four.
  *Impact:* (a) there is no "revert to code default" control. Once overridden, the row stops
  tracking code changes to any of the four. To go back you type the code values in by hand, or
  clear `limits_overridden` in the DB. The weekly `overrides-audit` workflow reports overrides
  that are two weeks old or more as a reminder, and changes nothing. (b) `minIntervalMs` and
  `maxJitterMs` stay code-only. (c) The override is keyed by service name, so it is one global
  value. There is no per-job override of a shared service's limit, by design: a service is one
  governor across jobs.
  *Revisit:* if reverting becomes common, add a `DELETE /api/services/:name/limits` that clears the
  flag and re-seeds from the registered definition.

- **Remote dashboard proxies the API as a loopback caller → tailnet membership
  IS the auth.** T024 made the dashboard reachable over a Tailscale tailnet via
  `tailscale serve`, with the browser talking only to the dashboard origin and the
  dashboard server proxying `/api/*` to the loopback daemon API
  (`dashboard/next.config.js` `beforeFiles` rewrite → `127.0.0.1:4789`). *Why:* it
  keeps the API bound to `127.0.0.1` and never exposed — the only thing on the
  tailnet is the dashboard. *Impact:* because the proxy hop originates from
  loopback, the daemon sees a loopback caller, so the T023 **mutation token guard
  does not apply to requests that arrive via the dashboard proxy** — anyone who can
  reach the dashboard (i.e. any device on the tailnet, or anyone local) can trigger
  runs/toggles. The security boundary is therefore the **tailnet ACL**, not a
  per-request token. This is acceptable only while (a) `tailscale serve` is used,
  **never `tailscale funnel`** (Funnel = public internet), and (b) the tailnet is
  trusted. The T023 guards (loopback bind, CORS allowlist, token-for-non-loopback)
  still protect the API against any *directly*-exposed path; they just don't gate
  the proxied path. *Revisit:* if the tailnet is shared with untrusted devices, add
  an auth layer in front of the dashboard itself (e.g. Tailscale identity headers
  via `tailscale serve`, or a dashboard-level token) rather than relying on tailnet
  membership alone.

- **Most artifact checks are coarse: shape and non-emptiness, often on a sample.**
  *Why:* the checks in `src/workflows/{places,perfumes}/contracts.ts` exist to catch a real change
  in an external format (a reshaped Fragrantica page, a changed Takeout CSV layout) cheaply. So
  `resolved-place-ids` and `enriched-places` pass when at least one entry has a real `place_id`,
  and the parsed-perfume check looks at one representative record. A few cheap properties are
  checked on every item (every place has a name, no captured page is empty, every profile starts
  with frontmatter).
  *Impact:* a corpus where most items are well-formed but a minority drifted can still pass. Those
  items are handled one by one through the `work_items` ledger and retries, not by the check. The
  check means "the upstream format did not break and something usable came out". It is
  deliberately not a full validation of every row, which would be brittle and would block the
  whole next stage on one bad item.
  *Revisit:* if silent per-item drift becomes a problem, add a stricter check that samples N
  records or asserts a minimum well-formed fraction.

- **The pipeline→workflow rename is a clean break with a one-way DB migration.**
  *Why:* T038 renamed the "pipeline" concept to "workflow" everywhere (types, DB
  tables `pipeline_*`→`workflow_*`, the `*.pipeline.ts` discovery glob, the
  `pipeline-executor`, the `/api/pipelines` + `/pipeline-runs` routes and dashboard
  pages, and all docs). No old-name redirects/aliases were kept, per the task.
  *Impact:* (a) any external bookmark or integration hitting `/api/pipelines`,
  `/pipeline-runs`, or `/pipelines` 404s — they're now `/api/workflows`,
  `/workflow-runs`, `/workflows`. (b) The DB migration (`migrateWorkflowRename` in
  `src/db/index.ts`, run before schema bootstrap) renames the legacy tables/columns
  in place and is idempotent + lossless, but is **one-way** — there's no
  down-migration back to `pipeline_*`. It relies on SQLite ≥ 3.25 `ALTER TABLE …
  RENAME COLUMN` (better-sqlite3 bundles 3.49) and on `foreign_keys = ON` so child
  FK references are rewritten automatically. *Revisit:* the migration block can be
  deleted once every live DB is known to be on the `workflow_*` schema (it's a
  no-op from then on).

- **The mobile styling check is hermetic + local, not wired into CI.** *Why:*
  T040 added `dashboard/scripts/mobile-check.mjs`, which boots a real `next start`
  and drives a headless Chromium — too heavy/flaky for the CI Definition-of-Done
  (which stays `tsc` + `npm test` + dashboard build). It also serves all `/api/*`
  from **synthetic in-process fixtures** via Playwright route interception rather
  than a seeded scratch SQLite + live daemon, so it never touches the DB or makes
  paid calls. *Impact:* (a) a responsive regression won't be caught automatically
  on push — you must run the check by hand after a dashboard UI change (it's
  documented in `CLAUDE.md` + `README.md` as part of Done). (b) the fixtures are a
  hand-maintained approximation of the API shapes in `dashboard/app/lib/api.ts`;
  if an endpoint's response shape changes, update the fixtures too or the page may
  render empty and silently pass. (c) it depends on Playwright's Chromium being
  installed locally (`npx playwright install chromium`). *Revisit:* if responsive
  regressions recur, promote it to a CI job with a cached browser.

- **Accord percentages backfill only on RE-FETCH, not retroactively.** *Why:*
  T072 fixed `perfumes-fetch` to persist the raw page HTML (the success path used
  to save only innerText `.txt`, so the parser's `pages/<id>.html` never existed
  and every accord `pct` fell back to `null`). The parser was already correct —
  verified end-to-end against a live fetch of Amouage Beach Hut Man, where it lifts
  the real bar-width %s exactly. *Impact:* the ~42 perfume outputs built before
  this fix still carry `pct: null`; they only gain real percentages when their page
  is re-fetched (the fetch ledger must re-run that item) and re-parsed. Nothing
  auto-invalidates the old `.txt`-only captures. *Revisit:* to backfill, clear the
  `perfumes-fetch` work-items (or delete the stale `pages/*.txt`) so a run re-fetches
  and now also saves `.html`, then let `perfumes-parse` re-run.

- **Workflow-run cancellation is process-local and the DB transition is async.**
  *Why:* T091 added `POST /api/workflow-runs/:id/cancel` backed by an in-memory
  `workflowRunId → AbortController` registry in `workflow-executor.ts`. A run can
  therefore only be cancelled while it is executing in THIS daemon process — a run
  orphaned by a daemon restart isn't in the registry (cancel returns a 409), but
  startup already reaps such runs to `cancelled` anyway, so there's nothing live to
  stop. *Impact:* the API returns `{ ok: true }` the instant `abort()` is signalled;
  the `cancelled` row(s) are written slightly later, when the executor observes the
  abort, drains the hard-killed in-flight child, and finalises the run (keeping the
  executor the sole DB writer). So a poll immediately after cancel may still briefly
  show `running`. *Revisit:* if a synchronous guarantee is needed, have the API await
  the run reaching a terminal state before responding.

- **The hermetic dashboard checks run in one colour mode only.**
  *Why:* `mobile-check.mjs` and `visual-check.mjs` load each page in a fresh browser context with
  no stored `localjobs.mode`, so the page follows the headless browser's `prefers-color-scheme`.
  The shared harness (`dashboard/scripts/_dashboard-harness.mjs`) has a `seedTheme(ctx, { mode })`
  helper, but neither check calls it.
  *Impact:* a change that breaks only the other mode (contrast, a colour that is not a CSS
  variable) is neither caught nor screenshotted. The theme and font themselves are fixed (one
  theme, Baloo 2), so mode is the only appearance setting left to vary.
  *Revisit:* run the page list twice, once per mode, using `seedTheme`.

- **Stat-tile "count-up" is a CSS entrance pop, not a number that counts up.**
  *Why:* a real count-up needs JS that owns the number in `dashboard/app/page.tsx`. The tiles get a
  one-shot scale-in instead (`joy-pop` on `.statcard .n` in `globals.css`).
  *Impact:* the numbers pop in at their final value. They do not tick up from 0.
  *Revisit:* add a small `<CountUp>` component if a real count-up is wanted.

- **The franchise-gap audit makes two TMDB passes per run, and the first grows with the library.**
  *Why:* `franchise-gaps` (in the `missing-movies` workflow) has to read each owned film's
  `belongs_to_collection` with `GET /movie/{id}` (one call per owned movie, about 1,500 on the
  owner's library), then fetch each distinct collection's `parts[]` once. Nothing is kept between
  runs: the stage recomputes everything each week.
  *Impact:* TMDB is free and paced by the `tmdb` service. The service's response cache (about 22
  hours) absorbs a retry or a same-day re-run, but each weekly run starts cold. A much larger
  library lengthens the run. The stage's 30 minute `timeoutMs` and its graceful stop on
  `QuotaExceededError` bound it.
  *Revisit:* keep each film's collection id between runs if the run time becomes a problem.

## Workflow engine

- **The "one active run per workflow" guard is in-process (single-daemon), not DB-locking (T105).**
  *Why:* the authoritative guard is a synchronous check-and-claim in `runWorkflow` (an in-process
  `startingWorkflows` Set) combined with the DB's `status='running'` check — race-safe because the
  daemon is the single writer/scheduler and Node is single-threaded. There is no SQL-level unique
  constraint forbidding two `running` rows for one workflow.
  *Impact:* correct for this architecture (ONE daemon owns all scheduling + manual runs). If the
  framework ever ran TWO daemon processes against the same DB, two near-simultaneous starts could
  each pass their own in-process claim and both create a `running` row. The API's 409 likewise relies
  on the same single-process guard.
  *Revisit:* only if multi-daemon is ever introduced — then the claim would need to move into the DB
  (e.g. a conditional `INSERT … WHERE NOT EXISTS (running row)` or a unique partial index on
  `workflow_name WHERE status='running'`).

- **`repeatUntilStable` no-forward-progress stop is heuristic, not a true fixpoint (T112).**
  *Why:* the loop stops early when a whole cycle leaves the member work-item ledger signature
  unchanged (row count + summed attempts) AND the retryable count didn't drop (`noForwardProgress`).
  This robustly kills the perpetual-cycling case (a genuinely-unfindable input frozen below
  `maxAttempts`, counted retryable every cycle yet never re-attempting) without depending on WHY a
  given stage failed to advance it.
  *Impact:* a cycle that legitimately makes NO ledger change but WOULD progress on a later cycle —
  e.g. an external dependency that's momentarily unavailable and a job that neither increments
  attempts nor records anything that pass — is treated as "no progress" and the run stops early
  (resumes fine on the next scheduled/manual run, since idempotency means outstanding work is
  retried). Jobs SHOULD advance the ledger (increment attempts / mark failed) on every real
  attempt; a job that swallows a transient failure without touching the ledger can be stopped one
  cycle sooner than strictly necessary.
  *Revisit:* if a workflow needs in-run retry across a transient outage, give the stop condition a
  small grace (e.g. stop only after K consecutive no-progress cycles) rather than the immediate
  single-cycle break.

- **The daemon verifies each stage's inputs itself, synchronously and with no time limit.**
  *Why:* an artifact's `check(value)` runs in the producing stage's own process when it commits the
  output, so it is inside that stage's timeout. What is left in the daemon is `resolveInput`
  (`src/engine/resolve-inputs.ts`): before a stage is spawned it looks up what the producer
  committed in this run and compares it with the disk. For a file that is one `stat`, plus a full
  SHA-256 only when the size or mtime differs from what was recorded. For a directory artifact it
  is a `readdir` and one `stat` per file (`dirStats` in `src/engine/hash.ts`).
  *Impact:* these are synchronous calls in the daemon process, so nothing else in the daemon runs
  until they return: no scheduling, no API responses. A directory artifact with tens of thousands
  of files, or a large file that has to be hashed, is where that would show. A directory is
  fingerprinted by each file's name, size and mtime, not its content, and only files directly
  inside it count, so a change in a nested folder is not noticed.
  *Revisit:* if a stage boundary ever shows up as a pause (`gate_ms` on the member run records
  the time spent), make the comparison async or move it to a worker.

- **"Every stage declares ports" is enforced by the registry, not by the engine.**
  *Why:* the engine still runs a stage that declares no inputs or outputs. Its own tests
  (`workflow-executor.test.ts`, `engine-hardening.test.ts`) use such stages to exercise scheduling,
  retries and cancelling with no data flowing. The rule that a real workflow must be on ports is
  in `src/workflows/registry.ts`, which refuses to load one that is not.
  *Impact:* anything that runs a workflow without going through the registry (a test host, a
  second entry point one day) gets no ports guarantee: a stage without ports runs with no inputs
  resolved and no outputs verified, and a resume of such a workflow reuses nothing.
  *Revisit:* move the check into `validateWorkflowContracts` (`src/engine/ports.ts`) once the
  engine's own tests use fixture stages with ports.

- **Most item-loop stages still write their loop by hand.**
  *Why:* `eachItem` (`src/engine/items.ts`) arrived with the ports rebuild and only the four
  perfumes stages were moved onto it. Close to thirty other files under `src/workflows/` still
  call `markWorkItem` directly, the places stages among them, and no shipped workflow uses
  `snapshotLedger` yet.
  *Impact:* each hand-written loop has to get the same things right on its own: skip done items,
  filter by `ctx.rootAllowed`, count attempts, report `i/N` progress, stop politely at a quota,
  save before marking, and throw at the end if any item failed. A stage that misses the last one
  reports success with failed items and lets the next stage run.
  *Revisit:* move a stage onto `eachItem` the next time its loop is touched.

- **`after` only delays a run, and it gives up after three hours.**
  *Why:* `waitForWorkflows` (`src/engine/workflow-executor.ts`) polls every
  `LOCALJOBS_AFTER_POLL_MS` (15s) while any workflow named in `after` has a run in progress. It is
  a guard against reading half-rebuilt output. It is not a trigger and not a dependency.
  *Impact:* (a) after `LOCALJOBS_AFTER_MAX_WAIT_MS` (3 hours) it logs a warning and starts, so a
  run behind a very long upstream run can still read output that is part-way rebuilt. (b) It does
  not look at how the other run ended: a failed or cancelled upstream run releases the wait just
  the same. (c) It starts nothing. The workflow still runs on its own schedule, and if the
  upstream did not run at all it reads whatever was already there. (d) Only the start is guarded.
  An upstream run that begins after this one has started is not waited for.
  *Revisit:* if a consumer must never read a failed or partial upstream, have it check the
  upstream's last run itself, or add a real cross-workflow trigger.

- **Resume is not offered for a `repeatUntilStable` workflow.**
  *Why:* `POST /api/workflow-runs/:id/resume` answers 400 for one (`src/api/server.ts`). Its cycles
  run every stage again and each stage skips the items the ledger says are done, so a fresh run
  already picks up where the failed one stopped.
  *Impact:* for `perfumes` (the only shipped workflow with `repeatUntilStable: true`) a failed run
  is continued by starting a new one. Every stage starts again and relies on its ledger to skip
  finished items. No stage's committed output is reused.
  *Revisit:* only if a cycling workflow gains an expensive stage that the ledger does not let it skip.

- **A run's Inputs & Outputs detail is deleted after 90 days.**
  *Why:* `work_item_runs`, `run_artifacts` and `run_inputs` gain rows on every run with no natural
  bound, so a daily sweep (`src/engine/retention.ts`) removes them for runs older than
  `LOCALJOBS_RUN_HISTORY_KEEP_DAYS` (90). It always keeps each workflow's latest
  `LOCALJOBS_RUN_HISTORY_KEEP_RUNS` (20) runs.
  *Impact:* an old run keeps its status, stages, timings and logs, but its Inputs & Outputs lists
  are gone. Its gates fall back to being inferred from the member runs: `classifyGates`
  (`src/engine/dag.ts`) marks a gate failed when the consumer's error text contains
  `gateFailurePrefix(gate)`, so that string format and the classifier have to stay in step. Runs
  recorded before the ports migration get the same fallback, since they have no `run_inputs` rows.
  *Revisit:* raise the two settings if older runs need their detail.

## Workflow run-limits (T094)

- **A limited run never picks an item that is stuck, ignored or paused at a quota.**
  *Why:* `isRootPending` (`src/db/store/workItems.ts`) treats a root as finished for selection
  when it has no retryable row and carries a "gave up" marker at any stage: an `ignored` row, a
  `skipped` row (a quota soft stop), or a `failed` row past its retry budget. Without that rule
  the selector would pick the same unprogressable root on every limited run.
  *Impact:* `{ "limit": N }` cannot be used to retry a stuck item, or to finish the items a quota
  stopped the night before. If every candidate is in one of those states the run selects nothing
  and logs a warning that says so.
  *Revisit:* unstick the item first, or run the workflow unlimited (an unlimited run still retries
  `skipped` items). Change the rule only if limited catch-up runs after a quota stop become a
  regular need.

- **Stages before the root stage do their full work under a limit.**
  *Why:* they establish the set of roots; they do not consume it. `places-ingest` parses every
  Takeout CSV into `places.json` whatever the limit is. Only the ledger rows it records are
  filtered to the selected roots (`ctx.rootAllowed`). The limit bounds the work from the root stage
  (`cid-to-place-id-resolver`) onward.
  *Impact:* a limited places run still does the whole (cheap, idempotent) ingest each time. Only
  resolve, enrich and the LLM stage are bounded to N CIDs. This is intended.
  *Revisit:* only if a stage before the root ever becomes expensive. It would then need its own
  bound.

- **A limited run of `plex-language-fix` walks the whole Plex library twice, the first time inside the daemon.**
  *Why:* a limited run picks its roots from the root stage's `inputKeys()`, which the daemon calls
  before any stage starts (`runWorkflowInner` in `src/engine/workflow-executor.ts`). For this
  workflow that is `discoverInputKeys`, a live walk of every library section through the `plex`
  service. It reads Plex live because the earlier ledger read-back returned nothing after "Clear
  output data", and a limited run then selected no roots. The discover stage then walks the
  library again.
  *Impact:* with nothing cached the walk is about 30,000 Plex calls at the service's 300 a minute,
  roughly 100 minutes, before the first stage is spawned. The run shows as `running` for all of
  it, so `scripts/safe-restart.sh` refuses to restart the daemon. Cancelling does not interrupt
  the walk: the abort is only acted on once `inputKeys()` returns. The stage's own walk afterwards
  is mostly served from the cache the first one filled.
  *Revisit:* select the roots after the discover stage has run, from what it recorded, or give
  `inputKeys()` an abort signal and a cheaper listing.

- **`settles` is judged on the ledger as it stood before the limited run started.**
  *Why:* root selection happens once, in the daemon, before any stage runs. `rootIsSettled`
  (`src/db/store/workItems.ts`) reads the existing successful row of each stage that declares
  `settles` and asks `settles(detail)` about that recorded detail.
  *Impact:* an item whose settled verdict is out of date (the stage would decide differently
  today) still counts as finished and is not picked, because nothing re-evaluates it before the
  choice is made. A limited run cannot be used to make a stage reconsider such an item. A row
  whose detail does not parse, or a `settles` that throws, counts as not settled, which costs a
  wasted pick but hides no work.
  *Revisit:* if this bites, re-check settled items at selection time, or add a control that
  clears one stage's row for one item.
