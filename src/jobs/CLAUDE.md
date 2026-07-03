# CLAUDE.md — src/jobs/

## ✅ Every adjacent job pair needs a validation gate (non-negotiable)

Every pair of adjacent jobs in every workflow's DAG — every `dependsOn` edge —
must have a validation gate between them: a matching `produces`/`consumes`
`ArtifactContract` key declared on both sides of the edge
(`src/core/types.ts`, `src/core/dag.ts`'s `deriveGates`). **A trivial gate is an
acceptable minimum bar** — a bare `check(): { ok: true }` "the previous stage
succeeded" contract satisfies the rule; not every boundary needs a rich
shape-check like `places`/`perfumes`'s. Reach for a real shape-check only when
there's an actual artifact worth validating (see `src/jobs/places/contracts.ts`
and `src/jobs/perfumes/contracts.ts` for the richer worked examples).

**This is mechanically enforced, not just documented.** `src/core/gate-coverage.test.ts`
walks every workflow the registry loads and asserts every DAG edge has a
matching gate, failing `npm test` if one is missing. Since a green `npm test`
is part of Definition of Done everywhere in this repo (root `CLAUDE.md`), a new
workflow LITERALLY CANNOT merge without gates at every stage boundary.

**How to wire one on a new job:** declare `produces`/`consumes` on the
`JobDefinition` in the `.job.ts` file, pointing at factory functions in a
`contracts.ts` at the job-folder root. `src/jobs/perfumes/stages/fetch.job.ts`
is the shortest concrete example; `src/jobs/stocks-sync/contracts.ts`,
`src/jobs/projects-sync/contracts.ts`, `src/jobs/workouts-sync/contracts.ts`,
and `src/jobs/stock-digest/contracts.ts` are further worked examples alongside
the original places/perfumes ones.

This is a local reinforcement of the identical rule in the root `CLAUDE.md`
("Validation gates between workflow stages"). It's repeated here because Claude
Code loads the nearest `CLAUDE.md` when working directly inside `src/jobs/`, so
the rule surfaces automatically to any future session or agent adding a job or
workflow in this directory — not just one that happened to read the root doc
first. See the root doc for the full mechanism (shape/checks/sample, gate
detail pages, `gateFailurePrefix`, etc.) — this file only states the rule.
