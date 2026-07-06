# CLAUDE.md — src/workflows/

## ✅ Every adjacent job pair needs a validation gate (non-negotiable)

Every pair of adjacent jobs in every workflow's DAG — every `dependsOn` edge —
must have a validation gate between them: a matching `produces`/`consumes`
`ArtifactContract` key declared on both sides of the edge
(`src/core/types.ts`, `src/core/dag.ts`'s `deriveGates`). **A trivial gate is an
acceptable minimum bar** — a bare `check(): { ok: true }` "the previous stage
succeeded" contract satisfies the rule; not every boundary needs a rich
shape-check like `places`/`perfumes`'s. Reach for a real shape-check only when
there's an actual artifact worth validating (see `src/workflows/places/contracts.ts`
and `src/workflows/perfumes/contracts.ts` for the richer worked examples).

**This is mechanically enforced, not just documented.** `src/core/gate-coverage.test.ts`
walks every workflow the registry loads and asserts every DAG edge has a
matching gate, failing `npm test` if one is missing. Since a green `npm test`
is part of Definition of Done everywhere in this repo (root `CLAUDE.md`), a new
workflow LITERALLY CANNOT merge without gates at every stage boundary.

**How to wire one on a new job:** declare `produces`/`consumes` on the
`JobDefinition` in the `.job.ts` file, pointing at factory functions in a
`contracts.ts` at the job-folder root. `src/workflows/perfumes/stages/fetch.job.ts`
is the shortest concrete example; `src/workflows/stocks-sync/contracts.ts`,
`src/workflows/projects-sync/contracts.ts`, `src/workflows/workouts-sync/contracts.ts`,
and `src/workflows/stock-digest/contracts.ts` are further worked examples alongside
the original places/perfumes ones.

This is a local reinforcement of the identical rule in the root `CLAUDE.md`
("Validation gates between workflow stages"). It's repeated here because Claude
Code loads the nearest `CLAUDE.md` when working directly inside `src/workflows/`, so
the rule surfaces automatically to any future session or agent adding a job or
workflow in this directory — not just one that happened to read the root doc
first. See the root doc for the full mechanism (shape/checks/sample, gate
detail pages, `gateFailurePrefix`, etc.) — this file only states the rule.

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
