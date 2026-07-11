# Q05: Dashboard nits batch — ten small correctness/consistency fixes

**Type**: quality (batch) · **Priority**: P3 · **Effort**: S
**Area**: dashboard
**Affected files**: per item; mostly `dashboard/app/ui.tsx`, `lib/api.ts`, assorted pages

## Items

1. **`fmtDuration` lacks hours** (`ui.tsx` ~64–71): a 2 h 5 m run renders "125m 12s"; the
   monthly recommender workflows plausibly exceed an hour. Add an `Xh Ym` tier.
2. **`fmtRelative` NaN/skew guards** (`ui.tsx` ~80–91): lacks `fmtTime`'s already-ISO guard
   (`"…Z" + "Z"` → NaN → "NaNs ago" if ever fed ISO) and shows "-2s ago" under clock skew.
   Latent; make the pair consistent and clamp negatives to "just now".
3. **Bare `<span className="pill …">`** at `admin/page.tsx:190` — violates the documented T268
   rule; line 117 of the SAME file uses `<Pill>` for the identical status.
4. **Bare `badge` spans instead of `<StatusBadge>`** at `workflows/[name]/page.tsx:1088`,
   `page.tsx:185,255`, `workflows/page.tsx:120`, `StageIoLists.tsx:143`. Root cause:
   `StatusBadge` is typed `{ status: RunStatus }` and workflow statuses include `'partial'` —
   hence casts and bare spans. Widen the prop to `RunStatus | WorkflowRunStatus` (the label and
   emoji maps already cover `partial`) and adopt it everywhere.
5. **`Workflow` interface missing `category`** (`api.ts` ~63–95) — `workflows/page.tsx:14`
   casts around it. Add the field (T292).
6. **Inconsistent path encoding in api.ts**: 13 endpoints `encodeURIComponent` the name; `job()`,
   `jobRuns()`, `runWorkflow()`, `toggleWorkflow()`, `stuck(job)` interpolate raw names — safe
   with slug names today, inconsistent by design. Encode everywhere.
7. **`setTimeout(() => setBusy(false), 1200)` fires after unmount**
   (`workflows/[name]/page.tsx:952`, `workflow-runs/[id]/page.tsx:60`) — clear on unmount or use
   the R05 `useAction` hook, which owns this.
8. **`groupByCollection(active)` computed 3× per render** (`workflows/[name]/page.tsx`
   ~502–515) — memoize once; folds into the R05 extraction.
9. **Five bespoke fetch functions re-implement `post()` + server-error-body parsing**
   (`api.ts` ~544–604) — extract one `postWithServerError<T>()`.
10. **Modal fetch failures silently close the modal** (`StageIoLists.tsx:184`
    `.catch(() => setModal(null))`; `WorkflowOutputSection.tsx` ~61–63): click View → modal
    flashes and vanishes with no explanation. Render an in-modal error state instead.

## Acceptance criteria

Each fix visually verified (visual-check) or unit-tested where pure (1, 2); no bare
pill/badge spans remain (grep); `tsc` green with the widened StatusBadge type replacing the
casts.
