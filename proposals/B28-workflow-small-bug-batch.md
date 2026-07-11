# B28: Workflow small-bug batch — listening-digest month label, places slug collisions, un-timed fetches

**Type**: bug (batch) · **Priority**: P3 · **Effort**: S each
**Area**: workflows
**Affected files**: per item. Independently landable.

## 1. `listening-digest` labels the previous month's listening with the CURRENT month

`src/workflows/listening-digest/stages/listening-digest.ts` (~28–34, 174–176); schedule
`'0 6 1 * *'`. `monthKey(now)`/`monthLabel(now)` use the run date, but the data is Last.fm
`period=1month` (trailing ~30 days). Running July 1 at 06:00, June's listening is written as
`listening-digest-2026-07.md` headed "Listening Digest — July 2026". Compare
`workouts-progress` (same cadence), which correctly uses "most recently completed calendar
month" (`periodFromMonthOffset(now, 1)`).
**Fix**: key + label by the previous month (or retitle "trailing 30 days ending <date>" —
matching what the API actually returns). Old ledger keys are harmless (month keys never recur).

## 2. Places `writeMarkdown` slug collision silently overwrites profiles

`src/workflows/places/stages/llm-enrich.ts` (~312–313).
`slug = name.toLowerCase()...slice(0, 60) || place.cid` derives from the display name only. Two
same-named places — chains: two "Dishoom" branches — write the same `<slug>.md`; the second
silently overwrites the first, and BOTH ledger rows point `detail.markdown` at the same file.
The corpus loses a profile with no error anywhere.
**Fix**: suffix identity — `${slug}-${place.cid.slice(-6)}.md` — exactly as perfumes (`<id>.md`)
and plex-profiles (`slugFileName(ratingKey, slug)`) already do. One-time migration optional
(existing collisions, if any, self-heal on the next enrich of the clobbered place after an
unstick).

## 3. Outbound `fetch` without timeouts — worst in the two jobs with `timeoutMs: 0`

Raw-`fetch` clients pass no `AbortSignal`: `places/stages/enrich.ts` (~224), `hevy-sync.ts`
(~64), `listening-digest.ts` (~129, 148), `github-sync.ts` (~82), `stock-sector-lookup.ts`
(~66). Most jobs have a hard `timeoutMs` backstop — but **places-enrich and enrich-with-llm run
with `timeoutMs: 0`** (`enrich.job.ts:21`, `llm-enrich.job.ts:23`), so "each call is bounded"
rests entirely on undici/SDK defaults; a stalled streaming body can wedge the stage
indefinitely with no kill.
**Fix**: `AbortSignal.timeout(30_000)` on the raw fetches; and/or give the two places jobs a
real (generous) `timeoutMs` — they're ledger-resumable, so a kill is always safe.

## Acceptance criteria

1. A July-1 run produces `listening-digest-2026-06.md` titled June (or the retitled trailing
   form). 2. Two same-named places produce two distinct files; ledger rows point at distinct
   paths. 3. Every raw fetch in the listed sites carries a timeout signal; places jobs no longer
   run unbounded.

## Test plan

Unit tests: month-key derivation for a 1st-of-month timestamp; slug uniqueness for duplicate
names; grep-style assertion or per-client test for the AbortSignal (the fetch fakes in existing
tests can assert `init.signal` present).
