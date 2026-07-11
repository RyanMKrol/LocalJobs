# B22: The generic workflow Output section can't preview non-markdown artifacts — `hasMarkdown` ignores `detail.path`, and plex-space-saver fakes a markdown key to survive

**Type**: bug (T262 convention break) · **Priority**: P2 · **Effort**: S
**Area**: dashboard / db
**Affected files**: `dashboard/app/components/WorkflowOutputSection.tsx` (~111), `src/db/store.ts` (`workflowTerminalItems` ~791–796), `src/workflows/plex-space-saver/stages/scan.ts` (~91), `dashboard/scripts/_dashboard-harness.mjs` (~560, ~890–893)

## Problem

The T262 output-form convention says any output form (`detail.path` + `detail.format`) is served
by the output endpoint "automatically", and the Stage I/O panel honours it
(`StageIoLists.tsx` ~100–104 accepts `markdown` OR `path`). But the workflow-detail page's
generic Output section does not:

- `workflowTerminalItems` derives `hasMarkdown` from `detail.markdown` ONLY (store.ts ~791–796);
- `WorkflowOutputSection` gates its "View" button on `item.hasMarkdown` (~111).

So a terminal item recording `{ path, format: 'size-table' }` renders with **no View button at
all**. Two live consequences:

1. `overrides-audit` (records `path`+`format` correctly per convention) has no artifact preview
   in its Output section.
2. `plex-space-saver` *worked around it* by setting `detail.markdown` to a **`.json` path**
   purely to trick the flag (self-documented workaround at `scan.ts:91`) — and
   `safeOutputMarkdown` would reject that path anyway, so the workaround produces a broken View.
3. The hermetic check can't catch any of this because the fixture explicitly lies:
   `_dashboard-harness.mjs` ~890–893 sets `hasMarkdown: true` "purely a fixture convenience so
   the synthetic 'View' button renders."

## Proposed fix

1. `workflowTerminalItems`: `hasArtifact = !!(detail.markdown || detail.path)` (expose as
   `hasArtifact`, keep `hasMarkdown` for compat or migrate the one consumer).
2. `WorkflowOutputSection`: gate View on `hasArtifact`; the modal already dispatches by format
   via `renderOutputBody` (T458), so non-markdown forms render correctly with zero further work.
3. Remove plex-space-saver's fake `detail.markdown` (record `path` + `format` only, like
   overrides-audit) — one-time ledger rows already written can be left; new runs record clean
   rows.
4. Fix the harness fixture to the REAL shape (`path`+`format`, no fake `hasMarkdown`) so the
   check exercises production semantics — fixtures that lie mask exactly this class of bug.

## Acceptance criteria

- plex-space-saver and overrides-audit Output items show a working View that renders via the
  `json`/raw renderer.
- Markdown workflows (places, perfumes) unchanged.
- The harness fixture no longer sets `hasMarkdown` for path-only items and visual-check still
  shows a View button.

## Test plan

Unit test `workflowTerminalItems` with a path-only detail row; visual-check the two workflows'
Output sections; run mobile-check.
