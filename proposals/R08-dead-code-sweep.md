# R08: Dead-code sweep — unreachable standalone-job path, orphaned DB-browser layer, never-imported MarkdownModal, ~90 lines of dead backlog CSS, a dead config field, and a script for a dead design

**Type**: refactor (deletion) · **Priority**: P3 · **Effort**: S–M
**Area**: core / db / dashboard / services / scripts
**All grep-verified by the review agents.**

## Items

1. **Dead standalone-job path (core)**: `runJob` (`src/core/executor.ts` ~73–80) has zero
   production call sites (T070 removed standalone runs); `notifyRun` (`notifier.ts` ~69–94) is
   called only from it; `notifyStage` (~112–134) is exported-but-uncalled since T189 (CLAUDE.md
   admits it); `RunStatus` includes `'queued'` that nothing ever writes (`createRun` inserts
   `'running'`) — `TERMINAL_RUN_STATUSES`, `classifyGates`, and the dashboard all carry an
   impossible status. Also reword `runJobForWorkflow`'s skip reason ("a standalone run of this
   job is already active" — standalone runs don't exist; the real trigger is another workflow's
   member run of a shared job).
2. **Orphaned DB-browser/canned-queries layer (db)**: `src/db/store.ts` ~2004–2152
   (`listDbTables`, `isKnownTable`, `browseTable`, `CANNED_QUERIES`, `listCannedQueries`,
   `runCannedQuery`) — only consumers are its own tests; the `/api/db/*` endpoints and `/db`
   page were deliberately removed in T230 but this ~150-line layer stayed. Delete (with its
   tests), or consciously restore the endpoints if the removal was accidental — decide, don't
   drift.
3. **`MarkdownModal.tsx` (dashboard, 96 lines) never imported** — and it carries richer
   frontmatter rendering (`renderFmValue`/`isFmEmpty`: null-highlighting, array joining) than
   the live `OutputRenderer.MarkdownOutputBody` copy — the acknowledged duplicate-
   `parseFrontmatter` split silently forked behavior. Delete the file and PORT `renderFmValue`
   into OutputRenderer (small behavior win from a deletion). Update CLAUDE.md, which documents
   MarkdownModal as a live shared component.
4. **Dead backlog-era CSS (~90 lines)**: `globals.css` ~303–397 (`.section-heading-summary`,
   `.caret-style-*`, `.dep-id-link`, `.task-row-highlight`, `.done-row`, `.task-expand-body`,
   `.review-toggle`, `.review-filter-bar`, pill kinds
   `reviewed/unreviewed/buildable/dep-waiting/human/blocked/in-progress`) — the backlog UI moved
   to the harness dashboard (:4791); per-class grep finds no markup users. Prune `Pill.tsx`'s
   kind catalog to the used kinds. Also: legacy hand-rolled DAG CSS (`.dag-inner`, `.dag-col`)
   unused since the React Flow migration; two separate `@media (max-width: 640px)` blocks vs the
   documented "responsive rules live in one place"; `:root` declared twice with the first mostly
   shadowed (fold).
5. **`fs` service dead `timeoutMs: 5_000`** (`src/services/fs.service.ts` ~26–28): by design
   `ServiceDefinition.timeoutMs` is only honored by clients that read
   `effectiveServiceTimeoutMs` — grep finds zero readers for `'fs'`, so the field (complete with
   comment and dashboard editability) changes nothing. Delete it, or wrap the sole consumer
   (`places/stages/resolve.ts` ~28) in a `Promise.race` timer if the wedged-mount case is worth
   guarding — decide, don't leave a lying knob.
6. **`scripts/create-dynamo-tables.mjs` provisions tables for a dead design**: creates
   `Listens`/`Projects` tables that nothing references (grep: only this script), for pipelines
   that were deleted (`cleanup-listens-spotify.ts` exists to purge the remnants) — and every
   DynamoDB write helper is policy-neutered anyway (throws immediately). The only live DynamoDB
   use is the perfumes READ of `PerfumeRatings`, which this script doesn't create. Delete or
   re-scope. While in `dynamodb.service.ts`: mark the deliberate unreachable code after the
   throws with an explicit comment, and throw loudly on key-ID-set-but-secret-missing (currently
   falls back to `''` → confusing signature error).

## Acceptance criteria

- `tsc`, `npm test`, dashboard build green after each deletion; grep confirms no references.
- CLAUDE.md file map + shared-components section updated (docs-as-Done).
- Net deletion ≈ 500+ lines.

## Test plan

Deletion-driven: the compiler and existing suites are the net. Port-of-`renderFmValue` gets a
small rendering test in `OutputRenderer.test.ts`.
