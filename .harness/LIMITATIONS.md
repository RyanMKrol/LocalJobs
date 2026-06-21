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

> Add further project trade-offs below as they arise.
