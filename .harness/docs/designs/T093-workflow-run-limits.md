# T093 — Design: workflow run-limits via framework-tracked input lineage

**Status:** IMPLEMENTED by T094 (the design held; see implementation notes below).
**Author of decisions:** interview 2026-06-22 (see "Decisions already made").

> **Implementation notes (T094).** The design was followed as written, with three
> immaterial deviations: (1) the additive migration (§4.7) was extracted into an
> exported `migrateRunLimitLineage(db)` in `src/db/index.ts` (mirroring
> `migrateDropJobColumns`) so it has its own unit test, rather than living inline in
> `openDb()`. (2) `distinctRoots`/`rootCount` (listed under §4.1 store additions)
> were not needed by the selection path and were not added — `selectPendingRoots`
> + `getWorkflowRunRoots` suffice. (3) The places enrich/llm stages pass an explicit
> `rootKey: cid` (resolution rule 1) rather than relying on `parentKey` inheritance
> (rule 2); rule-2 inheritance is still implemented + unit-tested via a synthetic
> fan-out fixture. Verified end-to-end with a dry-run perfumes `find-url` pass on a
> scratch DB (limit=1 → only the 1 selected perfume processed; 0 paid calls).

## 1. Problem & goal

Today a manual or scheduled workflow run processes **everything outstanding** —
every pending work item at every stage. We want a manual run to be **capped at N
originating inputs**: "run the perfumes workflow for just 1 perfume", "resolve +
enrich just 5 places". The cap is on the *roots* (the originating inputs), not on
per-stage item counts: once a root is selected, **all** fan-out work derived from
it runs to completion.

> Example (illustrative — the example workflows are 1:1 today): limit = 1 means
> one root perfume → the 3 "similar" perfumes it spawns → the 9 pages those spawn
> → the 27 files those spawn all run. N bounds the *roots*, not the descendants.

This is deliberately different from the **existing** per-stage `runLimit`
(`PERFUMES_RUN_LIMIT`, `PLACES_RESOLVE_LIMIT`): those cap *each stage's* item
count independently and are lineage-blind, so stage A might process items 1–5
while stage B processes items 3–7 — no notion of "the same N originating inputs
flowing through the whole pipeline". The new limit is lineage-aware end-to-end.

### Decisions already made (interview 2026-06-22)

- **(a) N counts ORIGINATING inputs.** All fan-out derived from those N roots runs
  to completion. The limit bounds roots, never descendants.
- **(b) Manual run-time option only.** Chosen when clicking *Run* / via the API.
  **Scheduled runs stay unlimited** (no limit ever attached by the scheduler).
- **(c) Lineage is FRAMEWORK-TRACKED** via a root/lineage key on `work_items`
  that the framework threads and enforces across stages; each job declares each
  produced item's parent so the root propagates through fan-out.

## 2. Glossary

| Term | Meaning |
|---|---|
| **root** | An originating input item. For perfumes a `perfume.id`; for places a saved-place `cid`. Identified by a `root_key`. |
| **root_key** | The `item_key` of the root an item descends from. For a root item, `root_key == item_key`. Propagates down every stage. |
| **parent_key** | The immediate upstream item this one was derived from (for fan-out). Optional; only needed to *inherit* a root when a stage changes keys or fans out. |
| **root stage** | The first member job (in topological order) that declares `inputKeys()` — i.e. the first stage that enumerates per-item identities. Its input keys are the candidate roots. |
| **allowlist / selected roots** | The frozen set of `root_key`s a limited run is permitted to touch. `null` ⇒ unlimited (process everything — today's behaviour). |

## 3. Current-state facts this design builds on

(Verified against the code while authoring — cited so T094 can trust them.)

- `work_items` PK is `(job_name, item_key)`; columns `status, attempts, detail,
  created_at, updated_at`; index `idx_work_items_status(job_name, status)`
  (`src/db/schema.sql`).
- **The child process writes its own `work_items`.** A job's `run(ctx)` executes
  in the `runJob.ts` child, and jobs call `markWorkItem`/`isWorkItemDone`/
  `getWorkItem` directly (`src/db/store.ts`). "Parent is sole writer" applies only
  to the run-lifecycle tables (`runs`/`run_logs`/`workflow_runs`/
  `workflow_run_logs`), which the executor writes from NDJSON events. **So the
  child already has full DB access** — a key enabler below.
- The child is spawned as `node --import tsx src/runJob.ts <jobName>` with
  `{ env: process.env }` (`src/core/executor.ts` → `executeAttempt`). The only
  parent→child channels are **argv** (currently just `jobName`) and **env**.
- Jobs read their input from a file and filter to "not done":
  `loadPerfumes().filter(p => !isWorkItemDone(JOB, p.id, maxAttempts))`
  (`perfumes/find-url.ts`), and key each stage by `p.id`.
- **Places changes keys across stages**: `cid-to-place-id-resolver` is keyed by
  `cid`; `places-enrich`/`enrich-with-llm` are keyed by `place_id`. So a
  `place_id` item's *root* is the `cid` it came from — the real "lineage isn't
  just the same key everywhere" case. `places-ingest` (stage 1) is a pure CSV→JSON
  transform with **no** per-item ledger.
- `inputKeys()` already exists on `JobDefinition` (optional) but is currently used
  **only** by the manual prune feature. No example job implements it yet.
- Run wiring: `POST /api/workflows/:name/run` → `getWorkflowDefinition` →
  `runWorkflow(def, 'manual')` (fire-and-forget). The DAG runs in one in-process
  call: `runWorkflow → executeDag → runJobForWorkflow → runAttempts →
  executeAttempt` (`workflow-executor.ts`, `dag.ts`, `executor.ts`).
- `workflow_runs` has no per-run options column today.
- Dashboard Run button: `workflows/[name]/page.tsx` calls
  `api.runWorkflow(name)` → `post('/api/workflows/${name}/run')`; `post(path,
  body?)` already supports a JSON body.

## 4. Design

### 4.1 — (1) Lineage data model

Add two **nullable** columns to `work_items`:

```sql
ALTER TABLE work_items ADD COLUMN root_key   TEXT;  -- originating input this item descends from
ALTER TABLE work_items ADD COLUMN parent_key TEXT;  -- immediate upstream item (for fan-out); NULL for roots
CREATE INDEX IF NOT EXISTS idx_work_items_root ON work_items(job_name, root_key);
```

`schema.sql` gains the same columns + index for fresh DBs; `src/db/index.ts` adds
them idempotently to an existing DB (see §4.7).

**How a root is established.** The **root stage** marks each item with
`root_key == item_key` (it IS the originating input; `parent_key` NULL). With the
default rule below, the root stage needs **no** lineage code at all — omitting
`rootKey` defaults it to `item_key`.

**How the root propagates through fan-out / key changes.** A downstream job, when
it marks an item it *derived* from an upstream item, passes the parent so the
root is inherited:

```ts
markWorkItem('places-enrich', placeId, 'success', {
  rootKey: cid,            // explicit: the originating input
  parentKey: cid,          // immediate upstream item
  parentJob: 'cid-to-place-id-resolver',
  detail: { … },
});
```

**Root resolution rule** (in `markWorkItem`, evaluated in order):

1. If `rootKey` is given → use it.
2. Else if `parentKey` is given → look up the parent row
   (`parentJob` defaults to `jobName`) and inherit its `root_key`
   (falling back to `parentKey` itself if the parent row is missing).
3. Else → `root_key = item_key` (this item is its own root).

So perfumes (same key every stage) needs **zero** lineage args — every stage's
`item_key` already equals the root `p.id`, so rule 3 fills `root_key = item_key`
correctly. Only key-changing / fan-out stages (places enrich/llm) pass `parentKey`
or `rootKey`.

**`store.ts` additions**

```ts
// markWorkItem gains lineage opts (back-compatible — all optional):
export function markWorkItem(
  jobName: string, itemKey: string, status: WorkStatus,
  opts: { attempts?: number; detail?: unknown;
          rootKey?: string; parentKey?: string; parentJob?: string } = {},
): void
// → writes root_key (resolved per the rule above) and parent_key.

// WorkItemRow gains: root_key: string | null; parent_key: string | null

// Enumerate / count distinct roots seen for a set of member jobs:
export function distinctRoots(jobNames: string[]): string[]
export function rootCount(jobNames: string[]): number

// Selection helper (used by the executor at run start — see §4.2):
export function selectPendingRoots(
  members: string[], entryJob: string, candidateRootsInOrder: string[],
  n: number, minAttempts: number,
): string[]
```

`selectPendingRoots` keeps only **pending** roots, in `candidateRootsInOrder`
order, and returns the first `n`. A root is **pending** iff it is not yet fully
done:

```
pending(root) =  !isWorkItemDone(entryJob, root, minAttempts)         // entry not finished
              || existsNotDoneRow(members, root, minAttempts)         // any descendant still outstanding
```

where `existsNotDoneRow` is one query:

```sql
SELECT 1 FROM work_items
 WHERE job_name IN (<members>) AND root_key = ?
   AND NOT (status IN ('success','ignored') OR (status='failed' AND attempts >= ?))
 LIMIT 1
```

This unifies fresh and resumed runs: on a brand-new DB no rows exist, so
`pending(root)` is true via the entry-stage clause and the **first N input keys**
are selected; on a resumed run, fully-done roots are skipped and selection
advances to the next outstanding ones.

> **Superseded by T163.** The `pending(root)` formula above had a real bug: a root
> whose entry stage was done but whose LATER stages simply had no ledger row yet
> (never attempted) was wrongly treated as "fully done" by this formula and
> excluded from selection — a limited run could silently select 0 roots and no-op.
> T163 replaced this with a 4-branch check keyed on propagation through the
> TERMINAL stage, not just the entry stage — see `isRootPending` in
> `src/db/store.ts` and root `CLAUDE.md`'s "Input lineage + manual run-limits
> (T094)" section for the current, correct rule. Kept here for historical record;
> do not treat the formula above as current.

### 4.2 — (2) Limit semantics + selection

- **Deterministic selection.** With limit `N`, the framework selects the **first
  N pending roots** in the root stage's `inputKeys()` order (which is the input
  file order — stable). No randomness; the same DB + same input file ⇒ same
  selection.
- **Selection happens once, in the parent (daemon), at run start** — before any
  stage spawns — inside `runWorkflow`:
  1. Find the **root stage** = first member (topological/wave order from the DAG)
     whose `JobDefinition.inputKeys` is defined.
  2. `candidates = await rootStage.inputKeys()`.
  3. `selected = selectPendingRoots(members, rootStage.name, candidates, N, minAttempts)`.
  4. Freeze `selected` as the run's allowlist; persist on the `workflow_runs` row
     (`run_limit = N`, `selected_roots = JSON(selected)` — see §4.7).
- **Every stage filters its input to `root_key ∈ allowlist`.** Uniform: the root
  stage filters `item_key ∈ allowlist` (root_key == item_key there); downstream
  stages compute each candidate item's root (they know their own lineage — e.g.
  places-enrich maps `place_id → cid` from `resolved.json`) and keep it iff
  `ctx.rootAllowed(root)`.
- **Stages topologically *before* the root stage run unfiltered.** They establish
  the universe of roots rather than consuming it (e.g. `places-ingest` parses all
  CSVs → `places.json`; it's a cheap, idempotent bulk import). The limit applies
  from the root stage onward. This is stated as intended behaviour, not a bug.
- **Edge cases**
  - `N <= 0` or non-integer → rejected at the API (§4.3), never reaches the executor.
  - `N` larger than the pending-root count → selects all pending roots (no error).
  - **No member declares `inputKeys()`** → the workflow cannot be limited; the API
    rejects the request with a clear 400 (§4.3). (Unlimited runs are unaffected.)
  - `repeatUntilStable`: the allowlist is frozen **once** at run start and reused
    across cycles (it lives on the `workflow_runs` row), so cycle 2+ keeps the same
    N roots. No re-selection mid-run.

### 4.3 — (3) Invocation: API + executor threading

**API** (`src/api/server.ts`, the existing `POST /api/workflows/:name/run`):

```ts
if (method === 'POST' && parts[1] === 'workflows' && parts[3] === 'run') {
  const def = getWorkflowDefinition(parts[2]);
  if (!def) return json(res, 404, { error: 'workflow not found' });
  const body = await readBody(req);                  // body is optional today
  let limit: number | undefined;
  if (body.limit !== undefined && body.limit !== null && body.limit !== '') {
    limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1)
      return json(res, 400, { error: 'limit must be a positive integer' });
    if (!hasRootStage(def))                          // no member declares inputKeys()
      return json(res, 400, { error: `workflow "${def.name}" cannot be limited (no stage declares input keys)` });
  }
  runWorkflow(def, 'manual', { limit }).catch((e) => console.error('[api] workflow run error', e));
  return json(res, 202, { ok: true, message: 'workflow run started', limit: limit ?? null });
}
```

`hasRootStage(def)` = `def.jobs.some(j => getJobDefinition(j.job)?.inputKeys)`.
The mutation guard (`authoriseMutation`) is unchanged — same endpoint, now reads a
body. The **scheduler** (`src/core/scheduler.ts`) keeps calling
`runWorkflow(def, 'schedule')` with **no opts** ⇒ always unlimited (decision (b)).

**Executor threading** (`src/core/workflow-executor.ts`):

```ts
export async function runWorkflow(
  def: WorkflowDefinition,
  trigger: 'schedule' | 'manual',
  opts: { limit?: number } = {},
): Promise<WorkflowRunResult>
```

- Compute `selectedRoots: string[] | null` at run start (§4.2). `null` when
  `opts.limit` is unset.
- `createWorkflowRun(def.name, trigger, opts.limit ?? null, selectedRoots)` →
  persists `run_limit` + `selected_roots` (§4.7).
- Log it: `Workflow "x" started · limited to N originating input(s): a, b, …`
  (or `· unlimited`).
- Thread the **workflow run id** to each member child. The cleanest channel given
  the child already has DB access: pass only `LOCALJOBS_WORKFLOW_RUN_ID` via env;
  the child reads the frozen `selected_roots`/`run_limit` from the
  `workflow_runs` row. So the threading path is:
  `runJobForWorkflow(jd, workflowRunId, signal)` → `runAttempts(...)` →
  `executeAttempt(...)` → `spawn(..., { env: { ...process.env,
  LOCALJOBS_WORKFLOW_RUN_ID: workflowRunId } })`. **No new positional args**;
  `workflowRunId` is already in scope along that whole chain.
  - *Alternative considered:* serialise the allowlist itself into
    `LOCALJOBS_ROOT_ALLOWLIST` env (JSON). Avoids one DB read but risks `ARG_MAX`
    for large N and duplicates the source of truth. Rejected for the primary
    design; fine as a micro-opt if a DB read per child is ever a concern. (N is
    small for limited runs, so a single indexed read is negligible.)

### 4.4 — (4) Job contract: reading the allowlist + declaring lineage

**`JobContext`** gains two read helpers (`src/core/types.ts`):

```ts
export interface JobContext {
  log(message: string, level?: LogLevel): void;
  progress(pct: number, message?: string): void;
  /**
   * The active originating-input allowlist for a LIMITED run, or null when the
   * run is unlimited (the default — process everything). When non-null a job
   * MUST skip any item whose ROOT key is not in this set.
   */
  selectedRoots(): ReadonlySet<string> | null;
  /** Convenience over selectedRoots(): true when unlimited OR rootKey is selected. */
  rootAllowed(rootKey: string): boolean;
}
```

**`runJob.ts` (child) builds these from the DB.** It reads
`process.env.LOCALJOBS_WORKFLOW_RUN_ID`; if present, loads the run's
`selected_roots` (new `getWorkflowRunRoots(id): string[] | null` in `store.ts`)
into a `Set`. `selectedRoots()` returns that set (or `null`); `rootAllowed(r) =
!set || set.has(r)`. When the env var is absent (standalone job, or unlimited
run where `selected_roots` is NULL), `selectedRoots()` is `null` and
`rootAllowed` is always `true` — **today's behaviour, unchanged**.

```ts
// runJob.ts (sketch)
const wfRunId = process.env.LOCALJOBS_WORKFLOW_RUN_ID || null;
const roots = wfRunId ? getWorkflowRunRoots(wfRunId) : null;   // string[] | null
const rootSet = roots ? new Set(roots) : null;
const ctx: JobContext = {
  log, progress,
  selectedRoots: () => rootSet,
  rootAllowed: (r) => !rootSet || rootSet.has(r),
};
```

**Declaring lineage** is via `markWorkItem` opts (§4.1) — not a new ctx method —
because the job already calls `markWorkItem` at the exact point it knows an item's
identity and parent. No new `JobDefinition` field is required: root enumeration
reuses the existing `inputKeys()`. (An explicit opt-in marker like `rootStage:
true` was considered but rejected — "first member with `inputKeys()`" is
unambiguous and needs no new surface.)

### 4.5 — (5) Backward compatibility & minimal job changes

**Unlimited runs are byte-for-byte unchanged.** No env var ⇒ `selectedRoots()`
null ⇒ `rootAllowed` always true ⇒ every `.filter(p => ctx.rootAllowed(root))` is
a no-op. `markWorkItem` with no lineage opts writes `root_key = item_key` (rule 3)
into a column nothing reads when unlimited. The migration backfills existing rows
to `root_key = item_key`. So **places + perfumes keep working with no behavioural
change** when no limit is set.

Minimal changes to make the two example workflows *limit-aware*:

**perfumes** (same key `p.id` every stage — the easy case):
- `find-url.job.ts`: add `inputKeys: () => loadPerfumes().map(p => p.id)` →
  makes find-url the root stage.
- Each stage's `run` (`find-url`, `fetch`, `parse`, `build`): add one clause to
  the existing `todo`/pending filter — `&& ctx.rootAllowed(p.id)`. Nothing else;
  `markWorkItem` already keys by `p.id`, so rule 3 sets `root_key = p.id` for free.

**places** (key changes `cid → place_id` — the lineage case):
- `cid-to-place-id-resolver.job.ts` (the root stage, keyed by `cid`): add
  `inputKeys: () => loadPlaces().filter(p => p.cid).map(p => p.cid!)`; filter
  `todo` by `ctx.rootAllowed(p.cid!)`. `markWorkItem(JOB, cid, …)` already implies
  `root_key = cid` (rule 3). `places-ingest` (before the root stage) is left
  unfiltered — correct.
- `places-enrich.job.ts` + `enrich-with-llm.job.ts` (keyed by `place_id`): they
  read `resolved.json`, so they know each `place_id`'s originating `cid`. Two
  small edits each: (a) skip items where `!ctx.rootAllowed(cidOf(placeId))`;
  (b) pass lineage when marking — `markWorkItem(JOB, placeId, status, { rootKey:
  cid, parentKey: cid, parentJob: 'cid-to-place-id-resolver', … })`.

These job edits live in the gitignored example workflows; T094 makes them in the
same change and verifies with cached `data/` + the scratch DB (no paid calls).

### 4.6 — (6) UI

`dashboard/app/workflows/[name]/page.tsx` — beside the existing **▶ Run now**
button add a small number input (`min=1`, `placeholder="all"`,
`title="Limit to N originating inputs (blank = all)"`). On run:

```ts
const [limit, setLimit] = useState('');          // '' = unlimited
async function run() {
  setBusy(true);
  try { await api.runWorkflow(name, limit ? Number(limit) : undefined); }
  finally { setTimeout(() => setBusy(false), 1200); }
}
```

`api.ts`: `runWorkflow: (name, limit?: number) => post('/api/workflows/${name}/run',
limit !== undefined ? { limit } : undefined)`. The input is rendered **only** when
the workflow has a limitable root stage — surface a boolean `limitable` on the
workflow view (`workflowView`/`gatesForWorkflow` neighbourhood in the API), so a
non-limitable workflow shows just the plain Run button. The input must survive the
402px mobile check (`globals.css` already wraps the header actions; keep the input
narrow, e.g. `width: 4.5rem`).

**Workflow-run detail** (`workflow-runs/[id]/page.tsx`): when the run carries a
limit, show a small badge near the status — e.g. `limited · N originating inputs`
— read from the run row (`WorkflowRun.run_limit`, plumbed through the
`/api/workflow-runs/:id` payload + `app/lib/api.ts` type). Optional but cheap and
makes a limited run self-explanatory.

### 4.7 — (7) Migration

Additive, idempotent, in `src/db/index.ts` `openDb()` (mirrors the existing
`workflow_run_id` / `limits_overridden` additive migrations):

```ts
// work_items lineage (T094)
const wiCols = db.prepare('PRAGMA table_info(work_items)').all() as { name: string }[];
if (!wiCols.some(c => c.name === 'root_key'))   db.exec('ALTER TABLE work_items ADD COLUMN root_key TEXT');
if (!wiCols.some(c => c.name === 'parent_key')) db.exec('ALTER TABLE work_items ADD COLUMN parent_key TEXT');
db.exec('UPDATE work_items SET root_key = item_key WHERE root_key IS NULL'); // backfill: each existing item is its own root
db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_root ON work_items(job_name, root_key)');

// workflow_runs per-run limit + frozen selection (T094)
const wrCols = db.prepare('PRAGMA table_info(workflow_runs)').all() as { name: string }[];
if (!wrCols.some(c => c.name === 'run_limit'))      db.exec('ALTER TABLE workflow_runs ADD COLUMN run_limit INTEGER');   // NULL = unlimited
if (!wrCols.some(c => c.name === 'selected_roots')) db.exec('ALTER TABLE workflow_runs ADD COLUMN selected_roots TEXT'); // JSON array; NULL = unlimited
```

`schema.sql` gets the same columns + index so a fresh DB matches. **Column name
is `run_limit`, not `limit`** — `LIMIT` is a SQL keyword and bare `limit` would
need quoting everywhere. `createWorkflowRun` is extended to insert `run_limit` +
`selected_roots`; `WorkflowRunRow` (types.ts) + the dashboard `WorkflowRun` type
gain `run_limit: number | null`.

## 5. Worked traces

**perfumes, limit = 1, fresh DB** — input `[p1, p2, p3]`:
- Run start: root stage = `perfumes-find-url`; `inputKeys() = [p1,p2,p3]`; all
  pending; `selected = [p1]`; persist `run_limit=1, selected_roots=["p1"]`.
- find-url: `todo` filtered by `rootAllowed(id)` ⇒ only `p1`; marks
  `(find-url, p1)` → `root_key=p1`.
- fetch/parse/build: each filters `rootAllowed(p.id)` ⇒ only `p1`; each marks
  `(stage, p1)` → `root_key=p1` (rule 3). `p2,p3` never touched.

**places, limit = 2, resumed DB** — `cid`s `[c1..c100]`, `c1,c2` already fully
enriched:
- Root stage = `cid-to-place-id-resolver`; `inputKeys()=[c1..c100]`;
  `selectPendingRoots` skips done `c1,c2` ⇒ `selected=[c3,c4]`.
- ingest: unfiltered (rebuilds `places.json`).
- resolver: filters `rootAllowed(cid)` ⇒ resolves `c3,c4` → place_ids `x3,x4`;
  marks `(resolver, c3)`/`(resolver, c4)` → `root_key=c3`/`c4`.
- enrich: for `x3`, `cidOf(x3)=c3`, `rootAllowed(c3)` true ⇒ enrich; marks
  `(enrich, x3)` with `rootKey=c3`. Other place_ids (root not in allowlist) skipped.
- llm-enrich: same, keyed by place_id, `root_key=c3`/`c4`.

**hypothetical fan-out (forward-looking)** — stage A turns root `c3` into 3
children; A marks `(A-out, k1){root=c3,parent=c3}`, …; stage B reads those 3,
each `rootAllowed(rootOf(k))` ⇒ all run; B fans each to 3 grandchildren marked
`{rootKey=c3}` (inherited via `parentKey`). All 9 descendants of `c3` run; none of
`c4`'s unless `c4` was also selected. The example workflows don't fan out yet, so
this path is specified but unexercised until a fan-out job exists.

## 6. Smallest viable first cut

Ship in this order; each step is independently green (`tsc`/`test`):

1. **DB**: migration + `schema.sql` columns/index (§4.7). Pure additive; no
   behaviour change. Unit test: open a DB with pre-existing rows, assert backfill
   `root_key = item_key` and the new columns/index exist.
2. **store.ts**: `markWorkItem` lineage opts + resolution rule; `WorkItemRow`
   fields; `getWorkflowRunRoots`; `selectPendingRoots`; `createWorkflowRun`
   carrying `run_limit`/`selected_roots`. Unit-test the resolution rule (explicit
   / inherit-from-parent / default-to-key) and `selectPendingRoots`
   (fresh → first N; resumed → skips done; N > pending → all).
3. **types + child + executor**: `JobContext.selectedRoots`/`rootAllowed`;
   `runJob.ts` reads `LOCALJOBS_WORKFLOW_RUN_ID` → builds the helpers;
   `runWorkflow(def, trigger, { limit })` selects + persists + sets the env on the
   spawned child. Unit-test selection + that an unset env ⇒ `rootAllowed` always
   true (back-compat).
4. **API**: parse/validate `{ limit }`; `hasRootStage` guard; pass to
   `runWorkflow`.
5. **Example jobs**: add `inputKeys()` to the two root stages + `rootAllowed`
   filters; places enrich/llm lineage on `markWorkItem`. Verify with cached
   `data/` + scratch DB (a `dryRun` perfumes pass; no paid calls).
6. **UI**: limit input on the Run control + run-detail badge; `npm --prefix
   dashboard run build` + `node dashboard/scripts/mobile-check.mjs`.

**Truly minimal version** if time-boxed: steps 1–4 + perfumes only (the same-key
case needs no `markWorkItem` lineage args), deferring places' key-changing lineage
and the fan-out contract. That already delivers "run the perfumes workflow for
just N perfumes" end-to-end.

## 7. Risks & open questions

- **Key-changing stages MUST declare lineage** (places enrich/llm). If a derived
  item is marked without `rootKey`/`parentKey`, rule 3 makes it its *own* root —
  then `rootAllowed(thatKey)` is false under a limit (key ∉ allowlist) and the
  item is silently skipped, *or* (unlimited) it pollutes `distinctRoots`. This is
  the single biggest correctness trap. Mitigation: code review + a unit test
  asserting `places-enrich` rows inherit the `cid` root; consider a dev-only
  warn-log when a workflow-member item is marked with a self-root whose key isn't
  in the root stage's `inputKeys()`.
- **"Pending" definition is a judgement call.** The chosen rule (entry-not-done OR
  any-descendant-not-done) re-selects partially-finished roots so their downstream
  work resumes. A simpler "entry-not-done only" first cut is acceptable but can
  strand a root whose entry is done yet a paid downstream stage was cap-stopped —
  it wouldn't be re-selected by a *limited* re-run (an unlimited run still drains
  it). Document whichever ships in `LIMITATIONS.md`.
- **`inputKeys()` cost.** Called once per limited run in the daemon; it reads a
  file (cheap for the examples). If a future root stage's input is huge, selection
  reads it fully — acceptable, but note it.
- **Allowlist size.** Stored as JSON on the run row and read once per child via an
  index. Fine for the intended small N. The env-allowlist alternative (§4.3) would
  hit `ARG_MAX` far sooner; the DB-read design has no such ceiling.
- **Scheduled runs must never inherit a limit.** Guaranteed structurally: only the
  manual API path passes `opts.limit`; the scheduler calls `runWorkflow(def,
  'schedule')`. Add a test asserting a scheduled run leaves `run_limit` NULL.
- **Cancellation / `repeatUntilStable` interplay** — unaffected: the allowlist is
  frozen on the run row at start and read identically every cycle; cancel still
  hard-kills the in-flight child (the limit changes *which* items a stage attempts,
  not how a stage is killed).

## 8. Touch list for T094 (file-by-file)

| File | Change |
|---|---|
| `src/db/schema.sql` | `work_items.root_key/parent_key` + `idx_work_items_root`; `workflow_runs.run_limit/selected_roots` |
| `src/db/index.ts` | additive migration + backfill (§4.7) |
| `src/db/store.ts` | `markWorkItem` lineage opts + resolution; `WorkItemRow` fields; `getWorkItem` returns them; `distinctRoots`/`rootCount`/`selectPendingRoots`; `getWorkflowRunRoots`; `createWorkflowRun(run_limit, selected_roots)`; extend `WorkflowRunRow` mapping |
| `src/core/types.ts` | `JobContext.selectedRoots`/`rootAllowed`; `WorkflowRunRow.run_limit` |
| `src/runJob.ts` | read `LOCALJOBS_WORKFLOW_RUN_ID` → build `selectedRoots`/`rootAllowed` on `ctx` |
| `src/core/workflow-executor.ts` | `runWorkflow(def, trigger, { limit })`: find root stage, select, persist, log; thread `workflowRunId` env to the child |
| `src/core/executor.ts` | set `LOCALJOBS_WORKFLOW_RUN_ID` in the child `env` (already has `workflowRunId` in scope) |
| `src/api/server.ts` | `POST /api/workflows/:name/run` parses/validates `{ limit }`; `hasRootStage` guard; surface `limitable` on the workflow view |
| `src/workflows/perfumes/*` | `inputKeys()` on find-url; `rootAllowed(p.id)` filter in all 4 stages |
| `src/workflows/places/*` | `inputKeys()` on resolver; `rootAllowed` filters; enrich/llm `markWorkItem` lineage |
| `dashboard/app/lib/api.ts` | `runWorkflow(name, limit?)`; `WorkflowRun.run_limit`; `Workflow.limitable` |
| `dashboard/app/workflows/[name]/page.tsx` | limit number input beside Run now |
| `dashboard/app/workflow-runs/[id]/page.tsx` | "limited · N" badge |
| tests | `*.test.ts` for resolution rule, `selectPendingRoots`, back-compat (unset env ⇒ unlimited), scheduled-run-stays-unlimited |
| docs | `README.md` (Run control + Triggering jobs), `CLAUDE.md` (lineage convention + schema list), `.harness/docs/LIMITATIONS.md` (pending-definition trade-off) |
</content>
</invoke>
