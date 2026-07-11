# B20: Workflow Run/toggle failures are invisible in the dashboard, and the Overview Run button ignores the running state — a click can silently do nothing

**Type**: bug · **Priority**: P2 · **Effort**: S
**Area**: dashboard
**Affected files**: `dashboard/app/workflows/[name]/page.tsx` (~950–956), `dashboard/app/page.tsx` (~36–38, 196), `dashboard/app/workflows/page.tsx` (~29–31)
**Verified**: coordinator confirmed `isRunning={false}` hardcoded at `page.tsx:196`.

## Problem

1. **No error surfacing on Run/toggle.** The detail-page `run()` is
   `try { await api.runWorkflow(...) } finally {...}` — **no catch**: a 409 ("already has an
   active run"), a 400, or a network failure becomes an unhandled promise rejection; the button
   flashes "Started…" then nothing. `toggle()`/`toggleNotify()`/`toggleCertified()` likewise
   have no catch and no error state. The Overview and workflows-list pages swallow run errors
   with `catch { /* next poll reflects reality */ }` — but a run that never STARTED produces
   nothing for the poll to reflect. This drops exactly the signal the API's T105 409 semantics
   exist to deliver ("so the caller knows it didn't start").
2. **Overview cards hardcode `isRunning={false}`**:
   `<RunButton variant="secondary" isRunning={false} …>` at `page.tsx:196` — two lines above,
   `p.last_run?.status === 'running'` is already computed for the progress bar. CLAUDE.md
   (T105): "The dashboard's Run buttons … disable and show 'Running…' while
   `last_run.status === 'running'`". The workflows list and detail page honour it; the Overview
   card violates it — and defect 1 then swallows the resulting 409, so the click silently does
   nothing.

## Proposed fix

- `page.tsx:196`: `isRunning={p.last_run?.status === 'running'}`.
- Add a small `err` state + `<p className="error">` beside the Run button and the toggles on the
  detail page — the same page already has that exact pattern for the schedule/concurrency
  editors (~1003, ~1048). On the Overview/workflows-list cards, render the message inline under
  the card or as the button's title; minimum bar: never leave an unhandled rejection.

## Acceptance criteria

- Clicking Run while a run is active is impossible on all three surfaces (button disabled,
  "Running…").
- A 409/400/network failure on Run or any toggle renders a visible message; no unhandled
  rejections in the console.

## Test plan

Extend `_dashboard-harness.mjs` fixtures with a 409-returning run route + a FLOWS entry
exercising it; visual-check the error rendering. (Keep the harness's living-artifact rule: the
fixture change lands in the same commit.)
