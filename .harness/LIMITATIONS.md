# LIMITATIONS.md — trade-offs, bottlenecks & known limitations

The single place to evaluate the design's compromises later **without re-deriving them from the
code**. Per `CLAUDE.md`, every change that introduces or reveals a trade-off, bottleneck, or known
limitation **adds a row here in the same commit**.

Each entry: **what** it is · **why** we chose it · **impact** · **when to revisit**.

---

## Harness

- **Works in-place on `main` — no worktree isolation.**
  *Why:* the real jobs + data live untracked in this checkout (a clean worktree couldn't see them),
  and git revert is a simpler safety net than worktree quarantine.
  *Impact:* an interrupted task can leave the working tree dirty; don't hand-edit or commit to the
  repo while the loop runs. Safety = sequential + lock + local-DoD-before-commit + CI-red-stops +
  one-line `git revert`.
  *Revisit:* if the repo goes fully public and data moves out of the tree, the worktree variant
  becomes viable again.

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
  *Revisit:* add an opt-in, cap-aware smoke test (using the existing `recordUsage`/`capStatus`
  meters) gated behind a manual flag.

- **`--dangerously-skip-permissions` removes per-action guardrails.**
  *Why:* a headless loop has no human to answer prompts.
  *Impact:* no per-action confirmation; the pre-push guard, CI gate, and reviewable per-task commits
  are the backstop.

- **The harness pushes its own backlog status commits to `main`.**
  *Why:* `.harness/TASKS.json` is committed and the shell flips `status` to `done` after green CI.
  *Impact:* one extra tiny `[skip ci]` commit per completed task in history.
  *Revisit:* squash/clean up if the noise ever bothers you.

- **Core unit tests spawn real child processes and use real (short) sleeps.**
  *Why:* the executor/pipeline spawn `runJob` as a child and `callService` has no injectable clock
  or `spawn` seam, so tests point `config.runJobScript` at a fake NDJSON-emitting script and bound
  throttle waits with small/negative `maxWaitMs` rather than mocking timers.
  *Impact:* the suite is a few seconds slower (process spawns + a ~2-3s min-interval spacing test)
  and the scheduler/throttle tests are mildly timing-sensitive (generous margins keep them stable).
  *Revisit:* inject a clock + a `spawn` factory if these ever flake or the suite gets too slow.

---

## Project

- **Publishing the perfumes pipeline exposes Fragrantica-scraping code.**
  *Why:* the owner chose to make all job code public to unblock the harness.
  *Impact:* the repo publicly documents Cloudflare-clearance / scraping technique against
  Fragrantica, whose site ToS disallows automated access. Data (incl. the browser profile) stays
  private.
  *Revisit:* if Fragrantica objects or ToS posture changes, re-privatise `src/jobs/perfumes`.

- **Stage validation gates run in the daemon, un-sandboxed and un-timed.**
  *Why:* a gate must decide whether to even spawn the consumer, so its
  `ArtifactContract.check()` runs inline in the parent (daemon) process before
  the child is forked — unlike a job's `run()`, which is isolated + timeout-killed.
  *Impact:* a slow or hanging `check()` blocks that pipeline (no per-gate timeout),
  and a `check()` doing heavy I/O competes with the daemon. Throws are caught and
  turned into violations, so a crash can't escape — but a hang isn't bounded.
  *Revisit:* if a contract ever needs real work, give gates their own timeout
  (or run them as a lightweight child) the way job runs are bounded.

- **Gates are edge-scoped and matched purely by `key` string.**
  *Why:* `deriveGates` only emits a gate where a DIRECT upstream `produces` a key
  the downstream `consumes`; a consumed key with no producing upstream is treated
  as an external input (no gate, no warning).
  *Impact:* a typo'd/mismatched key silently produces NO gate rather than an error,
  so a contract you thought was enforced may not be. There's also no config-time
  check that declared contracts line up.
  *Revisit:* add a registry-time warning when a job `consumes` a key that no
  pipeline upstream `produces`.

- **Perfume accord percentages depend on cached page HTML.** `perfumes-parse`
  fills each accord's `pct` from the Fragrantica page's coloured-bar `width: NN%`
  (`parseAccordPercents` in `src/jobs/perfumes/parse.ts`) — but `perfumes-fetch`
  currently persists only the page *text* (`<id>.txt`) on success; the page HTML is
  saved only for pages it diagnoses as failed (`pages-failed/<id>.html`).
  *Impact:* `pct` populates only when an `<id>.html` is present next to the page; on
  the normal text-only success path accords keep `pct: null`. The parser + merge are
  empirically correct against real cached HTML (verified: green→100, woody→83,
  coconut→51, an accord absent from the page→null), so the slice activates the moment
  HTML is cached.
  *Revisit:* a follow-up should have `perfumes-fetch` also write `<id>.html`
  alongside `<id>.txt` so the whole library carries accord strengths (out of T009's
  scope — `fetch.ts` was not in scope).

- **Fragrantica-vs-LLM confidence weighting is prompt-enforced, not post-checked.**
  `perfumes-build` computes a continuous sample-size confidence weight
  `votes/(votes+k)` (k = corpus-median votes) and feeds the blend + an explicit
  "state this in the profile" directive into the build prompt
  (`confidenceClause` in `src/jobs/perfumes/build.ts`). The math, calibration,
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
  `store.ts`) that removes `work_items` whose `item_key` is no longer in a job's
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

- **Pipeline progress roll-up is point-in-time, not monotonic, and its denominator
  trusts `pipeline_jobs`.** T016 made pipeline `progress` a first-class roll-up:
  `rollUpPipelineProgress` (in `store.ts`) sums each member stage's fraction
  (terminal = 1, running = its `progress`/100, not-started = 0) over the member
  count from the `pipeline_jobs` table, and `setProgress` calls it live whenever a
  member emits progress. Trade-offs: (a) **non-monotonic under `repeatUntilStable`**
  — each cycle creates fresh member runs starting at 0, so the bar sawtooths down at
  cycle boundaries (acceptable: it's honestly redoing work). (b) The denominator is
  the **current** `pipeline_jobs` count; if a pipeline is re-synced with a different
  member set mid-run the percentage would shift — a non-issue in the single-process
  daemon where syncs happen at startup, not during a run. (c) It recomputes the full
  per-member latest-run query on **every** member progress event (one extra
  correlated subquery per `setProgress`) — negligible at this scale, not built for
  pipelines with hundreds of high-frequency-progress members.
  *Revisit:* if non-monotonic display ever bothers, clamp to a max-so-far per cycle;
  if membership can change mid-run, persist a `total_stages` snapshot on the
  pipeline run instead of counting `pipeline_jobs`.

- **Editable service limits are all-or-nothing per service, with no one-click
  reset.** T018 made `rate_per_minute`/`daily_cap`/`monthly_cap` editable from the
  Services page; the first edit flips `limits_overridden = 1` and a later code-sync
  then preserves the user's values for ALL THREE (mirrors the `enabled` reconcile).
  Trade-offs: (a) **no "revert to code default" control** — once overridden, the
  row no longer tracks code changes to any of the three limits; to go back you edit
  the values manually (or clear `limits_overridden` in the DB). (b) Only the three
  numeric limits are editable; `minIntervalMs`/`maxJitterMs` remain code-only.
  (c) The override is keyed by service name in the shared `services` table, so it's
  a single global value — there's no per-job override of a shared service's limit
  (by design: the whole point of a service is one cross-job governor).
  *Revisit:* if reverting becomes common, add a `DELETE /api/services/:name/limits`
  that clears the flag and re-seeds from the registered def.

- **The read-only DB browser is intentionally minimal.** T019 added a generic
  table viewer (`/db` page → `GET /api/db/tables[/:name]` → `browseTable` in
  `store.ts`). It is strictly read-only by construction: only `SELECT`/`PRAGMA`
  run, the table name is whitelisted against the live schema before any
  interpolation (so injection / unknown names are rejected → 404), and no
  write/mutation endpoint exists. Trade-offs: (a) **no arbitrary SQL** and **no
  per-column filtering/sorting** — you page through whole tables only (ordered by
  `rowid`, 50 rows/page, `limit` clamped to ≤500). (b) Rows are returned verbatim,
  so wide JSON `detail` columns are truncated with an ellipsis in the UI (full
  value in the cell `title`). (c) It reads the daemon's single shared connection
  in WAL mode, so it's a point-in-time snapshot, not a streaming/transactional
  view. *Revisit:* if ad-hoc filtering becomes common, add a constrained
  `WHERE`/`ORDER BY` builder (still parameterized, column names whitelisted) rather
  than exposing raw SQL.

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

- **Real-job stage-gate contracts check SHAPE + NON-EMPTY of a representative
  artifact, not every item.** T027 declared `produces`/`consumes` contracts on the
  perfumes + places pipeline stages (`src/jobs/{perfumes,places}/contracts.ts`), so
  each pipeline now derives **3 gates** that fire at every boundary (previously the
  mechanism existed but zero real jobs declared contracts, so no gate ever fired).
  *Why:* the goal is catching real external-format drift (a reshaped Fragrantica
  page, a changed Takeout CSV layout) cheaply. So the per-item directory contracts
  (`fragrantica-pages`, `fragrantica-data`) pass when **at least one** captured
  page / parsed record has the expected shape rather than validating all N, and the
  resolve/enrich contracts require **≥1** entry with a real `place_id`, not all.
  Contracts are **factory functions** taking an optional path (defaulting to the
  job's real `data/` artifact) so the jobs wire the defaults while unit tests point
  them at synthetic fixtures — the real gitignored `data/` is never needed to test.
  *Impact:* a corpus where most items are well-formed but a minority drifted still
  passes the gate (those bad items are handled per-item by the work_items ledger /
  retries, not the gate). The gate is a coarse "the upstream format didn't break
  and produced *something* usable" check, deliberately not a full-schema every-row
  validation (brittle, and would block the whole consumer on one bad item).
  *Revisit:* if silent per-item drift becomes a problem, add a stricter opt-in
  contract variant that samples N records or asserts a minimum well-formed fraction.

- **Gate markers are chips on the consumer node, not lines drawn on the edge.**
  *Why:* the pipeline DAG renders as left-to-right *wave columns* (`Dag.tsx`), not
  per-node SVG edges — there is no drawn producer→consumer line to attach a marker
  to. Each inbound gate is shown as a small chip beneath its consumer node instead,
  labelled with the producer + artifact key so the boundary it guards is explicit.
  *Impact:* when a producer and consumer sit more than one wave apart, the chip
  isn't visually connected to the producer by a line; you read the relationship
  from the chip's label, not a drawn arrow. Gate STATE (passed/failed/pending) is
  derived from member runs by string-matching the gate-failure error prefix
  (`gateFailurePrefix`), so the executor's failure-detail format and the API's
  classifier are coupled — both live in `core/dag.ts` to keep them in lockstep.
  *Revisit:* if a true node-graph (SVG edges) replaces the wave layout, move the
  gate marker onto the actual edge; if the failure-detail format must change, update
  `gateFailurePrefix` (one place) so `classifyGates` keeps matching.

- **The per-job `enabled` toggle + `schedule` field are now vestigial.** *Why:*
  T037 made every job a pipeline member and moved scheduling/enable ownership to the
  pipeline. The scheduler no longer reads a job's `schedule` or its `jobs.enabled`
  flag — only the pipeline's. The job-level toggle still exists on the job detail
  page and `POST /api/jobs/:name/toggle` / `setJobEnabled` still write the column,
  but flipping it changes nothing about whether the job runs (the pipeline gates
  that). *Impact:* a stale control that looks meaningful but isn't. It was left in
  place because removing it cleanly would require editing the out-of-scope job
  detail page and the `jobs.schedule`/`enabled` columns. *Revisit:* a follow-up can
  drop the job toggle UI + endpoint + column and the unused `schedule` field from
  `JobDefinition` once the schema change is in scope.

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

- **The gate page's "actual" is the artifact ON DISK NOW, not a snapshot of what
  flowed at run time.** *Why:* T065's expected-vs-actual gate page
  (`GET /api/workflow-runs/:id/gates/:producer/:key`) re-runs each side's contract
  `check()` live against the `data/` files when you open the page, rather than
  persisting the `GateResult` captured during the workflow run. This keeps the run
  path unchanged (no new columns / no result serialization) and the endpoint
  cheap + paid-call-free. *Impact:* for a historical run, the per-expectation ✓/✗
  and sample reflect the CURRENT files — if a later run overwrote them, or the
  files were deleted/regenerated, the page shows the latest state, which may differ
  from what actually crossed the gate on that run. The gate *state* badge
  (passed/failed/pending) is still run-scoped and accurate (it comes from
  `classifyGates` over the run's member runs). *Revisit:* if per-run fidelity
  matters, persist the producing/consuming `GateResult` (checks + sample) on the
  member run when the gate is enforced and serve that instead of re-checking.

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

## Workflow run-limits (T094)

- **"Pending" for re-selection = entry-not-done OR any descendant outstanding.**
  *Why:* a limited re-run should resume a partially-finished root's downstream work, so
  `selectPendingRoots` keeps a root in the candidate pool if its entry-stage item isn't done OR any
  ledger row for that root (across the workflow's members) is still outstanding (not success/ignored
  and not failed-past-budget).
  *Impact:* a root whose entry is done but whose only outstanding descendants are **stuck** (failed
  past `maxAttempts`) is treated as done and won't be re-selected by a *limited* run — unstick it, or
  run unlimited, to retry it. Conversely a root with any retryable descendant is re-selected and
  counts against the N, so a limited re-run may "spend" some of N on finishing in-flight roots before
  reaching brand-new ones.
  *Revisit:* if "limit = N brand-new roots only" is ever wanted, add a selection mode that counts only
  never-started roots.

- **A limited run selects roots from the root stage's CURRENT `inputKeys()` — which for `places`
  reads `places.json` (the ingest output), not the raw CSVs.**
  *Why:* the root stage is `cid-to-place-id-resolver`, and its candidate roots are the CIDs in
  `places.json`. Selection runs in the daemon at run start, **before** `places-ingest` (re)builds
  `places.json` that same run.
  *Impact:* on a brand-new DB/checkout where `places.json` doesn't exist yet, a limited places run
  selects **nothing** (inputKeys returns `[]`) and does no work. Run the workflow **unlimited once**
  (so ingest produces `places.json`) before using a limit, or run `places-ingest` first. Perfumes is
  unaffected — its root stage reads the committed-by-the-user `perfumes.json` input directly.
  *Revisit:* if needed, run ingest's transform as part of `inputKeys()` (it's cheap + idempotent) so a
  fresh limited run can enumerate roots without a prior unlimited pass.

- **Stages topologically BEFORE the root stage run UNFILTERED under a limit.**
  *Why:* they establish the universe of roots rather than consuming it — e.g. `places-ingest` parses
  ALL Takeout CSVs into `places.json` regardless of the limit. The limit applies from the root stage
  onward.
  *Impact:* a limited places run still does the full (cheap, idempotent) bulk ingest each time; only
  resolve/enrich/llm are bounded to N CIDs. This is intended, not a bug.
  *Revisit:* only if a pre-root stage ever becomes expensive — then it would need its own bounding.

- **Validation-gate display on the graph views is a TOGGLEABLE evaluation aid (T099).**
  *Why:* the original single chip-per-gate (T090) took too much space, so five compact styles
  (`icon`/`dot`/`key`/`connector`/`lock`) were added behind a live, `localStorage`-persisted
  selector so the user can pick a favourite on the real site.
  *Impact:* the graph views carry a "Gate style" selector and five code paths for the same gate
  data — extra surface that is intentionally temporary, not a permanent feature.
  *Revisit:* a FOLLOW-UP task hardcodes the chosen winner and deletes the toggle + the four unused
  styles (and the `useGateStyle`/`GATE_STYLES` machinery in `app/ui.tsx`).
