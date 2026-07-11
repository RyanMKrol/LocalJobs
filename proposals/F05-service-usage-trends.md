# F05: Service usage trends + proactive spend alerts — the full per-call time series already exists and is never shown

**Type**: feature · **Priority**: P2 · **Effort**: M
**Area**: api / dashboard / workflows
**Backlog cross-ref**: not tracked.

## Problem

The Integrations page shows current usage vs caps and the live rate — "now" only. But
`service_usage` stores one row per call with a timestamp (indexed `(service, ts)`, 38.5k rows
live) — the complete time series exists and the product never shows it. For a system whose
spend story is "the service quota is the spend governor", the owner cannot answer "am I
trending to blow the gemini monthly cap in week 2?" or "what did that workflow change do to
usage?". Cap-sizing (the monthly/30 rule) is done blind of actuals. And nothing proactively
warns — you find out when `QuotaExceededError` starts soft-failing runs, which is graceful but
silent-by-design.

## Design sketch

1. **API**: `GET /api/services/:name/usage-history?days=30` →
   `SELECT date(ts) d, COUNT(*) FROM service_usage WHERE service=? AND ts>=… GROUP BY d`
   (uses the existing index; new function in `store.ts`). Payload includes the effective
   dailyCap + monthlyCap and month-to-date total.
2. **UI**: in the existing per-service modal on Integrations — a 30-day CSS-flexbox bar strip
   (no chart library, per the dependency-light rule), bars tinted where the day exceeded the
   daily cap, plus the single highest-value number: **"month so far vs monthly cap, projected
   month-end at current run-rate"**.
3. **Proactive alert**: the weekly report-only `overrides-audit` pattern fits perfectly — a
   check (fold into that workflow or a sibling stage) that pushes when any `paid` service
   crosses 80% of its monthly cap before day 24. Uses existing `service_usage` reads + the
   T144 "have I notified this episode?" ledger pattern for dedup.

Retention interaction: A01 keeps ~13 months of `service_usage`, exactly so this feature has a
year of trend data.

## Acceptance criteria

- The modal shows 30 daily bars + the projection line for any service with history.
- A seeded scratch DB at 85% of monthly on day 10 → one push; re-running the check → no
  duplicate push.
- Mobile-check green (the strip must not overflow at 402px).

## Test plan

Store test for the group-by query + projection math; harness fixture + visual check; alert
dedup unit test.
