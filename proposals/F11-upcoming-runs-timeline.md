# F11: Consolidated upcoming-runs view — "what happens tonight?" currently means scanning 16 rows of cron badges

**Type**: feature · **Priority**: P3 · **Effort**: S
**Area**: dashboard (+ optional api)
**Backlog cross-ref**: not tracked.

## Problem

The Workflows list shows `next_run` per row (the data is already exposed via the scheduler's
`nextRun()`), but answering "what happens tonight / this week?" means mentally sorting 16 rows
of cron badges across category sections. For a glanceable appliance — especially the
phone-check use case — a chronological strip is the missing view.

## Design sketch

Pure frontend for the 24-hour case (~50 lines): on the Overview page, sort enabled workflows by
`next_run`, group by day, render `HH:mm · name` rows — a list, not a calendar grid
(mobile-first). Disabled workflows excluded; a workflow currently running shows its live state
instead of a time.

v2 (optional, needs API): expose the next K fire times per cron (croner's `nextRuns(k)`) from
`GET /api/workflows` so the strip can show a full week including multiple fires of the dailies.

Update `_dashboard-harness.mjs` fixtures/PAGES in the same change; mobile-check + visual-check.

## Acceptance criteria

- Overview shows an "Upcoming" strip ordered chronologically, correct across midnight, empty
  state boxed per the `.empty-state-panel` convention when everything is disabled.
- No layout overflow at 402px.

## Test plan

Fixture-driven visual check; a pure test for the sort/group helper if extracted.
