# CLAUDE.md — src/workflows/

## ✅ Stages use ports (2026-11)

A stage declares what it reads and writes with `defineStage({ inputs, outputs, run })`
(imported from `src/engine/index.js`), and the engine passes its inputs in, records its
outputs, and checks both. Worked examples by shape: `mount-keeper/` (one stage, an inline
output), `stocks-sync/` (a chain), `tv-recs/` and `movies/` (fan-out and fan-in),
`stock-digest/` (two different inputs joining), `perfumes/` (an item pipeline built on
`eachItem`), `plex-rename/` (data that travels in the ledger). See "Ports" in the root
`CLAUDE.md` for the rules and the guarantees. In short:

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
- A workflow's `name` must differ from the name of every job, its own stages included
  (`mount-keeper` runs `mount-keeper-check`). A clash stops the daemon from starting.
- Each workflow folder has its own `CLAUDE.md` with a table of its stages, their inputs
  and their outputs. Keep that table true when you change a stage.

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

## ✅ A ledger row's `detail` must say what the stage did to the item

When a stage keeps a ledger, each successful row's `detail` says what THAT stage did for
the item, not just which item it is. A stage that writes a file per item records the file
(`detail.markdown`, or `detail.path` + `detail.format` for anything that is not markdown).
A stage that finds a value records the value. Give the stage a `describeItem(detail, key)`
when those are worth showing as fields on the run page. `eachItem` records whatever the
handler returns as the detail. Nothing checks this mechanically. The root `CLAUDE.md`
("Job conventions") has the reasoning.

## ✅ Never store a raw absolute path in `detail.markdown`/`detail.path` (T447)

`markWorkItem` normalizes both keys to a path relative to the workflows root before
persisting (`toStoredPath` in `src/db/store.ts`) — pass your job's natural absolute
path as always, the store makes it relative transparently. This exists because the
2026-07 `src/jobs` → `src/workflows` rename froze every already-recorded absolute path,
breaking the "View" output preview across 13 jobs until a one-time repair script fixed
it. Never hand-construct or compare against a raw absolute `data/out/` path in new code
— a future folder rename must not be able to strand ledger rows again. Full rationale
in the root `CLAUDE.md`'s "Job resources are job-local" convention.

## ✅ Write item loops with `eachItem`

`eachItem` (`src/engine/items.ts`, exported from `src/engine/index.js`) is the loop for a
stage that works through a list. It skips what the ledger says is done, leaves out items
outside a limited run, counts attempts, logs `i/N` with progress, records a failed item and
carries on, stops politely at a quota, and throws at the end if any item failed, so the run
is recorded `failed` and the stages after it do not run. The handler writes the item's
data and returns its detail. Only the perfumes stages use it so far. A stage that still has
a hand-written loop must do the same things itself, above all the last one: if any item
failed this run, `throw` at the end (a quota pause is not a failure). A stage that
re-records a whole snapshot every run uses `snapshotLedger`.

## ✅ Save, then mark done

A stage that adds each item's result to one file the next stage reads must not mark the
item done before that file is saved. Killed in between, the item would be "done" for ever
and never reach the next stage. Save per item first, or hold the marks back with
`createCheckpoint` (`src/engine/checkpoint.ts`; the places stages do) or `eachItem`'s
`save` option. Write hand-off files with the helpers in `src/engine/fsjson.ts`, which
write atomically, never a bare `writeFileSync`.

## ✅ A stage that can finish an item early declares `settles`

If a stage can decide that an item needs nothing more, and the last stage of the workflow
only records the items it actually changed, that item never gets a row in the last stage.
A limited run (`{"limit": N}`) then sees it as unfinished for ever, picks it every time and
does nothing. Give the deciding stage `settles: (detail) => boolean` on its `defineStage`:
true when its recorded result means no later stage has work for the item.
`plex-language-fix/stages/evaluate.job.ts` and `plex-rename/stages/plan.job.ts` are the
examples.

## ✅ A root-stage job with `inputKeys()` must declare `inputKeysService` (T583)

Any job that declares `inputKeys()` to feed a manual run-limit must name the service its input keys
query through via the `inputKeysService?: string` field on the `JobDefinition` — a claim that the job
queries the LIVE external source (a Plex library scan, a GitHub API call, a DynamoDB table scan, a
local filesystem walk), never reads back this job's own prior `work_items` output.
`src/core/root-inputkeys-service.test.ts` fails the suite when a job declares `inputKeys()` without
naming a real, registered service. Omit the field only when the job has no `inputKeys()`. Worked examples (each under its workflow's `stages/` folder):
`perfumes/stages/find-url.job.ts` (`'dynamodb'`), `places/stages/resolve.job.ts` (`'fs'`),
`plex-language-fix/stages/discover.job.ts`, `plex-profiles/stages/build.job.ts` and
`plex-rename/stages/discover.job.ts` (`'plex'`), `projects-sync/stages/github-sync.job.ts`
(`'github'`).
