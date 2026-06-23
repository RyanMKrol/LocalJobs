// Store tests for the workflow + service helpers. Runs against the scratch DB set
// by `npm test` (LOCALJOBS_DB). Self-asserting: throws on failure.
import assert from 'node:assert/strict';
import {
  browseTable, listDbTables, listCannedQueries, runCannedQuery,
  addWorkflowLog, backfillServiceUsage, createWorkflowRun, createRun, finishWorkflowRun, finishRun,
  getWorkflow, getWorkflowJobs, getWorkflowLogs, getWorkflowRun, getWorkflowRunRoots, getServiceRow, getWorkItem, hasActiveWorkflowRun,
  ignoreWorkItem, ignoredItems, isWorkItemDone,
  listRunsForWorkflowRun, listServices, markWorkItem, noForwardProgress, orphanedWorkItems, selectPendingRoots, workflowProgressSignature, workflowRetryableCount, workItemMarkdownPath,
  pruneOrphanedWorkItems, reapOrphanWorkflowRuns, recordServiceCall, recordSkippedRun, recordUsage, rollUpWorkflowProgress, setProgress,
  serviceCallsThisMonth, serviceCallsToday, stuckCount, stuckItems, syncJob, syncWorkflow, syncService,
  tryReserveMinInterval, tryReserveServiceSlot, unstickWorkItem, updateServiceLimits, usageThisMonth,
  bulkUnstickItems, bulkIgnoreItems,
} from './store.js';
import { callService, QuotaExceededError, registerService } from '../core/services.js';
import { db } from './index.js';

// member jobs must exist (runs.job_name FK → jobs.name)
for (const n of ['t-a', 't-b', 't-c']) syncJob({ name: n, run: async () => {} });

// workflow sync + edges
syncWorkflow({ name: 't-pipe', description: 'd', schedule: '0 2 * * *', jobs: [{ job: 't-a' }, { job: 't-b', dependsOn: ['t-a'] }] });
assert.equal(getWorkflow('t-pipe')?.schedule, '0 2 * * *');
assert.deepEqual(getWorkflowJobs('t-pipe'), [{ job_name: 't-a', depends_on: [] }, { job_name: 't-b', depends_on: ['t-a'] }]);

// re-sync replaces membership/edges
syncWorkflow({ name: 't-pipe', jobs: [{ job: 't-a' }, { job: 't-b' }, { job: 't-c', dependsOn: ['t-a'] }] });
assert.equal(getWorkflowJobs('t-pipe').length, 3);

// workflow run + linked member runs + skip + logs
const pr = createWorkflowRun('t-pipe', 'manual');
assert.ok(hasActiveWorkflowRun('t-pipe'));
const r1 = createRun('t-a', 'workflow', 1, pr);
finishRun(r1, 'success', { exitCode: 0 });
recordSkippedRun('t-c', pr, 'skipped: upstream t-a did not succeed');
const members = listRunsForWorkflowRun(pr);
assert.equal(members.length, 2);
assert.ok(members.some((m) => m.status === 'skipped'));
assert.equal(members.find((m) => m.status === 'success')?.workflow_run_id, pr);
addWorkflowLog(pr, 'stage t-a finished');
assert.equal(getWorkflowLogs(pr).length, 1);
finishWorkflowRun(pr, 'partial');
assert.equal(getWorkflowRun(pr)?.status, 'partial');
assert.ok(!hasActiveWorkflowRun('t-pipe'));

// orphan reaping
const pr2 = createWorkflowRun('t-pipe', 'manual');
assert.ok(reapOrphanWorkflowRuns() >= 1);
assert.equal(getWorkflowRun(pr2)?.status, 'cancelled');
assert.equal(workflowRetryableCount(['t-a', 't-b', 't-c'], 4), 0);

// services: sync + quota count + atomic rate reservation
syncService({ name: 't-svc', ratePerMinute: 2, dailyCap: 5, monthlyCap: 50, paid: true });
assert.ok(listServices().some((s) => s.name === 't-svc'));
recordServiceCall('t-svc');
assert.equal(serviceCallsToday('t-svc'), 1);
assert.equal(tryReserveServiceSlot('t-rate', 2), true);
assert.equal(tryReserveServiceSlot('t-rate', 2), true);
assert.equal(tryReserveServiceSlot('t-rate', 2), false); // rate of 2/min exhausted

// min-interval (fixed spacing) reservation
assert.equal(tryReserveMinInterval('t-mi', 10_000), true); // no prior call
assert.equal(tryReserveMinInterval('t-mi', 10_000), false); // <10s since last call

console.log('  ✓ store workflow + service helpers');

// ── rollUpWorkflowProgress: completed-stage stepping, no in-flight partial credit (T081) ──
// Four-stage workflow → denominator 4. Progress counts ONLY terminal members:
// the bar stays at 0% until the first stage finishes, then steps in 100/4 = 25.
syncWorkflow({ name: 't-rollup', jobs: [{ job: 't-a' }, { job: 't-b' }, { job: 't-c' }, { job: 't-d' }] });
syncJob({ name: 't-d', run: async () => {} });
const rp = createWorkflowRun('t-rollup', 'manual');
assert.equal(rollUpWorkflowProgress(rp), 0, 'no member runs yet → 0%');

const ra = createRun('t-a', 'workflow', 1, rp);
finishRun(ra, 'success', { exitCode: 0 });
assert.equal(rollUpWorkflowProgress(rp), 25, 'one completed stage → 25%');

// An in-flight member at 50% earns NO partial credit — the bar stays at 25%.
const rb = createRun('t-b', 'workflow', 1, rp);
createRun('t-c', 'workflow', 1, rp); // running at 0% contributes nothing
setProgress(rb, 50, 'halfway');
assert.equal(getWorkflowRun(rp)?.progress, 25, 'in-flight member does not move the bar');

// t-b reaching a terminal state steps the bar a whole stage → 2/4 = 50%.
finishRun(rb, 'success', { exitCode: 0 });
assert.equal(rollUpWorkflowProgress(rp), 50, 'second completed stage → 50%');

// A failed member is also terminal → still counts as a completed stage (3/4 = 75%).
const rc = createRun('t-c', 'workflow', 2, rp);
finishRun(rc, 'failed', { exitCode: 1 });
assert.equal(rollUpWorkflowProgress(rp), 75, 'failed member is terminal → counts toward stepping');
console.log('  ✓ rollUpWorkflowProgress: completed-stage stepping, no in-flight partial credit');

// ── backfillServiceUsage: idempotent top-up from job_usage → service_usage (T013) ──
// Simulate the pre-migration state: a job that metered onto job_usage but whose
// shared service_usage under-counts. The backfill reconciles the gap once.
for (let i = 0; i < 5; i++) recordUsage('t-bf-job'); // legacy per-job meter = 5
recordServiceCall('t-bf-svc'); // shared meter already has 1 (a post-migration call)
{
  const jobMonth = usageThisMonth('t-bf-job');
  const svcBefore = serviceCallsThisMonth('t-bf-svc');
  assert.equal(jobMonth, 5);
  assert.equal(svcBefore, 1);
  const topup = Math.max(0, jobMonth - svcBefore); // 4
  backfillServiceUsage('t-bf-svc', topup);
  assert.equal(serviceCallsThisMonth('t-bf-svc'), 5, 'service_usage reconciled to job_usage');
  // Idempotent: re-running with the recomputed diff (now 0) is a no-op.
  const topup2 = Math.max(0, usageThisMonth('t-bf-job') - serviceCallsThisMonth('t-bf-svc'));
  assert.equal(topup2, 0);
  backfillServiceUsage('t-bf-svc', topup2);
  assert.equal(serviceCallsThisMonth('t-bf-svc'), 5, 'no double-count on second run');
  // A non-positive count is a guarded no-op.
  backfillServiceUsage('t-bf-svc', -3);
  assert.equal(serviceCallsThisMonth('t-bf-svc'), 5);
}
console.log('  ✓ backfillServiceUsage idempotent top-up (no double-count)');

// ── QuotaExceededError soft-fail: the path the jobs now rely on as SOLE governor ──
// With per-job caps removed, an exhausted service quota is what stops the loop.
// Model the job's per-item loop: callService throws QuotaExceededError → break,
// leaving the unprocessed item un-done (resumes next run).
{
  registerService({ name: 't-quota', monthlyCap: 2, paid: true });
  syncService({ name: 't-quota', monthlyCap: 2, paid: true });
  const items = ['a', 'b', 'c', 'd'];
  const processed: string[] = [];
  let stopped = false;
  for (const item of items) {
    try {
      await callService('t-quota', async () => { processed.push(item); });
    } catch (e) {
      assert.ok(e instanceof QuotaExceededError && e.retryable === true && e.window === 'monthly');
      stopped = true;
      break; // graceful stop — remaining items left un-done for the next run
    }
  }
  assert.ok(stopped, 'loop stopped on QuotaExceededError once the quota was hit');
  assert.deepEqual(processed, ['a', 'b'], 'only the in-quota items ran; the rest are deferred');
  assert.equal(serviceCallsThisMonth('t-quota'), 2, 'no usage recorded past the cap');
}
console.log('  ✓ QuotaExceededError soft-fail stops the loop (service quota is sole governor)');

// ── pruneOrphanedWorkItems: manual prune of orphaned ledger rows (T014) ──
// The case that orphaned the old-id perfume rows: ledger keys that are no
// longer in the job's current input must be removable manually, while keys
// still in the input are kept.
{
  syncJob({ name: 't-prune', run: async () => {} });
  markWorkItem('t-prune', 'keep-1', 'success');
  markWorkItem('t-prune', 'keep-2', 'failed', { attempts: 4 });
  markWorkItem('t-prune', 'orphan-1', 'success');
  markWorkItem('t-prune', 'orphan-2', 'failed', { attempts: 2 });
  const current = ['keep-1', 'keep-2'];

  // preview surfaces only the orphans and modifies nothing
  const preview = orphanedWorkItems('t-prune', current);
  assert.deepEqual(preview.map((r) => r.item_key), ['orphan-1', 'orphan-2']);
  assert.ok(getWorkItem('t-prune', 'orphan-1'), 'preview did not delete');

  // prune removes the orphans, returns exactly what it removed, keeps current
  const removed = pruneOrphanedWorkItems('t-prune', current);
  assert.deepEqual(removed.map((r) => r.item_key), ['orphan-1', 'orphan-2']);
  assert.equal(getWorkItem('t-prune', 'orphan-1'), undefined, 'orphan removed');
  assert.equal(getWorkItem('t-prune', 'orphan-2'), undefined, 'orphan removed');
  assert.ok(getWorkItem('t-prune', 'keep-1'), 'current item kept');
  assert.ok(getWorkItem('t-prune', 'keep-2'), 'current item kept');

  // idempotent: a second prune with the same current set is a no-op
  assert.deepEqual(pruneOrphanedWorkItems('t-prune', current), []);

  // a Set works as the current-input set, and a key not in the ledger is harmless
  assert.deepEqual(orphanedWorkItems('t-prune', new Set(['keep-1', 'keep-2', 'never-existed'])), []);

  // an empty current set orphans everything (the API guards this; the store obeys)
  const wiped = pruneOrphanedWorkItems('t-prune', []);
  assert.deepEqual(wiped.map((r) => r.item_key), ['keep-1', 'keep-2']);
  assert.equal(getWorkItem('t-prune', 'keep-1'), undefined, 'empty set pruned all');
}
console.log('  ✓ pruneOrphanedWorkItems removes orphaned keys, keeps current (manual prune)');

// ── ignoreWorkItem: manually park a stuck item permanently (T017/T033) ──
// There is ONE manual-park concept ("ignored"): genuinely-bad-data items that
// will never process must be removable from the stuck list by hand — never
// automatically — distinct from unstick/retry, and surfaced ONLY on the
// overview's Ignored tile (never counted as stuck).
{
  syncJob({ name: 't-ignore', run: async () => {} });
  markWorkItem('t-ignore', 'bad-1', 'failed', { attempts: 4 }); // stuck
  markWorkItem('t-ignore', 'bad-2', 'failed', { attempts: 4 }); // stuck
  markWorkItem('t-ignore', 'ok-1', 'success');

  const stuckBefore = stuckItems().filter((i) => i.job_name === 't-ignore');
  assert.deepEqual(stuckBefore.map((i) => i.item_key).sort(), ['bad-1', 'bad-2']);
  assert.equal(stuckCount('t-ignore'), 2);

  // ignore bad-1 → row updated, parked as 'ignored'
  assert.equal(ignoreWorkItem('t-ignore', 'bad-1'), 1);
  assert.equal(getWorkItem('t-ignore', 'bad-1')?.status, 'ignored');

  // ignored item is gone from the stuck list and the count (NEVER counted stuck)
  const stuckAfter = stuckItems().filter((i) => i.job_name === 't-ignore');
  assert.deepEqual(stuckAfter.map((i) => i.item_key), ['bad-2'], 'ignored item left the stuck list');
  assert.equal(stuckCount('t-ignore'), 1);

  // ignoredItems() surfaces it (the overview-only Ignored tile) — and ONLY it
  const ignoredList = ignoredItems().filter((i) => i.job_name === 't-ignore');
  assert.deepEqual(ignoredList.map((i) => i.item_key), ['bad-1'], 'ignored item shows on the Ignored list');

  // an ignored item counts as done — never reprocessed/resurrected on a re-run
  assert.equal(isWorkItemDone('t-ignore', 'bad-1', 4), true, 'ignored = done, never reprocessed');

  // ignore persists across re-runs: even re-running the same key, an ignored
  // item stays ignored (the job skips it via isWorkItemDone, so the row is not
  // touched) — and it is still NOT stuck.
  assert.equal(getWorkItem('t-ignore', 'bad-1')?.status, 'ignored', 'still ignored after a re-run cycle');
  assert.equal(stuckCount('t-ignore'), 1, 'ignored item never resurfaces as stuck');

  // ignore only acts on a failed row: a no-op on success, and idempotent on
  // an already-ignored row (it's no longer 'failed')
  assert.equal(ignoreWorkItem('t-ignore', 'ok-1'), 0, 'cannot ignore a success');
  assert.equal(getWorkItem('t-ignore', 'ok-1')?.status, 'success');
  assert.equal(ignoreWorkItem('t-ignore', 'bad-1'), 0, 'already ignored → no-op');
  assert.equal(ignoreWorkItem('t-ignore', 'never-existed'), 0, 'unknown key → no-op');

  // distinct from unstick: unstick DELETES (to retry), ignore PARKS (kept, done).
  // unstick won't touch an ignored row; the still-stuck bad-2 can be unstuck.
  assert.equal(unstickWorkItem('t-ignore', 'bad-1'), 0, 'unstick does not delete an ignored row');
  assert.ok(getWorkItem('t-ignore', 'bad-1'), 'ignored row still present after unstick attempt');
  assert.equal(unstickWorkItem('t-ignore', 'bad-2'), 1, 'a still-stuck item can be unstuck');
  assert.equal(getWorkItem('t-ignore', 'bad-2'), undefined, 'unstick removed the stuck row');
}
console.log('  ✓ ignoreWorkItem parks a stuck item (manual, persists, off stuck list, on Ignored list)');

// ── bulkUnstickItems / bulkIgnoreItems: scope + only-failed guard (T118) ──
// Bulk operations act ONLY on currently-'failed' rows; success/ignored rows are
// untouched. Scopes: 'all' (no filter), 'job' (one job), 'workflow' (member jobs).
{
  syncJob({ name: 'bk-j1', run: async () => {} });
  syncJob({ name: 'bk-j2', run: async () => {} });
  syncWorkflow({ name: 'bk-wf', description: 'd', schedule: null, jobs: [{ job: 'bk-j1' }, { job: 'bk-j2' }] });

  function seedBulk() {
    markWorkItem('bk-j1', 'bk-f1', 'failed', { attempts: 4 });
    markWorkItem('bk-j1', 'bk-f2', 'failed', { attempts: 4 });
    markWorkItem('bk-j1', 'bk-ok', 'success');
    markWorkItem('bk-j2', 'bk-f3', 'failed', { attempts: 4 });
    markWorkItem('bk-j2', 'bk-ig', 'ignored');
  }

  // -- bulk-unstick: job scope removes only that job's failed rows --
  seedBulk();
  assert.equal(bulkUnstickItems({ type: 'job', jobName: 'bk-j1' }), 2, 'job scope removes 2 failed rows');
  assert.equal(getWorkItem('bk-j1', 'bk-f1'), undefined, 'bk-f1 deleted');
  assert.equal(getWorkItem('bk-j1', 'bk-f2'), undefined, 'bk-f2 deleted');
  assert.equal(getWorkItem('bk-j1', 'bk-ok')?.status, 'success', 'success row untouched');
  assert.ok(getWorkItem('bk-j2', 'bk-f3'), 'bk-j2 rows untouched by job scope');

  // -- bulk-ignore: workflow scope acts only on member jobs --
  seedBulk(); // re-seed (bk-j1 rows were deleted)
  const wfJobNames = getWorkflowJobs('bk-wf').map((m) => m.job_name);
  assert.equal(bulkIgnoreItems({ type: 'workflow', jobNames: wfJobNames }), 3, 'workflow scope ignores 3 failed rows (2 bk-j1 + 1 bk-j2)');
  assert.equal(getWorkItem('bk-j1', 'bk-f1')?.status, 'ignored', 'bk-f1 ignored');
  assert.equal(getWorkItem('bk-j1', 'bk-f2')?.status, 'ignored', 'bk-f2 ignored');
  assert.equal(getWorkItem('bk-j2', 'bk-f3')?.status, 'ignored', 'bk-f3 ignored');
  assert.equal(getWorkItem('bk-j2', 'bk-ig')?.status, 'ignored', 'already-ignored row untouched (still ignored, 0 updates)');
  assert.equal(getWorkItem('bk-j1', 'bk-ok')?.status, 'success', 'success row untouched by bulk-ignore');

  // -- bulk-unstick: 'all' scope across all jobs --
  // Reset: re-seed bk-j1 with fresh failed rows; bk-j2 rows are now ignored → not touched
  markWorkItem('bk-j1', 'bk-f1', 'failed', { attempts: 4 });
  markWorkItem('bk-j1', 'bk-f2', 'failed', { attempts: 4 });
  markWorkItem('bk-j2', 'bk-f4', 'failed', { attempts: 4 });
  assert.equal(bulkUnstickItems({ type: 'all' }), 3, 'all scope removes all failed rows across all jobs');
  assert.equal(getWorkItem('bk-j1', 'bk-f1'), undefined, 'bk-f1 gone');
  assert.equal(getWorkItem('bk-j2', 'bk-f4'), undefined, 'bk-f4 gone');
  assert.equal(getWorkItem('bk-j2', 'bk-f3')?.status, 'ignored', 'ignored row untouched by all-scope unstick');

  // -- empty jobNames: workflow scope with no members is a no-op --
  assert.equal(bulkUnstickItems({ type: 'workflow', jobNames: [] }), 0, 'empty jobNames → 0 changes');
  assert.equal(bulkIgnoreItems({ type: 'workflow', jobNames: [] }), 0, 'empty jobNames → 0 changes');
}
console.log('  ✓ bulkUnstickItems/bulkIgnoreItems: scope (all/job/workflow), only-failed guard');

// ── input lineage + run-limit root selection (T094) ──
// The framework tracks each work item's originating-input root_key so a manual
// run-limit can bound N roots and run ALL their fan-out. Covers the resolution
// rule (explicit / inherit-from-parent / default-to-key), selectPendingRoots
// (fresh → first N, resumed → skips done, N > pending → all), the run row's
// run_limit/selected_roots, and a fan-out fixture (1 root → many descendants).
{
  syncJob({ name: 'lin-root', run: async () => {} });
  syncJob({ name: 'lin-child', run: async () => {} });

  // rule 3: no lineage opts → item is its own root
  markWorkItem('lin-root', 'r1', 'success');
  assert.equal(getWorkItem('lin-root', 'r1')?.root_key, 'r1', 'default root = item_key');
  assert.equal(getWorkItem('lin-root', 'r1')?.parent_key, null, 'a root has no parent');

  // rule 1: explicit rootKey wins, and parent_key is recorded
  markWorkItem('lin-child', 'placeA', 'success', { rootKey: 'r1', parentKey: 'r1', parentJob: 'lin-root' });
  assert.equal(getWorkItem('lin-child', 'placeA')?.root_key, 'r1', 'explicit rootKey used');
  assert.equal(getWorkItem('lin-child', 'placeA')?.parent_key, 'r1', 'parent_key recorded');

  // rule 2: inherit the parent row's root_key when only parentKey is given
  markWorkItem('lin-child', 'grandB', 'success', { parentKey: 'placeA', parentJob: 'lin-child' });
  assert.equal(getWorkItem('lin-child', 'grandB')?.root_key, 'r1', 'root inherited from parent row');

  // rule 2 fallback: a missing parent row → parentKey itself becomes the root
  markWorkItem('lin-child', 'orphanC', 'success', { parentKey: 'no-such-parent', parentJob: 'lin-child' });
  assert.equal(getWorkItem('lin-child', 'orphanC')?.root_key, 'no-such-parent', 'fallback to parentKey when parent absent');
}
console.log('  ✓ markWorkItem lineage resolution (explicit / inherit / default-to-key)');

// workItemMarkdownPath: returns the recorded detail.markdown, else null (T110)
{
  syncJob({ name: 'md-job', run: async () => {} });
  markWorkItem('md-job', 'with-md', 'success', { detail: { name: 'X', markdown: '/some/where/data/out/markdown/x.md' } });
  markWorkItem('md-job', 'no-md', 'success', { detail: { name: 'Y' } });
  markWorkItem('md-job', 'no-detail', 'success');
  assert.equal(workItemMarkdownPath('md-job', 'with-md'), '/some/where/data/out/markdown/x.md', 'returns recorded markdown path');
  assert.equal(workItemMarkdownPath('md-job', 'no-md'), null, 'no markdown key → null');
  assert.equal(workItemMarkdownPath('md-job', 'no-detail'), null, 'no detail → null');
  assert.equal(workItemMarkdownPath('md-job', 'missing'), null, 'missing item → null');
}
console.log('  ✓ workItemMarkdownPath (recorded path / null)');

{
  // selectPendingRoots: fresh DB → first N candidates in input order
  syncJob({ name: 'sel-a', run: async () => {} });
  syncJob({ name: 'sel-b', run: async () => {} });
  const members = ['sel-a', 'sel-b'];
  const candidates = ['c1', 'c2', 'c3', 'c4', 'c5'];
  assert.deepEqual(selectPendingRoots(members, 'sel-a', candidates, 2, 4), ['c1', 'c2'], 'fresh → first N in order');
  assert.deepEqual(selectPendingRoots(members, 'sel-a', candidates, 0, 4), [], 'N=0 → none');

  // resumed: c1 fully done (entry success + no outstanding descendant) is skipped;
  // c2 entry done BUT a descendant still outstanding → re-selected; c3 fresh.
  markWorkItem('sel-a', 'c1', 'success', { rootKey: 'c1' });
  markWorkItem('sel-b', 'c1-child', 'success', { rootKey: 'c1' });
  markWorkItem('sel-a', 'c2', 'success', { rootKey: 'c2' });
  markWorkItem('sel-b', 'c2-child', 'failed', { rootKey: 'c2', attempts: 1 }); // retryable → outstanding
  assert.deepEqual(
    selectPendingRoots(members, 'sel-a', candidates, 2, 4),
    ['c2', 'c3'],
    'resumed → skips fully-done c1, re-selects c2 (outstanding descendant), then c3',
  );

  // a stuck descendant (failed past minAttempts) does NOT keep a root pending
  markWorkItem('sel-a', 'c4', 'success', { rootKey: 'c4' });
  markWorkItem('sel-b', 'c4-child', 'failed', { rootKey: 'c4', attempts: 4 }); // exhausted → done
  assert.deepEqual(selectPendingRoots(members, 'sel-a', ['c4'], 5, 4), [], 'root with only exhausted descendants is done');

  // N larger than the pending count → all pending (no error)
  assert.deepEqual(selectPendingRoots(members, 'sel-a', ['c2', 'c3', 'c5'], 99, 4), ['c2', 'c3', 'c5']);
}
console.log('  ✓ selectPendingRoots (fresh → first N · resumed skips done · N > pending → all)');

{
  // createWorkflowRun persists run_limit + selected_roots; getWorkflowRunRoots reads them back
  syncJob({ name: 'lim-x', run: async () => {} });
  syncWorkflow({ name: 'lim-wf', jobs: [{ job: 'lim-x' }] });
  const limited = createWorkflowRun('lim-wf', 'manual', 2, ['c1', 'c2']);
  assert.equal(getWorkflowRun(limited)?.run_limit, 2, 'run_limit persisted');
  assert.deepEqual(getWorkflowRunRoots(limited), ['c1', 'c2'], 'selected_roots round-trips as an array');
  finishWorkflowRun(limited, 'success');

  const unlimited = createWorkflowRun('lim-wf', 'manual');
  assert.equal(getWorkflowRun(unlimited)?.run_limit, null, 'unlimited run → run_limit null');
  assert.equal(getWorkflowRunRoots(unlimited), null, 'unlimited run → no allowlist (null)');
  finishWorkflowRun(unlimited, 'success');
  assert.equal(getWorkflowRunRoots('no-such-run'), null, 'unknown run → null');
}
console.log('  ✓ createWorkflowRun persists run_limit/selected_roots; getWorkflowRunRoots reads them');

{
  // FAN-OUT FIXTURE: one selected root must run ALL its descendants while an
  // unselected root runs nothing. Simulates what the framework + jobs do — the
  // child's allowlist set + rootAllowed gate, with root_key propagating through
  // two fan-out stages (A: root→3 children, B: each child→2 grandchildren).
  syncJob({ name: 'fan-a', run: async () => {} });
  syncJob({ name: 'fan-b', run: async () => {} });
  const members = ['fan-a', 'fan-b'];
  const roots = ['R1', 'R2'];

  // limit = 1 → select R1 only
  const selected = selectPendingRoots(members, 'fan-a', roots, 1, 4);
  assert.deepEqual(selected, ['R1']);
  const allow = new Set(selected);
  const rootAllowed = (r: string) => allow.has(r); // limited run → set is non-null

  // Stage A: for each root, if allowed, fan out to 3 children carrying the root.
  for (const r of roots) {
    if (!rootAllowed(r)) continue;
    for (let i = 1; i <= 3; i++) markWorkItem('fan-a', `${r}-k${i}`, 'success', { rootKey: r, parentKey: r, parentJob: 'fan-a' });
  }
  // Stage B: read A's children, keep those whose ROOT is allowed, fan each to 2.
  for (const r of roots) {
    for (let i = 1; i <= 3; i++) {
      const childKey = `${r}-k${i}`;
      const childRow = getWorkItem('fan-a', childKey);
      if (!childRow) continue; // A never produced it (root not selected)
      if (!rootAllowed(childRow.root_key!)) continue;
      for (let j = 1; j <= 2; j++) {
        markWorkItem('fan-b', `${childKey}-g${j}`, 'success', { parentKey: childKey, parentJob: 'fan-a' });
      }
    }
  }

  // R1: 3 children in A + 6 grandchildren in B, ALL carrying root_key R1.
  const aR1 = ['R1-k1', 'R1-k2', 'R1-k3'];
  for (const k of aR1) assert.equal(getWorkItem('fan-a', k)?.root_key, 'R1', `${k} descends from R1`);
  let grandCount = 0;
  for (const k of aR1) for (let j = 1; j <= 2; j++) {
    const g = getWorkItem('fan-b', `${k}-g${j}`);
    assert.ok(g, `grandchild ${k}-g${j} ran`);
    assert.equal(g?.root_key, 'R1', 'grandchild inherited root R1 through two fan-out stages');
    grandCount++;
  }
  assert.equal(grandCount, 6, 'all 6 descendants of the selected root ran');

  // R2 (not selected) produced NOTHING at any stage.
  assert.equal(getWorkItem('fan-a', 'R2-k1'), undefined, 'unselected root has no stage-A descendants');
  assert.equal(getWorkItem('fan-b', 'R2-k1-g1'), undefined, 'unselected root has no stage-B descendants');
}
console.log('  ✓ run-limit fan-out: ALL descendants of the selected root run; unselected root runs nothing');

// ── service limit overrides: persistence + reconcile across code-sync (T018) ──
// The Services page can override a service's rate/quota. The override must persist
// AND survive a later code-sync (same reconcile as the user-owned `enabled` flag),
// while a service the user hasn't touched still tracks the code default.
{
  // seed from code
  syncService({ name: 't-lim', description: 'orig', ratePerMinute: 10, dailyCap: 100, monthlyCap: 1000, paid: true });
  let row = getServiceRow('t-lim');
  assert.equal(row?.rate_per_minute, 10);
  assert.equal(row?.limits_overridden, 0, 'fresh sync is not an override');

  // user override → persisted + flag flips
  const updated = updateServiceLimits('t-lim', { rate_per_minute: 3, daily_cap: 30, monthly_cap: 300 });
  assert.equal(updated?.rate_per_minute, 3);
  assert.equal(updated?.daily_cap, 30);
  assert.equal(updated?.monthly_cap, 300);
  assert.equal(updated?.limits_overridden, 1, 'override sets the flag');

  // a later code-sync with DIFFERENT code defaults must NOT clobber the override,
  // but description/paid (code-owned) still refresh.
  syncService({ name: 't-lim', description: 'changed', ratePerMinute: 99, dailyCap: 999, monthlyCap: 9999, paid: false });
  row = getServiceRow('t-lim');
  assert.equal(row?.rate_per_minute, 3, 'code-sync preserves user rate override');
  assert.equal(row?.daily_cap, 30, 'code-sync preserves user daily override');
  assert.equal(row?.monthly_cap, 300, 'code-sync preserves user monthly override');
  assert.equal(row?.description, 'changed', 'description is code-owned, refreshed');
  assert.equal(row?.paid, 0, 'paid is code-owned, refreshed');

  // null clears a limit (no throttle / no cap)
  updateServiceLimits('t-lim', { rate_per_minute: null, daily_cap: null, monthly_cap: 50 });
  row = getServiceRow('t-lim');
  assert.equal(row?.rate_per_minute, null);
  assert.equal(row?.daily_cap, null);
  assert.equal(row?.monthly_cap, 50);

  // a non-overridden service keeps tracking the code default across re-sync
  syncService({ name: 't-noov', ratePerMinute: 5 });
  syncService({ name: 't-noov', ratePerMinute: 7 });
  assert.equal(getServiceRow('t-noov')?.rate_per_minute, 7, 'untouched service follows code default');

  // updating a service that doesn't exist is a no-op (no row created)
  assert.equal(updateServiceLimits('t-nope', { rate_per_minute: 1, daily_cap: null, monthly_cap: null }), undefined);
  assert.equal(getServiceRow('t-nope'), undefined);
}
console.log('  ✓ service limit override persists + survives code-sync (reconciled like enabled)');

// ── callService enforces the OVERRIDE, not just the code default (T018) ──
// A tighter user override must take effect: lowering the monthly quota below the
// code default makes callService soft-fail earlier.
{
  registerService({ name: 't-lim-enf', monthlyCap: 100, paid: true });
  syncService({ name: 't-lim-enf', monthlyCap: 100, paid: true });
  updateServiceLimits('t-lim-enf', { rate_per_minute: null, daily_cap: null, monthly_cap: 1 });

  let calls = 0;
  await callService('t-lim-enf', async () => { calls++; }); // 1st call → recorded
  assert.equal(calls, 1);
  await assert.rejects(
    () => callService('t-lim-enf', async () => { calls++; }),
    (e) => e instanceof QuotaExceededError && e.window === 'monthly' && e.cap === 1,
    'override monthly cap of 1 enforced (code default was 100)',
  );
  assert.equal(calls, 1, 'the over-quota call never ran fn');
}
console.log('  ✓ callService enforces a user limit override over the code default');

// ── read-only DB browser (T019) ──
// Tables are discovered from the live schema; rows page; unknown/dangerous names
// are rejected (no write path is reachable).
{
  const tables = listDbTables();
  assert.ok(tables.includes('jobs') && tables.includes('runs') && tables.includes('services'), 'lists real tables');
  assert.ok(!tables.some((t) => t.startsWith('sqlite_')), 'excludes sqlite-internal tables');

  const page = browseTable('jobs', 2, 0);
  assert.ok(page, 'browseTable returns a page for a known table');
  assert.ok(page!.columns.includes('name') && page!.columns.includes('description'), 'reports columns');
  assert.ok(page!.rows.length <= 2 && page!.rows.length <= page!.total, 'respects the limit');
  assert.equal(page!.limit, 2);
  assert.equal(page!.offset, 0);

  // paging: a second page starts after the first (no overlap when >1 row exists)
  const p2 = browseTable('jobs', 1, 1);
  assert.equal(p2!.offset, 1, 'offset honoured');

  // limit clamped into [1,500]; bad values fall back / clamp
  assert.equal(browseTable('jobs', 0, 0)!.limit, 50, 'limit 0 → default 50');
  assert.equal(browseTable('jobs', 9999, 0)!.limit, 500, 'limit clamped to 500');
  assert.equal(browseTable('jobs', 50, -5)!.offset, 0, 'negative offset clamped to 0');

  // unknown / injection-y names are rejected outright (whitelist guard)
  assert.equal(browseTable('no_such_table', 10, 0), null, 'unknown table → null');
  assert.equal(browseTable('jobs; DROP TABLE jobs', 10, 0), null, 'injection attempt → null');
  assert.equal(browseTable('sqlite_master', 10, 0), null, 'sqlite-internal table not browsable');
}
console.log('  ✓ read-only DB browser lists tables + pages rows, rejects unknown/unsafe names');

// ── canned (predefined) read-only queries (T053) ──
// The catalogue is fixed; each query runs read-only against the scratch DB and
// surfaces the expected shape. The client only ever picks by id — no SQL crosses.
{
  // seed data each query should surface
  syncJob({ name: 'q-job', run: async () => {} });
  const fr = createRun('q-job', 'manual');
  finishRun(fr, 'failed', { exitCode: 1, error: 'boom' });
  markWorkItem('q-job', 'k1', 'failed', { attempts: 9 });
  markWorkItem('q-job', 'k2', 'ignored');
  markWorkItem('q-job', 'k3', 'success');
  syncService({ name: 'q-svc', dailyCap: 5, monthlyCap: 50, paid: true });
  recordServiceCall('q-svc');
  const wr = createWorkflowRun('t-pipe', 'manual');
  finishWorkflowRun(wr, 'success');

  // catalogue: stable, non-empty, each entry well-formed
  const cat = listCannedQueries();
  assert.ok(cat.length >= 5, 'catalogue has the canned queries');
  for (const q of cat) {
    assert.ok(q.id && q.title && q.description, 'each query advertises id/title/description');
  }
  const ids = cat.map((q) => q.id);
  for (const expected of ['recent-failed-runs', 'stuck-ignored-items', 'work-item-status', 'service-spend', 'workflow-run-outcomes']) {
    assert.ok(ids.includes(expected), `catalogue includes ${expected}`);
  }

  // every catalogued query runs and returns a well-formed result
  for (const q of cat) {
    const r = runCannedQuery(q.id);
    assert.ok(r, `runCannedQuery(${q.id}) returns a result`);
    assert.equal(r!.id, q.id);
    assert.ok(Array.isArray(r!.rows), 'rows is an array');
    // columns derived from the first row when present
    if (r!.rows.length > 0) assert.deepEqual(r!.columns, Object.keys(r!.rows[0]));
  }

  // recent-failed-runs surfaces the failed run, not the success of other jobs
  const failed = runCannedQuery('recent-failed-runs')!;
  assert.ok(failed.rows.some((row) => row.id === fr && row.status === 'failed'), 'failed run present');
  assert.ok(!failed.rows.some((row) => row.status === 'success'), 'only non-success statuses');

  // stuck-ignored-items: q-job has one failed + one ignored, not the success
  const si = runCannedQuery('stuck-ignored-items')!;
  const sij = si.rows.filter((row) => row.job_name === 'q-job');
  assert.ok(sij.some((row) => row.status === 'failed' && row.items === 1), 'failed item counted');
  assert.ok(sij.some((row) => row.status === 'ignored' && row.items === 1), 'ignored item counted');
  assert.ok(!sij.some((row) => row.status === 'success'), 'success excluded from stuck/ignored view');

  // work-item-status: full breakdown includes the success too
  const wis = runCannedQuery('work-item-status')!;
  assert.ok(wis.rows.some((row) => row.job_name === 'q-job' && row.status === 'success' && row.items === 1), 'success counted in full breakdown');

  // service-spend: q-svc shows one call this month against its caps
  const spend = runCannedQuery('service-spend')!;
  const svc = spend.rows.find((row) => row.name === 'q-svc');
  assert.ok(svc, 'service present');
  assert.equal(svc!.used_month, 1, 'one call counted this month');
  assert.equal(svc!.monthly_cap, 50, 'cap surfaced');

  // workflow-run-outcomes: the finished run shows up with its status
  const wfo = runCannedQuery('workflow-run-outcomes')!;
  assert.ok(wfo.rows.some((row) => row.id === wr && row.status === 'success'), 'workflow run present');

  // unknown id → null (the only input is the id; no SQL crosses the boundary)
  assert.equal(runCannedQuery('no-such-query'), null, 'unknown query id → null');
  assert.equal(runCannedQuery("recent-failed-runs'; DROP TABLE runs;--"), null, 'injection-y id → null');
}
console.log('  ✓ canned read-only queries: catalogue + each query returns expected shape, rejects unknown ids');

// ── T112: no-forward-progress stop condition for repeatUntilStable ──
// A genuinely-unfindable item frozen below maxAttempts is counted retryable every
// cycle yet never advances; the loop must detect "this cycle changed nothing" and
// stop instead of spinning to maxCycles.
{
  for (const n of ['p-find', 'p-fetch']) syncJob({ name: n, run: async () => {} });
  const members = ['p-find', 'p-fetch'];
  const MIN = 4;

  // pure decision helper: first cycle (no prev) is never "no progress"
  assert.equal(noForwardProgress(null, { items: 1, attempts: 2, retryable: 1 }), false);

  // a real attempt landed (one success), nothing retryable left
  markWorkItem('p-find', 'good-1', 'success', { attempts: 1 });
  // one genuinely-unfindable item, frozen below maxAttempts → retryable forever
  markWorkItem('p-find', 'amouage-jubilation-40', 'failed', { attempts: 2, detail: { error: 'no Fragrantica page found' } });

  const sigA = workflowProgressSignature(members, MIN);
  assert.equal(sigA.items, 2, 'two ledger rows');
  assert.equal(sigA.attempts, 3, 'attempts summed (1 + 2)');
  assert.equal(sigA.retryable, 1, 'the frozen failed item is retryable');

  // a cycle that re-runs but advances NOTHING produces an identical signature →
  // noForwardProgress is true (this is what stops the loop early).
  const sigB = workflowProgressSignature(members, MIN);
  assert.deepEqual(sigB, sigA, 'unchanged cycle → identical signature');
  assert.equal(noForwardProgress(sigA, sigB), true, 'no work advanced → stop early');

  // but if an item actually advances (its attempts increment), it is NOT a stop:
  markWorkItem('p-find', 'amouage-jubilation-40', 'failed', { attempts: 3, detail: { error: 'no Fragrantica page found' } });
  const sigC = workflowProgressSignature(members, MIN);
  assert.equal(sigC.attempts, 4, 'attempts advanced (2 → 3)');
  assert.equal(noForwardProgress(sigB, sigC), false, 'a real re-attempt is forward progress → keep cycling');

  // once the item exhausts its retry budget it stops being retryable (drops out
  // naturally), so the loop ends via the retryable===0 / dropped-count path.
  markWorkItem('p-find', 'amouage-jubilation-40', 'failed', { attempts: MIN });
  const sigD = workflowProgressSignature(members, MIN);
  assert.equal(sigD.retryable, 0, 'exhausted item no longer retryable');
  // retryable dropped vs sigC → not a no-progress stop (genuine progress)
  assert.equal(noForwardProgress(sigC, sigD), false, 'retryable dropped → progress, not a stall');
}
console.log('  ✓ T112 no-forward-progress: signature + stop decision (frozen item halts cycling, real attempts continue)');

// ── T112: deterministic latest-run-per-stage ordering (status-flicker fix) ──
// During fast repeatUntilStable cycling two runs of the same job can share a
// second; listRunsForWorkflowRun must order by (started_at, rowid) so the genuinely
// latest run sorts last and the dashboard's last-write-wins status is correct.
{
  syncJob({ name: 'flick-a', run: async () => {} });
  syncWorkflow({ name: 'flick-wf', jobs: [{ job: 'flick-a' }] });
  const wr = createWorkflowRun('flick-wf', 'manual');

  // cycle 1: a settled (success) run, then cycle 2: a fresh still-running run.
  const older = createRun('flick-a', 'workflow', 1, wr);
  finishRun(older, 'success', { exitCode: 0 });
  const newer = createRun('flick-a', 'workflow', 2, wr); // running

  // Force BOTH started_at to the SAME timestamp so ordering MUST fall back to the
  // rowid tiebreaker (reproduces the colliding-second flicker deterministically).
  db.prepare("UPDATE runs SET started_at = '2026-06-23 02:00:00' WHERE id IN (?, ?)").run(older, newer);

  const members = listRunsForWorkflowRun(wr);
  const last = members[members.length - 1];
  assert.equal(last.id, newer, 'the newer (higher-rowid) run sorts last despite the tied timestamp');
  assert.equal(last.status, 'running', 'so the latest-per-stage status is the running run, not the stale success');

  // mirror the dashboard derivation (last write wins) to prove no false "succeeded"
  const statusByJob: Record<string, string> = {};
  for (const r of members) statusByJob[r.job_name] = r.status;
  assert.equal(statusByJob['flick-a'], 'running', 'dashboard status derivation picks the running run');
}
console.log('  ✓ T112 status flicker: listRunsForWorkflowRun orders by (started_at, rowid) so latest stage status is correct');
