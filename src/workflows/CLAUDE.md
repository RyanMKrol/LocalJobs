# CLAUDE.md — src/workflows/

## ✅ Stages use ports (2026-11)

A stage declares what it reads and writes with `defineStage({ inputs, outputs, run })`
(imported from `src/engine/index.js`), and the engine passes its inputs in, records its
outputs, and checks both. `tv-recs/` and `movies/` are the worked examples of a fan-out
and fan-in, `perfumes/` of an item pipeline built on `eachItem`. See "Ports" in the root `CLAUDE.md` for the rules and the guarantees. In
short:

- Artifact types live in the workflow's `contracts.ts` (`jsonArtifact`, `dirArtifact`,
  `ledgerArtifact`, `inlineArtifact`, …): the key, a `check(value)`, and `items(value)`
  for display.
- An input binds to the DIRECT dependency that outputs the same artifact key. Reading
  something from further back means adding that edge to the manifest.
- Every declared output must be committed every run. Mark a store that grows across runs
  `cumulative: true`; otherwise an output that was not written this run fails the stage.
- Never write a ledger row only so the run page has something to show. Declare an
  `inlineArtifact` output instead.
- Every shipped workflow is on ports, and the registry refuses one that is not.

## ✅ Every edge carries data, and every stage declares its outputs (non-negotiable)

This replaced the old rule that every adjacent job pair needed a hand-written gate contract
(that mechanism has been deleted). It is enforced when the registry loads (the daemon
refuses to start) and again by `src/core/gate-coverage.test.ts`:

- Every workflow is on ports. A stage with no declared `outputs` is rejected.
- Every `dependsOn` edge must feed one of the consuming stage's inputs: an edge that carries
  no data is an error. If a stage reads something from further back, it needs that edge too.
- The check an artifact type declares runs when the producing stage commits its output: a
  value that fails is never written. Before the consuming stage starts, the engine confirms
  that what it is about to hand over is what the producer committed in this run, and that
  it passed that check. That is the gate. Give an artifact a real check
  when there is something to get wrong (see `plex-rename/contracts.ts`, whose plan and
  verdict checks sit in front of the stage that moves files); a "has the expected shape"
  check is the minimum.

## ✅ A stage's success `detail` must describe what it produced (2026-07)

On every `markWorkItem(..., 'success', ...)` call, `detail` must say what THAT
stage actually did — not just restate the item's name/identity. A file-writing
stage references the file (`detail.markdown`, or `detail.path` + `detail.format`
for any non-markdown output); a value-discovering stage records the value
itself; only a genuine, deliberate pass-through gets minimal `detail`. This is
NOT mechanically enforced (unlike the gate rule above) — there's no structural
way to tell "nothing to show" from "author didn't think about it." Full
rationale + worked examples in the root `CLAUDE.md`'s "Job conventions"
section — this file only states the rule so it surfaces when working here.

## ✅ Never store a raw absolute path in `detail.markdown`/`detail.path` (T447)

`markWorkItem` normalizes both keys to a path relative to the workflows root before
persisting (`toStoredPath` in `src/db/store.ts`) — pass your job's natural absolute
path as always, the store makes it relative transparently. This exists because the
2026-07 `src/jobs` → `src/workflows` rename froze every already-recorded absolute path,
breaking the "View" output preview across 13 jobs until a one-time repair script fixed
it. Never hand-construct or compare against a raw absolute `data/out/` path in new code
— a future folder rename must not be able to strand ledger rows again. Full rationale
in the root `CLAUDE.md`'s "Job resources are job-local" convention.

## ✅ An item-loop job must fail its own run if it failed any item this run (2026-07)

A processing loop's per-item `try/catch` / `markWorkItem(..., 'failed', ...)` / `continue`
pattern is correct and unchanged — but at the end of the loop, if this run's own tally shows
`failed > 0` (not a `'skipped'` soft-stop like a quota pause), the job's `run()` MUST `throw`
a summarizing `Error` instead of returning normally, so the RUN itself is recorded `'failed'`
and blocks downstream DAG dependents. No new framework mechanism needed — see the root
`CLAUDE.md`'s "Job conventions" section for the full reasoning; this file only states the rule
so it surfaces when working here.

## ✅ A root-stage job with `inputKeys()` must declare `inputKeysService` (T583)

Any job that declares `inputKeys()` to feed a manual run-limit must name the service its input keys
query through via the `inputKeysService?: string` field on the `JobDefinition` — a claim that the job
queries the LIVE external source (a Plex library scan, a GitHub API call, a DynamoDB table scan, a
local filesystem walk), never reads back this job's own prior `work_items` output. When declared, the
enforcing test (T488, a later task) asserts that every `inputKeys()` call truly routes through that
service. Omit the field if the job has no `inputKeys()` or if the function doesn't route through a
service. Worked examples: `perfumes/find-url.job.ts` (`inputKeysService: 'dynamodb'`), `places/resolve.job.ts`
(`inputKeysService: 'fs'`), `plex-language-fix/discover.job.ts` (`inputKeysService: 'plex'`),
`projects-sync/github-sync.job.ts` (`inputKeysService: 'github'`), `plex-profiles/build.job.ts`
(`inputKeysService: 'plex'`).
