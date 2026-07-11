# Q04: `usePoll` hardening — out-of-order responses, and detail pages that render silently blank when the daemon is down

**Type**: quality · **Priority**: P3 · **Effort**: S
**Area**: dashboard
**Affected files**: `dashboard/app/ui.tsx` (`usePoll` ~282–310), `dashboard/app/workflows/[name]/page.tsx` (~851), `dashboard/app/workflow-runs/[id]/page.tsx` (~52), `dashboard/app/jobs/[name]/page.tsx` (~13–15), both gate pages

## Problem

The polling architecture itself is sound — one shared `usePoll` hook everywhere, with an unmount
guard and `fnRef` against stale closures. Four edges:

1. **No sequence guard**: an interval tick and a manual `refetch()` — or a slow prior tick when
   latency > interval (plausible on the 1 s run page with full-log payloads, see A06) — can
   resolve out of order; the OLDER response wins `setData`. Self-heals next tick; still wrong.
2. **Daemon-down renders silently blank on detail pages**: `workflows/[name]`,
   `workflow-runs/[id]`, `jobs/[name]`, and both gate pages destructure only `data` and discard
   `error` — a down daemon leaves permanently empty skeletons with no message, while all the
   LIST pages correctly show "Cannot reach the daemon".
3. No visibility pause — hidden tabs poll at 1–2 Hz forever (acceptable locally; note only).
4. `intervalMs` isn't in the effect deps — a dynamic interval would silently not apply (all call
   sites constant today; latent).

## Proposed fix

1. Sequence token in `tick`: capture `const seq = ++seqRef.current` before the await; apply
   `setData` only if still current (~4 lines).
2. Destructure `error` on the five detail pages and render the same "Cannot reach the daemon"
   message the list pages use (reuse the existing markup/class).
3. Add `intervalMs` to the effect deps (1 line).
4. (Optional) `document.visibilityState` pause.

## Acceptance criteria

- Delayed-response test on the hook: older response never overwrites newer.
- With the API fixture returning failures, every detail page shows the daemon-down message
  instead of a blank skeleton (extend `_dashboard-harness.mjs` fixtures accordingly, per the
  living-artifact rule).

## Test plan

Pure hook test for the sequence token (the hook is exported from ui.tsx); harness fixture +
visual-check for the error states.
