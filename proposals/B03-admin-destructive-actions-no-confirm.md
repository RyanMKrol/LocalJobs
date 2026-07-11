# B03: "Delete all workflow output" and "Run all workflows" fire with NO confirmation

**Type**: bug (destructive-action safety) · **Priority**: P1 · **Effort**: S
**Area**: dashboard
**Affected files**: `dashboard/app/admin/page.tsx` (`deleteAllOutput` ~23–35, `confirmRunAll` ~37–49, buttons ~85–91 and ~160–167)
**Verified**: yes — coordinator confirmed both handlers call the API immediately with no `confirm()`.

## Problem

`deleteAllOutput()` calls `api.resetAllWorkflowsOutput()` directly on click. That permanently
deletes, fleet-wide: every workflow's `work_items` ledger (the "what have I already
processed/notified" memory), all run history and logs, and all `data/out/**` files. Recovery
means re-running everything — including re-spending paid Google Places / Gemini quota for the
places corpus — and the run history is gone permanently.

Every comparable action in the product IS confirm-gated: the per-workflow reset
(`workflows/[name]/page.tsx` ~861–871, with a multi-line warning), the cache clear
(`admin-cache/page.tsx:32`), and all StuckPopover bulk actions (`ui.tsx` ~338–350). The single
most destructive button in the product is the only unguarded one.

"Run all workflows" is not destructive but starts paid work on every workflow at once; its
handler is literally named `confirmRunAll` yet contains no confirm — which reads like a dropped
intent, not a decision.

**Failure scenario**: one misclick on `/admin` (a page the owner visits for other reasons — it
hosts several controls) wipes all ledgers and output.

## Proposed fix

- Gate `deleteAllOutput` behind the same multi-line `window.confirm()` used by the per-workflow
  reset, spelling out the fleet-wide scope ("ALL workflows: ledgers, run history, output files").
  Given the blast radius, consider type-to-arm (require typing `delete` in a small input to
  enable the button) — but a confirm matching the established pattern is the minimum.
- Add a plain `confirm()` to `confirmRunAll` ("Start a run of every enabled workflow now? This
  triggers paid API calls.").

~6 lines total.

## Acceptance criteria

- Clicking either button first shows a confirmation; cancelling performs no API call.
- The confirm text for delete-all names the three things destroyed (ledger, run history, output
  files) and says "all workflows".

## Test plan

- Manual + visual check (`node dashboard/scripts/visual-check.mjs` after build); if a FLOWS entry
  exists for /admin, extend it to exercise the cancel path (dialog auto-dismiss in Playwright).
- Note: `_dashboard-harness.mjs` must keep working — Playwright auto-accepts/dismisses dialogs
  only if configured; add a `page.on('dialog')` handler to the harness if the flows touch these
  buttons.
