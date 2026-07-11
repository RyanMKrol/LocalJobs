# Q03: Keyboard-inaccessible dashboard controls — clickable `<span>` editors and `<th onClick>` sorting

**Type**: quality (a11y) · **Priority**: P3 · **Effort**: S
**Area**: dashboard
**Affected files**: `dashboard/app/workflows/[name]/page.tsx` (~1010, 1056), `dashboard/app/jobs/[name]/page.tsx` (~98), `dashboard/app/components/SortTh.tsx` (~12)

## Problem

- `<span className="schedule-edit-link" onClick>Edit</span>` — no `tabIndex`, no `role`, no key
  handler — at three sites: the schedule and concurrency editors on the workflow detail page and
  the timeout editor on the job page are **unreachable by keyboard**.
- `SortTh.tsx`: `<th onClick>` with no button semantics — sortable headers likewise.
- The `.toggle` spans are partially OK (focusable checkbox; Space bubbles a click) but
  mis-announce state via a readOnly checkbox.

The codebase already knows the right pattern — `CronBadge` (`ui.tsx` ~247–258) does
role/tabIndex/key handling properly, and a `.btn-link` class already exists (`globals.css`
~141).

## Proposed fix

- Replace the three Edit spans with `<button className="btn-link">Edit</button>`.
- `SortTh`: wrap the label in a `<button>` (or add `role="button"` + `tabIndex` + Enter/Space
  handler) and add `aria-sort` on the `<th>`.
- Give the toggle spans an accurate `role="switch"` + `aria-checked`.

## Acceptance criteria

- Tab reaches every editor and sort control; Enter/Space activates them.
- Visual appearance unchanged (visual-check before/after).

## Test plan

Visual-check + mobile-check; a FLOWS entry driving one editor via keyboard in the harness would
lock it in (optional).
