# B21: Two date-parse convention violations — Safari renders "Invalid Date" in the consumers modal; raw UTC shown in the Output section

**Type**: bug · **Priority**: P2 · **Effort**: S
**Area**: dashboard
**Affected files**: `dashboard/app/integrations/page.tsx` (~77), `dashboard/app/components/WorkflowOutputSection.tsx` (~109)
**Verified**: coordinator confirmed the `new Date(j.last_used + 'Z')` parse at integrations:77.

## Problem

CLAUDE.md gotcha: SQLite datetimes are UTC strings without `Z`; the dashboard appends `Z` when
parsing. The canonical implementation is `fmtTime` (`ui.tsx` ~73–78), which converts the space
separator to `T` **then** appends `Z`. Two sites bypass it:

1. `integrations/page.tsx:77`:
   `new Date(j.last_used + 'Z').toLocaleString()` → `new Date("2026-06-22 09:00:00Z")` — a
   non-ISO string (space separator). V8 accepts it; **Safari's parser rejects space-separated
   datetimes → "Invalid Date"** in the service-consumers modal on macOS/iOS Safari — the
   browser the owner's phone uses.
2. `WorkflowOutputSection.tsx:109` renders `item.updatedAt` **verbatim** — a raw UTC string, no
   local conversion, inconsistent with every other timestamp on the dashboard and off by 1–2 h
   for a UK owner with no UTC indication.

An audit of all other parse sites found `fmtTime`/`fmtRelative` used correctly everywhere else.

## Proposed fix

- `fmtTime(j.last_used)` at site 1.
- `fmtRelative(item.updatedAt)` (or `fmtTime`) at site 2.

Consider a lint-ish guard: grep-based test asserting no `new Date(` call in `dashboard/app/`
outside `ui.tsx`'s helpers, so the convention can't silently regress (cheap to add to the
existing `nav-check.test.ts`-style pure tests).

## Acceptance criteria

- Consumers modal shows a valid localized time in Safari.
- Output section timestamps match the localized format used everywhere else.

## Test plan

Unit-testable if the guard test is added; otherwise visual-check both surfaces after build.
