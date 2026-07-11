# B01: `findWorkflowDataOut` walks `data/` trees — imports cloned code and silently breaks reset-output

**Type**: bug · **Priority**: P1 · **Effort**: S
**Area**: api
**Affected files**: `src/api/server.ts` (`findWorkflowDataOut` / `walkForWfFiles`, ~lines 105–135)
**Verified**: yes — coordinator confirmed the missing `data/` skip in the walk AND 16 live clone manifests on disk under `src/workflows/projects-sync/data/repos/LocalJobs/src/workflows/**`.

## Problem

The root CLAUDE.md Gotchas section documents a real prior incident under the heading "**Never let
`data/` folders be scanned for code, by anything**": `projects-sync` shallow-clones the owner's
repos — including this very repo — into `src/workflows/projects-sync/data/repos/<name>/`, and a
recursive code-discovery walk that doesn't exclude `data/` will find and load the STALE CLONED
copies. The registry, tsconfig, and test runner were all fixed for this. **The API's private walk
was not.**

`findWorkflowDataOut` (used by `POST /api/workflows/:name/reset-output` and `reset-output-all` to
locate the workflow's `data/out/` tree for file deletion) recurses every directory under
`WORKFLOWS_ROOT` with no exclusion:

```ts
if (entry.isDirectory()) out.push(...walkForWfFiles(full));   // ← no `data` skip
else if (isWfFile(entry.name)) out.push(full);
```

Two distinct consequences:

1. **Stale-code execution from a data tree.** For each found manifest it runs
   `await import(pathToFileURL(file).href)` in the daemon process. Every cloned manifest and its
   import chain executes at daemon runtime — the exact shadowing incident class the Gotcha warns
   about, resurfaced via the API layer. The clone's `tv-recs.workflow.ts` default-exports
   `name: 'tv-recommendations'` — the same name as the real workflow.
2. **Functional break: files silently not deleted.** The function returns on the FIRST name
   match:
   ```ts
   const candidate = joinPath(dirname(file), 'data', 'out');
   ...
   return existsSync(candidate) ? candidate : null;
   ```
   Clones lack `data/out` (data/ is gitignored, so cloned repos don't carry it). If the clone's
   manifest is walked before the real one — and `projects-sync` sorts alphabetically before
   `stocks-sync`, `tv-recs`, `vercel-daily-redeploy`, `workouts-sync` — the walk matches the
   clone first, `existsSync` fails, and the function returns **null**. The endpoint then reports
   `ok: true` with `filesRemoved: 0` while the REAL workflow's `data/out/**` is never cleared.
   The DB ledger IS wiped, so the next run re-processes everything against stale output files.

## Proposed fix

1. Skip `entry.name === 'data'` directories in `walkForWfFiles` (mirror `registry.ts`'s
   exclusion).
2. Do not return `null` on a first name-match whose `data/out` is missing — keep walking; only
   return `null` after the full walk finds no match with an existing `data/out`. (Even with the
   `data` skip, this makes the function robust to any future generated tree.)
3. Better (structural): drop the walk entirely and resolve the workflow's source directory from
   the registry's already-loaded definitions — the registry knows each workflow's file path and
   already excludes `data/`. This removes the duplicate discovery logic that drifted in the first
   place.
4. While here: tighten `deleteDataOutContents`'s non-trailing-separator path check (it currently
   matches `…/data/output-x`; unreachable with hostile input today, but cheap to fix).

## Acceptance criteria

- `reset-output` for a workflow whose folder sorts after `projects-sync` deletes the real
  `data/out/**` files even with a full self-clone present under `projects-sync/data/repos/`.
- No module under any `data/` directory is ever imported by the endpoint.
- Regression test seeding a fake `data/repos/.../x.workflow.ts` with a duplicate workflow name
  (pattern already exists in `src/workflows/registry-find-files.test.ts`) asserting both: the
  clone is not imported, and the real `data/out` is found.

## Test plan

- Unit test as above (synthetic tree in a temp dir).
- Manual: run `POST /api/workflows/tv-recommendations/reset-output` on the live machine and
  confirm `filesRemoved > 0` when files exist.
