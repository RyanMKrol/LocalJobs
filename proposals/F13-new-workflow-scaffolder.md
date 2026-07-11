# F13: `new-workflow` scaffolder — honestly low value here; specified in case the checklist friction grows

**Type**: feature · **Priority**: P3 · **Effort**: S
**Area**: scripts
**Backlog cross-ref**: not tracked. Related: T459 (pending, needs-human — an IO-shape design step when scoping new workflows) is the planning-side complement.

## Problem (and the honest counter-argument)

Adding a workflow spans a long checklist: folder + manifest + N stage file pairs + tests +
`contracts.ts` gates + folder `CLAUDE.md` + README table row + `_dashboard-harness.mjs`
fixtures + (if private) a `.gitignore` line. BUT: every workflow in this repo was authored by
Claude sessions or the harness reading CLAUDE.md, and the enforcement that matters is already
mechanical (orphan-job loud-fail, `gate-coverage.test.ts`, docs-as-Done). A scaffolder's real
value — encoding the checklist in one place — is achieved more cheaply by the D02 restructure
putting a tight authoring checklist in `src/workflows/CLAUDE.md`. Recommend building this only
if post-D02 authoring still misses steps.

## Design sketch (if built)

`scripts/new-workflow.ts <name> [--stages a,b] [--schedule cron] [--private]`:

- Emits: `src/workflows/<name>/<name>.workflow.ts` (manifest with schedule/category
  placeholders), N `stages/<stage>.job.ts` + `<stage>.ts` + `<stage>.test.ts` triples with
  trivial `{ok:true}` gates pre-wired between consecutive stages, a stub folder `CLAUDE.md`,
  `config.ts` anchored at the folder root.
- PRINTS the un-generatable checklist: README table row, harness fixtures, daemon restart,
  `.gitignore` line if `--private` (it must NOT edit `.gitignore` or any `data/` dir itself —
  privacy rules).
- Refuses to overwrite an existing folder.

## Acceptance criteria

- Scaffolded output passes `tsc`, `npm test` (including gate-coverage), and daemon load with
  the workflow disabled by default (`schedule: null` until the author sets one).
