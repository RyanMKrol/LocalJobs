# F15: Dashboard UX batch — toggle feedback, log tail/auto-scroll, per-run log search, stage-io poll fan-out

**Type**: feature (batch) · **Priority**: P3 · **Effort**: S–M
**Area**: dashboard

## Items

1. **No immediate toggle feedback**: enabled/notify/certified toggles wait for the 3 s poll to
   reflect — a click appears dead, inviting double-clicks (and with B20's silent errors, a real
   failure is indistinguishable from latency). Optimistic flip with rollback-on-error, or a
   per-toggle busy spinner (the R05 `useAction` hook is the natural home).
2. **No log tail/auto-scroll on the run page** — the primary live surface (1 s poll) requires
   manual scrolling as content grows. Add a "follow" toggle (default on while the run is
   `running`) that pins the view to the newest line, disengaging on manual scroll-up — the
   standard tail UX. Pairs with A06 (incremental fetch).
3. **No text search on per-run logs** — the global Logs page has search; the run page has level
   filters only. Under the verbose-logging convention a single run can be thousands of lines;
   a client-side substring filter input is cheap and high-value.
4. **Stage I/O poll fan-out**: each `StageIoBlock` polls its own `/stage-io?job=` at 5 s —
   "All stages" on movie-recommendations = 12 requests/5 s on top of the run + workflow polls.
   Add a `?all=true` variant returning every stage's lists in one response; the panel makes one
   poll. (Tolerable today; fix opportunistically with A06.)
5. For the record, measured polling budget (fine by convention, listed for context): Overview
   ≈ 85 req/min; a workflow-run page ≈ 42 req/min + stage-io fan-out.

## Acceptance criteria

- Toggles reflect instantly and roll back visibly on error.
- A live run auto-follows; scrolling up stops following; a "jump to latest" chip returns.
- Typing in the run-log filter narrows lines client-side with the level filters still applied.
- The stage-io panel issues one request per tick regardless of stage count.

## Test plan

Harness FLOWS entries for follow + filter; visual/mobile checks; API shape test for
`?all=true`.
