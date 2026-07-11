# B05: `resolveBulkScope` silently escalates unknown scope to `all` (mass unstick/ignore)

**Type**: bug · **Priority**: P2 · **Effort**: S
**Area**: api
**Affected files**: `src/api/server.ts` (`resolveBulkScope` ~251–266; consumers ~508–524), `src/db/store.ts` (`bulkUnstickItems` ~1020–1024)

## Problem

`resolveBulkScope`'s final line is `return { type: 'all' };`, which catches ANY unrecognized
scope string. A typo'd request — `{ scope: 'workflows', workflow: 'places' }` (plural) — silently
performs the **most destructive** interpretation: `POST /api/stuck/unstick-bulk` with that body
deletes every failed ledger row across every job system-wide (losing attempt counts and failure
details), instead of erroring or acting on one workflow.

Related lax cases in the same function:

- `{ scope: 'workflow' }` with no `workflow` name → falls through to `all` (~line 260).
- `{ scope: 'job' }` with no `job` → `jobName: ''` → silent no-op instead of a 400.

This compounds with B06 (`readBody` maps malformed JSON to `{}` → scope defaults to `all`), and
with B02 (a CSRF'd empty-body POST to `unstick-bulk` resolves to scope-all).

## Proposed fix

- Unknown `scope` value → **400** with the accepted values in the message.
- `scope: 'job'` without a `job` name, and `scope: 'workflow'` without a `workflow` name → 400.
- Keep `{}` / `{ scope: 'all' }` as the explicit all-scope forms (per the documented API shape),
  but consider requiring `{ scope: 'all' }` to be explicit once B06 makes malformed bodies a 400
  — decide with the owner; the CLAUDE.md-documented contract currently allows bare `{}`.

## Acceptance criteria

- `{ scope: 'workflows', workflow: 'x' }` → 400, zero rows affected.
- `{ scope: 'workflow' }` (no name) → 400. `{ scope: 'job' }` (no job) → 400.
- Existing documented shapes (`{}`, `{scope:'all'}`, `{scope:'job', job}`,
  `{scope:'workflow', workflow}`) behave exactly as before.

## Test plan

`server.test.ts` already covers all/job/workflow/unknown-workflow-name (~898–951); add the
unrecognized-scope-string and missing-name cases.
