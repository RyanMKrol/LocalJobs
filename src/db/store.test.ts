// Store tests for the workflow + service helpers. Runs against the scratch DB set
// by `npm test` (LOCALJOBS_DB). Self-asserting: throws on failure.
import assert from 'node:assert/strict';
import {
  browseTable, listDbTables, listCannedQueries, runCannedQuery,
  addWorkflowLog, backfillServiceUsage, createWorkflowRun, createRun, finishWorkflowRun, finishRun,
  getWorkflow, getWorkflowJobs, getWorkflowLogs, getWorkflowRun, getWorkflowRunRoots, getServiceRow, getWorkItem, hasActiveWorkflowRun,
  hasJobAdvancedAnyItem, workflowRunAdvancedAnyItem, setRunNoop,
  ignoreWorkItem, ignoredItems, ignoredItemKeys, ignoreSurfacedItems, isWorkItemDone,
  listRunsForWorkflowRun, listServices, listWorkflows, markWorkItem, noForwardProgress, orphanedWorkItems, selectPendingRoots, workflowProgressSignature, workflowRetryableCount, workItemIoRows, workItemMarkdownPath, workflowHasRunLinkage,
  pruneOrphanedWorkItems, reapOrphanWorkflowRuns, recordServiceCall, recordSkippedRun, recordUsage, rollUpWorkflowProgress, setProgress,
  serviceCallsThisMonth, serviceCallsToday, stuckCount, stuckItems, syncJob, syncWorkflow, syncService,
  tryReserveMinInterval, tryReserveServiceSlot, unstickWorkItem, updateServiceLimits, updateWorkflowSchedule, updateWorkflowConcurrency, updateWorkflowNotifyEnabled, updateJobTimeout, getJob, usageThisMonth,
  bulkUnstickItems, bulkIgnoreItems,
  deleteWorkflowCompletely, deleteJobCompletely, deleteServiceCompletely,
  recordServiceConsumer, listServiceConsumers,
  deleteNullDetailSuccessItems,
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

// ── editable schedule (T135): user-owned override reconciled across code-sync ──
{
  syncWorkflow({ name: 't-sched', schedule: '0 2 * * *', jobs: [{ job: 't-a' }] });
  assert.equal(getWorkflow('t-sched')?.schedule, '0 2 * * *', 'code schedule seeded');
  assert.equal(getWorkflow('t-sched')?.schedule_overridden, 0, 'not overridden initially');

  // user edits the schedule → flips schedule_overridden
  const updated = updateWorkflowSchedule('t-sched', '30 4 * * *');
  assert.equal(updated?.schedule, '30 4 * * *', 'updateWorkflowSchedule sets the value');
  assert.equal(updated?.schedule_overridden, 1, 'updateWorkflowSchedule flips schedule_overridden');

  // a CODE-sync now PRESERVES the user's schedule (the reconcile, like enabled)
  syncWorkflow({ name: 't-sched', schedule: '0 2 * * *', jobs: [{ job: 't-a' }] });
  assert.equal(getWorkflow('t-sched')?.schedule, '30 4 * * *', 'overridden schedule survives re-sync');
  assert.equal(getWorkflow('t-sched')?.schedule_overridden, 1, 'override flag survives re-sync');

  // an empty/blank value clears to NULL = manual-only (still overridden)
  const cleared = updateWorkflowSchedule('t-sched', '   ');
  assert.equal(cleared?.schedule, null, 'blank input clears schedule to manual-only');
  assert.equal(cleared?.schedule_overridden, 1, 'still overridden after clear');
  syncWorkflow({ name: 't-sched', schedule: '0 2 * * *', jobs: [{ job: 't-a' }] });
  assert.equal(getWorkflow('t-sched')?.schedule, null, 'cleared-to-null override survives re-sync');

  // unknown workflow → undefined (no row touched)
  assert.equal(updateWorkflowSchedule('t-no-such-wf', '0 1 * * *'), undefined, 'unknown workflow → undefined');
}
console.log('  ✓ updateWorkflowSchedule: set/clear + schedule_overridden reconcile across sync (T135)');

// ── editable job timeoutMs (T297): user-owned override reconciled across code-sync ──
{
  syncJob({ name: 't-timeout', timeoutMs: 60_000, run: async () => {} });
  assert.equal(getJob('t-timeout')?.timeout_ms, 60_000, 'code timeoutMs seeded');
  assert.equal(getJob('t-timeout')?.timeout_ms_overridden, 0, 'not overridden initially');

  // user edits the timeout → flips timeout_ms_overridden
  const updated = updateJobTimeout('t-timeout', 120_000);
  assert.equal(updated?.timeout_ms, 120_000, 'updateJobTimeout sets the value');
  assert.equal(updated?.timeout_ms_overridden, 1, 'updateJobTimeout flips timeout_ms_overridden');

  // a CODE-sync with the SAME original manifest timeoutMs now PRESERVES the user's
  // override (the reconcile, mirroring schedule/maxConcurrency)
  syncJob({ name: 't-timeout', timeoutMs: 60_000, run: async () => {} });
  assert.equal(getJob('t-timeout')?.timeout_ms, 120_000, 'overridden timeout survives re-sync');
  assert.equal(getJob('t-timeout')?.timeout_ms_overridden, 1, 'override flag survives re-sync');

  // unknown job → undefined (no row touched)
  assert.equal(updateJobTimeout('t-no-such-job', 1000), undefined, 'unknown job → undefined');
}
console.log('  ✓ updateJobTimeout: set + timeout_ms_overridden reconcile across sync (T297)');

// ── editable maxConcurrency (T169): user-owned override reconciled across code-sync ──
{
  syncWorkflow({ name: 't-conc', maxConcurrency: 4, jobs: [{ job: 't-a' }] });
  assert.equal(getWorkflow('t-conc')?.max_concurrency, 4, 'manifest maxConcurrency seeded');
  assert.equal(getWorkflow('t-conc')?.max_concurrency_overridden, 0, 'not overridden initially');

  // a non-overridden value is refreshed by a code-sync (manifest changes to 8)
  syncWorkflow({ name: 't-conc', maxConcurrency: 8, jobs: [{ job: 't-a' }] });
  assert.equal(getWorkflow('t-conc')?.max_concurrency, 8, 'non-overridden value refreshes from manifest');

  // user edits → flips max_concurrency_overridden
  const updated = updateWorkflowConcurrency('t-conc', 2);
  assert.equal(updated?.max_concurrency, 2, 'updateWorkflowConcurrency sets the value');
  assert.equal(updated?.max_concurrency_overridden, 1, 'updateWorkflowConcurrency flips the override flag');

  // a CODE-sync now PRESERVES the user's value (the reconcile, like schedule/enabled)
  syncWorkflow({ name: 't-conc', maxConcurrency: 8, jobs: [{ job: 't-a' }] });
  assert.equal(getWorkflow('t-conc')?.max_concurrency, 2, 'overridden value survives re-sync');
  assert.equal(getWorkflow('t-conc')?.max_concurrency_overridden, 1, 'override flag survives re-sync');

  // invalid values are rejected (must be ≥ 1 OR exactly 0 = unlimited sentinel, T201)
  assert.throws(() => updateWorkflowConcurrency('t-conc', -1), /unlimited/, 'rejects negative');
  assert.throws(() => updateWorkflowConcurrency('t-conc', 1.5), /positive integer/, 'rejects non-integer');

  // unknown workflow → undefined (no row touched)
  assert.equal(updateWorkflowConcurrency('t-no-such-wf', 3), undefined, 'unknown workflow → undefined');
}
console.log('  ✓ updateWorkflowConcurrency: set + max_concurrency_overridden reconcile across sync (T169)');

// ── editable notifyEnabled (T285): user-owned override reconciled across code-sync ──
{
  syncWorkflow({ name: 't-notify', jobs: [{ job: 't-a' }] });
  assert.equal(getWorkflow('t-notify')?.notify_enabled, 1, 'default notifyEnabled ON when manifest omits it');
  assert.equal(getWorkflow('t-notify')?.notify_enabled_overridden, 0, 'not overridden initially');

  // manifest explicitly false is seeded (non-overridden)
  syncWorkflow({ name: 't-notify', notifyEnabled: false, jobs: [{ job: 't-a' }] });
  assert.equal(getWorkflow('t-notify')?.notify_enabled, 0, 'non-overridden value refreshes from manifest');

  // user edits → flips notify_enabled_overridden
  const updated = updateWorkflowNotifyEnabled('t-notify', true);
  assert.equal(updated?.notify_enabled, 1, 'updateWorkflowNotifyEnabled sets the value');
  assert.equal(updated?.notify_enabled_overridden, 1, 'updateWorkflowNotifyEnabled flips the override flag');

  // a CODE-sync now PRESERVES the user's value (the reconcile, like schedule/concurrency)
  syncWorkflow({ name: 't-notify', notifyEnabled: false, jobs: [{ job: 't-a' }] });
  assert.equal(getWorkflow('t-notify')?.notify_enabled, 1, 'overridden value survives re-sync');
  assert.equal(getWorkflow('t-notify')?.notify_enabled_overridden, 1, 'override flag survives re-sync');

  // unknown workflow → undefined (no row touched)
  assert.equal(updateWorkflowNotifyEnabled('t-no-such-wf', false), undefined, 'unknown workflow → undefined');
}
console.log('  ✓ updateWorkflowNotifyEnabled: set + notify_enabled_overridden reconcile across sync (T285)');

// ── manifest-owned category (T292): always tracks the manifest, no override ──
{
  syncWorkflow({ name: 't-cat-a', category: 'second-brain', jobs: [{ job: 't-a' }] });
  syncWorkflow({ name: 't-cat-b', jobs: [{ job: 't-a' }] });

  assert.equal(getWorkflow('t-cat-a')?.category, 'second-brain', 'category matches manifest value');
  assert.equal(getWorkflow('t-cat-b')?.category, 'uncategorized', 'omitted category defaults to uncategorized');

  const rows = listWorkflows();
  assert.equal(rows.find((r) => r.name === 't-cat-a')?.category, 'second-brain', 'listWorkflows surfaces category');

  // re-sync with a DIFFERENT category value updates the stored value (no preservation/override)
  syncWorkflow({ name: 't-cat-a', category: 'recommendations', jobs: [{ job: 't-a' }] });
  assert.equal(getWorkflow('t-cat-a')?.category, 'recommendations', 'category always tracks the manifest across re-sync');
}
console.log('  ✓ category: manifest-owned, always refreshed from code, defaults to uncategorized (T292)');

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

// ── skipped outcome: soft-stop for quota exhaustion (T225) ──
// `skipped` means "quota hit — retry on the next run when quota resets".
// It must NOT be treated as done, NOT appear in the stuck list, and NOT be
// confused with success (no real output was produced).
{
  syncJob({ name: 't-skipped', run: async () => {} });
  markWorkItem('t-skipped', 'quota-hit', 'skipped', { attempts: 0, detail: { name: 'Quota Place' } });
  markWorkItem('t-skipped', 'already-ok', 'success');
  markWorkItem('t-skipped', 'real-fail', 'failed', { attempts: 4 });

  // skipped is NOT done — item will be retried when quota resets
  assert.equal(isWorkItemDone('t-skipped', 'quota-hit', 4), false, 'skipped item is not done');
  assert.equal(isWorkItemDone('t-skipped', 'already-ok', 4), true, 'success item is done');

  // skipped is NOT stuck — stuck list only contains failed-exhausted rows
  const stuck = stuckItems().filter((i) => i.job_name === 't-skipped');
  assert.deepEqual(stuck.map((i) => i.item_key), ['real-fail'], 'skipped item absent from stuck list');
  assert.equal(stuckCount('t-skipped'), 1, 'skipped does not inflate stuck count');

  // skipped status is stored and readable
  const row = getWorkItem('t-skipped', 'quota-hit');
  assert.equal(row?.status, 'skipped');
  assert.equal(row?.attempts, 0, 'soft-stop records prior attempt count, not incremented');

  // re-marking the same item as skipped is idempotent (upsert updates updated_at)
  markWorkItem('t-skipped', 'quota-hit', 'skipped', { attempts: 0, detail: { name: 'Quota Place' } });
  assert.equal(getWorkItem('t-skipped', 'quota-hit')?.status, 'skipped');

  // clean up the failed row so it doesn't bleed into the bulk-unstick 'all' count below
  unstickWorkItem('t-skipped', 'real-fail');
}
console.log('  ✓ skipped outcome: not done, not stuck, retried on next run');

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
  // selectPendingRoots: fresh DB → first N candidates in input order.
  // Pipeline: sel-a (entry) → sel-b (terminal). terminalJobs = ['sel-b'].
  syncJob({ name: 'sel-a', run: async () => {} });
  syncJob({ name: 'sel-b', run: async () => {} });
  const members = ['sel-a', 'sel-b'];
  const terminal = ['sel-b'];
  const candidates = ['c1', 'c2', 'c3', 'c4', 'c5'];
  assert.deepEqual(selectPendingRoots(members, terminal, candidates, 2, 4), ['c1', 'c2'], 'fresh → first N in order');
  assert.deepEqual(selectPendingRoots(members, terminal, candidates, 0, 4), [], 'N=0 → none');

  // resumed: c1 fully done (terminal stage reached) is skipped;
  // c2 entry done BUT a descendant still outstanding → re-selected; c3 fresh.
  markWorkItem('sel-a', 'c1', 'success', { rootKey: 'c1' });
  markWorkItem('sel-b', 'c1-child', 'success', { rootKey: 'c1' });
  markWorkItem('sel-a', 'c2', 'success', { rootKey: 'c2' });
  markWorkItem('sel-b', 'c2-child', 'failed', { rootKey: 'c2', attempts: 1 }); // retryable → outstanding
  assert.deepEqual(
    selectPendingRoots(members, terminal, candidates, 2, 4),
    ['c2', 'c3'],
    'resumed → skips fully-done c1, re-selects c2 (outstanding descendant), then c3',
  );

  // a stuck descendant (failed past minAttempts) does NOT keep a root pending
  markWorkItem('sel-a', 'c4', 'success', { rootKey: 'c4' });
  markWorkItem('sel-b', 'c4-child', 'failed', { rootKey: 'c4', attempts: 4 }); // exhausted → done
  assert.deepEqual(selectPendingRoots(members, terminal, ['c4'], 5, 4), [], 'root with only exhausted descendants is done');

  // N larger than the pending count → all pending (no error)
  assert.deepEqual(selectPendingRoots(members, terminal, ['c2', 'c3', 'c5'], 99, 4), ['c2', 'c3', 'c5']);
}
console.log('  ✓ selectPendingRoots (fresh → first N · resumed skips done · N > pending → all)');

{
  // T163 regression: "pending" must be defined by propagation through the TERMINAL
  // stage, not merely past the entry stage. Three-stage pipeline:
  //   t163-entry (entry) → t163-mid → t163-term (terminal).
  syncJob({ name: 't163-entry', run: async () => {} });
  syncJob({ name: 't163-mid', run: async () => {} });
  syncJob({ name: 't163-term', run: async () => {} });
  const members = ['t163-entry', 't163-mid', 't163-term'];
  const terminal = ['t163-term'];

  // (1) THE BUG: entry succeeded, but NO row at any downstream/terminal stage
  // (models resolved-but-not-enriched). Pre-fix this looked "done" and was never
  // selected; it MUST now be pending.
  markWorkItem('t163-entry', 'rA', 'success', { rootKey: 'rA' });
  assert.deepEqual(
    selectPendingRoots(members, terminal, ['rA'], 5, 4),
    ['rA'],
    'entry-done with no downstream row → still pending (resolved-but-not-enriched)',
  );

  // (2) fully propagated: a done terminal row → NOT selected.
  markWorkItem('t163-entry', 'rB', 'success', { rootKey: 'rB' });
  markWorkItem('t163-mid', 'rB-m', 'success', { rootKey: 'rB' });
  markWorkItem('t163-term', 'rB-t', 'success', { rootKey: 'rB' });
  assert.deepEqual(selectPendingRoots(members, terminal, ['rB'], 5, 4), [], 'terminal-stage done → fully processed → not selected');

  // (3) an existing retryable-failed DOWNSTREAM row still makes the root pending
  // (preserve T094 behaviour).
  markWorkItem('t163-entry', 'rC', 'success', { rootKey: 'rC' });
  markWorkItem('t163-mid', 'rC-m', 'failed', { rootKey: 'rC', attempts: 1 }); // retryable
  assert.deepEqual(selectPendingRoots(members, terminal, ['rC'], 5, 4), ['rC'], 'retryable downstream row → pending');

  // (4) EDGE CASE — unprogressable/stuck root must NOT be re-selected forever:
  // entry succeeded, a MIDDLE stage failed past the budget (can never reach the
  // terminal), no retryable work left → treated as done.
  markWorkItem('t163-entry', 'rD', 'success', { rootKey: 'rD' });
  markWorkItem('t163-mid', 'rD-m', 'failed', { rootKey: 'rD', attempts: 4 }); // exhausted
  assert.deepEqual(selectPendingRoots(members, terminal, ['rD'], 5, 4), [], 'stuck-below-terminal root → done, not perpetually pending');

  // (4b) likewise a root IGNORED at a downstream stage (parked) is done, not pending.
  markWorkItem('t163-entry', 'rE', 'success', { rootKey: 'rE' });
  markWorkItem('t163-mid', 'rE-m', 'ignored', { rootKey: 'rE' });
  assert.deepEqual(selectPendingRoots(members, terminal, ['rE'], 5, 4), [], 'ignored-downstream root → done, not pending');

  // ordering across a mixed set: only the genuinely-pending roots, in input order.
  assert.deepEqual(
    selectPendingRoots(members, terminal, ['rA', 'rB', 'rC', 'rD', 'rE'], 99, 4),
    ['rA', 'rC'],
    'mixed set → only the un-propagated-but-progressable roots selected',
  );
}
console.log('  ✓ selectPendingRoots T163 (terminal-propagation pending semantics + unprogressable edge case)');

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

  // limit = 1 → select R1 only (terminal stage = fan-b)
  const selected = selectPendingRoots(members, ['fan-b'], roots, 1, 4);
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

// ── service `category` is manifest-owned only — always tracks code, no override (T305) ──
{
  syncService({ name: 't-cat-a', category: 'cli-tool', paid: false });
  syncService({ name: 't-cat-b', paid: false }); // no category set

  assert.equal(getServiceRow('t-cat-a')?.category, 'cli-tool', 'category matches manifest value');
  assert.equal(getServiceRow('t-cat-b')?.category, 'uncategorized', 'omitted category falls back to uncategorized');

  const listed = listServices();
  assert.equal(listed.find((s) => s.name === 't-cat-a')?.category, 'cli-tool');
  assert.equal(listed.find((s) => s.name === 't-cat-b')?.category, 'uncategorized');

  // re-sync with a DIFFERENT category value must update it — unlike rate/daily/monthly
  // caps, category has no `_overridden` column and no preservation behavior.
  syncService({ name: 't-cat-a', category: 'api', paid: false });
  assert.equal(getServiceRow('t-cat-a')?.category, 'api', 'category always tracks the latest manifest value');
}
console.log('  ✓ service category is manifest-owned, always refreshed on sync (T305)');

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

// ── T139: run-scoped Input→Output mapping via the work_item_runs linkage ──
// markWorkItem records WHICH workflow run advanced each item (from an explicit
// workflowRunId here; in production from LOCALJOBS_WORKFLOW_RUN_ID), and
// workItemIoRows(run) returns ONLY the roots that run advanced — never the global
// ledger. A run with no linkage (old/pre-feature or a re-run that did nothing new)
// returns empty + scoped:false instead of dumping everything.
{
  syncJob({ name: 't139-first', run: async () => {} });
  syncJob({ name: 't139-last', run: async () => {} });
  syncWorkflow({ name: 't139-wf', jobs: [{ job: 't139-first' }, { job: 't139-last', dependsOn: ['t139-first'] }] });

  const runA = createWorkflowRun('t139-wf', 'manual');
  const runB = createWorkflowRun('t139-wf', 'manual');

  // Run A advances roots r1, r2 through both stages; run B advances only r3.
  markWorkItem('t139-first', 'r1', 'success', { workflowRunId: runA });
  markWorkItem('t139-last', 'r1', 'success', { rootKey: 'r1', workflowRunId: runA, detail: { name: 'One' } });
  markWorkItem('t139-first', 'r2', 'success', { workflowRunId: runA });
  markWorkItem('t139-last', 'r2', 'success', { rootKey: 'r2', workflowRunId: runA });
  markWorkItem('t139-first', 'r3', 'success', { workflowRunId: runB });
  markWorkItem('t139-last', 'r3', 'success', { rootKey: 'r3', workflowRunId: runB });

  // 1. linkage rows recorded under the right run, keyed by the resolved root_key
  const linkA = db.prepare('SELECT DISTINCT root_key FROM work_item_runs WHERE workflow_run_id = ? ORDER BY root_key')
    .all(runA) as { root_key: string }[];
  assert.deepEqual(linkA.map((r) => r.root_key), ['r1', 'r2'], 'run A linkage holds exactly its two roots');

  // 2. NO linkage row when there is no run id (a standalone / non-workflow mark)
  markWorkItem('t139-first', 'standalone', 'success', { workflowRunId: null });
  const none = db.prepare("SELECT COUNT(*) AS n FROM work_item_runs WHERE item_key = 'standalone'").get() as { n: number };
  assert.equal(none.n, 0, 'a null-run mark records no linkage row');

  // 3. run-scoped query returns ONLY that run's roots (two runs see only their own)
  const ioA = workItemIoRows(['t139-first'], ['t139-last'], runA);
  assert.equal(ioA.scoped, true, 'run A result is scoped');
  assert.deepEqual(ioA.rows.map((r) => r.inputKey), ['r1', 'r2'], 'run A sees only r1, r2');
  assert.equal(ioA.rows[0].outputKey, 'r1', 'output resolved from the last-wave ledger by root');
  const ioB = workItemIoRows(['t139-first'], ['t139-last'], runB);
  assert.deepEqual(ioB.rows.map((r) => r.inputKey), ['r3'], 'run B sees only r3');

  // 4. a run with NO linkage (advanced nothing new / pre-feature) → empty, scoped:false, NO global dump
  const emptyRun = createWorkflowRun('t139-wf', 'manual');
  const ioEmpty = workItemIoRows(['t139-first'], ['t139-last'], emptyRun);
  assert.equal(ioEmpty.scoped, false, 'no-linkage run is not scoped');
  assert.equal(ioEmpty.rows.length, 0, 'no-linkage run does NOT dump the global ledger');

  // 5. legacy un-scoped call (no run id) still lists every first-wave input
  const ioAll = workItemIoRows(['t139-first'], ['t139-last']);
  assert.equal(ioAll.scoped, false, 'un-scoped call reports scoped:false');
  assert.ok(ioAll.rows.length >= 4, 'un-scoped lists all first-wave inputs (r1,r2,r3,standalone)');

  // 6. workflowHasRunLinkage distinguishes a workflow with linkage from a fresh one
  assert.equal(workflowHasRunLinkage('t139-wf'), true, 'workflow with linkage → true');
  syncWorkflow({ name: 't139-fresh', jobs: [{ job: 't139-first' }] });
  assert.equal(workflowHasRunLinkage('t139-fresh'), false, 'workflow with no runs/linkage → false');
}
console.log('  ✓ T139 run-scoped IO: work_item_runs linkage scopes workItemIoRows to the run');

// T210 — bulk-ignore resurface semantics: only the exact supplied keys are ignored;
// a NEW key for the same logical "collection" surfaces fresh.
{
  const JOB = 't210-notify';
  syncJob({ name: JOB, run: async () => {} });

  // Simulate 3 items in a collection being notified (success).
  markWorkItem(JOB, 'col:1', 'success');
  markWorkItem(JOB, 'col:2', 'success');
  markWorkItem(JOB, 'col:3', 'success');

  // Owner dismisses the whole collection via bulk-ignore.
  const affected = ignoreSurfacedItems(JOB, ['col:1', 'col:2', 'col:3']);
  assert.equal(affected, 3, 'ignoreSurfacedItems returns 3 for 3 keys');

  // All three are now ignored.
  assert.ok(isWorkItemDone(JOB, 'col:1', 1), 'col:1 is done (ignored)');
  assert.ok(isWorkItemDone(JOB, 'col:2', 1), 'col:2 is done (ignored)');
  assert.ok(isWorkItemDone(JOB, 'col:3', 1), 'col:3 is done (ignored)');
  const keys = ignoredItemKeys(JOB);
  assert.ok(keys.has('col:1') && keys.has('col:2') && keys.has('col:3'), 'all three appear in ignoredItemKeys');

  // A NEW item key for the same collection is NOT affected by the bulk-ignore.
  assert.ok(!isWorkItemDone(JOB, 'col:4', 1), 'col:4 (new gap) is NOT treated as done');
  assert.ok(!keys.has('col:4'), 'col:4 does NOT appear in ignoredItemKeys');

  // Idempotency: re-ignoring the same keys is a no-op (still = 3 rows changed).
  const idempotent = ignoreSurfacedItems(JOB, ['col:1', 'col:2', 'col:3']);
  assert.equal(idempotent, 3, 'ignoreSurfacedItems is idempotent (ON CONFLICT upsert)');

  // Empty array returns 0.
  assert.equal(ignoreSurfacedItems(JOB, []), 0, 'empty key array returns 0');
}
console.log('  ✓ T210 ignoreSurfacedItems: bulk-dismiss ignores only supplied keys, new keys surface fresh');

// T258 — noop detection helpers: root-with-skipped not re-selected,
// hasJobAdvancedAnyItem, workflowRunAdvancedAnyItem, setRunNoop.
{
  // Jobs + workflow for T258 tests.
  const FIRST_JOB = 't258-first';
  const SECOND_JOB = 't258-second';
  syncJob({ name: FIRST_JOB, run: async () => {} });
  syncJob({ name: SECOND_JOB, run: async () => {} });
  syncWorkflow({ name: 't258-wf', jobs: [{ job: FIRST_JOB }, { job: SECOND_JOB, dependsOn: [FIRST_JOB] }] });

  // ── 1. selectPendingRoots: a root with only 'skipped' items is NOT re-selected ──
  // Mark r1 with 'skipped' (quota soft-stop) in the first stage.
  markWorkItem(FIRST_JOB, 'r1', 'skipped', { rootKey: 'r1' });
  // Mark r2 with 'success' in the second (terminal) stage — fully done.
  markWorkItem(FIRST_JOB, 'r2', 'success', { rootKey: 'r2' });
  markWorkItem(SECOND_JOB, 'r2', 'success', { rootKey: 'r2' });
  // Mark r3 as genuinely pending (first stage done, second stage not started).
  markWorkItem(FIRST_JOB, 'r3', 'success', { rootKey: 'r3' });

  const candidates = ['r1', 'r2', 'r3'];
  const terminalJobs = [SECOND_JOB];
  const memberJobs = [FIRST_JOB, SECOND_JOB];
  const selected = selectPendingRoots(memberJobs, terminalJobs, candidates, 10, 4);

  assert.ok(!selected.includes('r1'), 'r1 (only skipped items) is NOT re-selected (T258)');
  assert.ok(!selected.includes('r2'), 'r2 (fully done through terminal stage) is not selected');
  assert.ok(selected.includes('r3'), 'r3 (pending downstream) IS selected');

  // ── 2. hasJobAdvancedAnyItem / workflowRunAdvancedAnyItem ──
  const wfRunId = createWorkflowRun('t258-wf', 'manual');

  // Nothing advanced yet → both false.
  assert.equal(hasJobAdvancedAnyItem(wfRunId, FIRST_JOB), false, 'hasJobAdvancedAnyItem false before any markWorkItem');
  assert.equal(workflowRunAdvancedAnyItem(wfRunId), false, 'workflowRunAdvancedAnyItem false before any markWorkItem');

  // Advance one item in FIRST_JOB.
  markWorkItem(FIRST_JOB, 'r3', 'success', { rootKey: 'r3', workflowRunId: wfRunId });
  assert.equal(hasJobAdvancedAnyItem(wfRunId, FIRST_JOB), true, 'hasJobAdvancedAnyItem true after markWorkItem');
  assert.equal(hasJobAdvancedAnyItem(wfRunId, SECOND_JOB), false, 'hasJobAdvancedAnyItem false for a different job that did nothing');
  assert.equal(workflowRunAdvancedAnyItem(wfRunId), true, 'workflowRunAdvancedAnyItem true after first job advanced');

  // ── 3. setRunNoop marks the run 'skipped' in the DB ──
  const memberRunId = createRun(SECOND_JOB, 'workflow', 1, wfRunId);
  finishRun(memberRunId, 'success', { exitCode: 0 });
  setRunNoop(memberRunId);
  const runs = listRunsForWorkflowRun(wfRunId);
  const noopRun = runs.find((r) => r.id === memberRunId);
  assert.equal(noopRun?.status, 'skipped', 'setRunNoop changes the run status to skipped');
}
console.log('  ✓ T258 noop detection: skipped items not re-selected, hasJobAdvancedAnyItem, workflowRunAdvancedAnyItem, setRunNoop');

// T336 — full-delete admin helpers: deleteWorkflowCompletely / deleteJobCompletely / deleteServiceCompletely.
{
  // Target workflow/job/service (to be deleted) + an untouched sibling (to prove scoping).
  syncJob({ name: 't336-target-job', run: async () => {} });
  syncJob({ name: 't336-other-job', run: async () => {} });
  syncWorkflow({ name: 't336-target-wf', jobs: [{ job: 't336-target-job' }] });
  syncWorkflow({ name: 't336-other-wf', jobs: [{ job: 't336-other-job' }] });
  syncService({ name: 't336-target-svc', ratePerMinute: 5, paid: false });
  syncService({ name: 't336-other-svc', ratePerMinute: 5, paid: false });

  // work_items + work_item_runs for the target job.
  const wfRunId = createWorkflowRun('t336-target-wf', 'manual');
  markWorkItem('t336-target-job', 'item-1', 'success', { workflowRunId: wfRunId });
  markWorkItem('t336-other-job', 'item-1', 'success');

  // runs + run_logs for the target job.
  const runId = createRun('t336-target-job', 'workflow', 1, wfRunId);
  addWorkflowLog(wfRunId, 'a log line for the target run');
  finishRun(runId, 'success', { exitCode: 0 });
  finishWorkflowRun(wfRunId, 'success');
  const otherWfRunId = createWorkflowRun('t336-other-wf', 'manual');
  const otherRunId = createRun('t336-other-job', 'workflow', 1, otherWfRunId);
  finishRun(otherRunId, 'success', { exitCode: 0 });
  finishWorkflowRun(otherWfRunId, 'success');

  // service_usage + service_consumers for the target service.
  recordServiceCall('t336-target-svc');
  recordServiceCall('t336-target-svc');
  recordServiceConsumer('t336-target-svc', 't336-target-job');
  recordServiceCall('t336-other-svc');
  recordServiceConsumer('t336-other-svc', 't336-other-job');

  // ── deleteWorkflowCompletely removes the workflow + its runs, leaves the sibling ──
  const wfResult = deleteWorkflowCompletely('t336-target-wf');
  assert.equal(wfResult.workflows, 1, 'workflows row deleted');
  assert.equal(wfResult.workflowJobs, 1, 'workflow_jobs row deleted');
  assert.equal(wfResult.workflowRuns, 1, 'workflow_runs row deleted');
  assert.equal(wfResult.workflowRunLogs, 1, 'workflow_run_logs row deleted');
  assert.equal(getWorkflow('t336-target-wf'), undefined, 'workflow gone');
  assert.equal(getWorkflowRun(wfRunId), undefined, 'workflow run gone');
  assert.ok(getWorkflow('t336-other-wf'), 'sibling workflow untouched');
  assert.ok(getWorkflowRun(otherWfRunId), 'sibling workflow run untouched');

  // ── deleteJobCompletely removes the job + its runs/work_items, leaves the sibling ──
  const jobResult = deleteJobCompletely('t336-target-job');
  assert.equal(jobResult.jobs, 1, 'jobs row deleted');
  assert.equal(jobResult.runs, 1, 'runs row deleted');
  assert.equal(jobResult.runLogs, 0, 'run_logs deleted (or already none for this run)');
  assert.equal(jobResult.workItems, 1, 'work_items row deleted');
  assert.equal(jobResult.workItemRuns, 1, 'work_item_runs row deleted');
  assert.equal(getJob('t336-target-job'), undefined, 'job gone');
  assert.equal(getWorkItem('t336-target-job', 'item-1'), undefined, 'work item gone');
  assert.ok(getJob('t336-other-job'), 'sibling job untouched');
  assert.ok(getWorkItem('t336-other-job', 'item-1'), 'sibling work item untouched');

  // ── deleteServiceCompletely removes the service + usage/consumers, leaves the sibling ──
  const svcResult = deleteServiceCompletely('t336-target-svc');
  assert.equal(svcResult.services, 1, 'services row deleted');
  assert.equal(svcResult.serviceConsumers, 1, 'service_consumers row deleted');
  assert.equal(svcResult.serviceUsage, 2, 'service_usage rows deleted');
  assert.equal(serviceCallsThisMonth('t336-target-svc'), 0, 'target service usage gone');
  assert.equal(listServiceConsumers('t336-target-svc').length, 0, 'target service consumers gone');
  assert.equal(serviceCallsThisMonth('t336-other-svc'), 1, 'sibling service usage untouched');
  assert.equal(listServiceConsumers('t336-other-svc').length, 1, 'sibling service consumers untouched');

  // ── idempotency: a second call on an already-deleted name is a no-op ──
  assert.deepEqual(
    deleteWorkflowCompletely('t336-target-wf'),
    { workflows: 0, workflowJobs: 0, workflowRuns: 0, workflowRunLogs: 0 },
    'deleteWorkflowCompletely no-op on second call',
  );
  assert.deepEqual(
    deleteJobCompletely('t336-target-job'),
    { jobs: 0, runs: 0, runLogs: 0, workItems: 0, workItemRuns: 0 },
    'deleteJobCompletely no-op on second call',
  );
  assert.deepEqual(
    deleteServiceCompletely('t336-target-svc'),
    { services: 0, serviceConsumers: 0, serviceUsage: 0 },
    'deleteServiceCompletely no-op on second call',
  );

  // Also no-op for a name that never existed.
  assert.deepEqual(
    deleteWorkflowCompletely('t336-never-existed'),
    { workflows: 0, workflowJobs: 0, workflowRuns: 0, workflowRunLogs: 0 },
    'deleteWorkflowCompletely no-op for unknown name',
  );
}
console.log('  ✓ T336 full-delete admin helpers: deleteWorkflowCompletely / deleteJobCompletely / deleteServiceCompletely (cross-table cleanup + idempotency)');

{
  // ── T352 deleteNullDetailSuccessItems: recover rows a bug wrongly marked success ──
  markWorkItem('t352-job', 'null-1', 'success', { detail: { name: 'null-1', industry: null } });
  markWorkItem('t352-job', 'null-2', 'success', { detail: { name: 'null-2', industry: null } });
  markWorkItem('t352-job', 'real-1', 'success', { detail: { name: 'real-1', industry: 'Technology' } });
  markWorkItem('t352-job', 'no-detail', 'success');
  markWorkItem('t352-other-job', 'null-3', 'success', { detail: { name: 'null-3', industry: null } });

  const removed = deleteNullDetailSuccessItems('t352-job', 'industry');
  assert.deepEqual(removed.sort(), ['null-1', 'null-2'], 'only null-industry rows for the target job are removed');
  assert.equal(isWorkItemDone('t352-job', 'null-1', 3), false, 'null-1 no longer done — will retry');
  assert.equal(isWorkItemDone('t352-job', 'null-2', 3), false, 'null-2 no longer done — will retry');
  assert.equal(isWorkItemDone('t352-job', 'real-1', 1), true, 'real-1 (non-null) untouched');
  assert.equal(isWorkItemDone('t352-job', 'no-detail', 1), true, 'no-detail row untouched');
  assert.equal(isWorkItemDone('t352-other-job', 'null-3', 3), true, 'a different job_name is untouched even with the same field/value');

  // Idempotent: a second call on the now-clean state removes nothing.
  assert.deepEqual(deleteNullDetailSuccessItems('t352-job', 'industry'), [], 'second call is a no-op');
}
console.log('  ✓ T352 deleteNullDetailSuccessItems: removes only null-field success rows for the given job, idempotent, leaves other jobs untouched');
