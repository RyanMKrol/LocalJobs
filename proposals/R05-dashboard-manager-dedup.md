# R05: Dashboard manager components — ~740 lines copy-pasted across 4 managers in a 1,137-line page; the busy/err handler block is duplicated 14×

**Type**: refactor · **Priority**: P2 · **Effort**: M
**Area**: dashboard
**Affected files**: `dashboard/app/workflows/[name]/page.tsx` (the whole manager section), new files under `dashboard/app/components/`

## Problem

`workflows/[name]/page.tsx` is 1,137 lines — 4× the next-largest page — because four manager
components live inline:

- `TvRecsManager` (~65–231) vs `MovieRecsManager` (~239–405): **~95% identical** (167 lines
  each). Real differences: 4 API method names, TMDB URL segment (`/tv/` vs `/movie/`), noun,
  heading level. State machine (`busy/busyAll/err/sortCol/sortDir`), sorting, active/ignored
  split, tables, IgnoredSection — byte-similar.
- `MovieGapsManager` (~415–620, 205 lines) vs `MissingSeasonsManager` (~642–845, 204 lines):
  same grouped-table shape (group header + "Ignore all"/"Un-ignore all" + per-item buttons +
  IgnoredSection); differ in grouping key, item key type, columns. ~80% overlap.
- The `setBusy → setErr(null) → await api → refetch → catch → finally` handler block appears
  **14 times**.

This is the documented shared-component convention (T268) being violated at scale, and it's the
same copy-paste pattern that produced the B11 class of divergence in the workflow layer.

## Proposed fix

Extract to `dashboard/app/components/` (per convention, documented in CLAUDE.md in the same
change):

1. `RecsManager<T>` parameterized by
   `{ heading, noun, tmdbPath: 'tv'|'movie', fetch, ignore, unignore, unignoreBulk }` —
   collapses 334 lines → ~190.
2. `GroupedGapsManager<T>` parameterized by `groupBy/itemKey/columns` + the 4 API fns — for the
   other pair.
3. A tiny `useAction(fn)` hook owning busy/err state — kills the 14 handler copies (reusable
   by B20's error-surfacing work; implement together).

Even without the generics, just MOVING the four managers out of the page file drops it to a
reasonable ~360 lines — do that first if the generic step stalls.

Note (cross-ref backlog T469): the owner already has a pending task to split these managers onto
separate workflow detail pages after the movie-workflow split (T467/T468) — coordinate: extract
components first, then T469 just re-homes them.

## Acceptance criteria

- Pixel-equivalent rendering of all four managers (visual-check before/after screenshots).
- One implementation each of the recs-manager and grouped-gaps shapes; handler pattern exists
  once.
- `_dashboard-harness.mjs` untouched or updated in the same change (living-artifact rule);
  mobile-check green.

## Test plan

Existing StageIoLists/OutputRenderer-style pure tests unaffected; rely on visual-check +
mobile-check + the fixtures already exercising these managers.
