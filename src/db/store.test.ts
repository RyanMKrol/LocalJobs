// Store tests for the pipeline + service helpers. Runs against the scratch DB set
// by `npm test` (LOCALJOBS_DB). Self-asserting: throws on failure.
import assert from 'node:assert/strict';
import {
  addPipelineLog, backfillServiceUsage, createPipelineRun, createRun, finishPipelineRun, finishRun,
  getPipeline, getPipelineJobs, getPipelineLogs, getPipelineRun, getServiceRow, getWorkItem, hasActivePipelineRun,
  dismissWorkItem, isWorkItemDone,
  listRunsForPipelineRun, listServices, markWorkItem, orphanedWorkItems, pipelineRetryableCount,
  pruneOrphanedWorkItems, reapOrphanPipelineRuns, recordServiceCall, recordSkippedRun, recordUsage,
  serviceCallsThisMonth, serviceCallsToday, stuckCount, stuckItems, syncJob, syncPipeline, syncService,
  tryReserveMinInterval, tryReserveServiceSlot, unstickWorkItem, updateServiceLimits, usageThisMonth,
} from './store.js';
import { callService, QuotaExceededError, registerService } from '../core/services.js';

// member jobs must exist (runs.job_name FK → jobs.name)
for (const n of ['t-a', 't-b', 't-c']) syncJob({ name: n, run: async () => {} });

// pipeline sync + edges
syncPipeline({ name: 't-pipe', description: 'd', schedule: '0 2 * * *', jobs: [{ job: 't-a' }, { job: 't-b', dependsOn: ['t-a'] }] });
assert.equal(getPipeline('t-pipe')?.schedule, '0 2 * * *');
assert.deepEqual(getPipelineJobs('t-pipe'), [{ job_name: 't-a', depends_on: [] }, { job_name: 't-b', depends_on: ['t-a'] }]);

// re-sync replaces membership/edges
syncPipeline({ name: 't-pipe', jobs: [{ job: 't-a' }, { job: 't-b' }, { job: 't-c', dependsOn: ['t-a'] }] });
assert.equal(getPipelineJobs('t-pipe').length, 3);

// pipeline run + linked member runs + skip + logs
const pr = createPipelineRun('t-pipe', 'manual');
assert.ok(hasActivePipelineRun('t-pipe'));
const r1 = createRun('t-a', 'pipeline', 1, pr);
finishRun(r1, 'success', { exitCode: 0 });
recordSkippedRun('t-c', pr, 'skipped: upstream t-a did not succeed');
const members = listRunsForPipelineRun(pr);
assert.equal(members.length, 2);
assert.ok(members.some((m) => m.status === 'skipped'));
assert.equal(members.find((m) => m.status === 'success')?.pipeline_run_id, pr);
addPipelineLog(pr, 'stage t-a finished');
assert.equal(getPipelineLogs(pr).length, 1);
finishPipelineRun(pr, 'partial');
assert.equal(getPipelineRun(pr)?.status, 'partial');
assert.ok(!hasActivePipelineRun('t-pipe'));

// orphan reaping
const pr2 = createPipelineRun('t-pipe', 'manual');
assert.ok(reapOrphanPipelineRuns() >= 1);
assert.equal(getPipelineRun(pr2)?.status, 'cancelled');
assert.equal(pipelineRetryableCount(['t-a', 't-b', 't-c'], 4), 0);

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

console.log('  ✓ store pipeline + service helpers');

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

// ── dismissWorkItem: manually park a stuck item permanently (T017) ──
// Genuinely-bad-data items that will never process must be removable from the
// stuck list by hand — never automatically — and distinct from unstick/retry.
{
  syncJob({ name: 't-dismiss', run: async () => {} });
  markWorkItem('t-dismiss', 'bad-1', 'failed', { attempts: 4 }); // stuck
  markWorkItem('t-dismiss', 'bad-2', 'failed', { attempts: 4 }); // stuck
  markWorkItem('t-dismiss', 'ok-1', 'success');

  const stuckBefore = stuckItems().filter((i) => i.job_name === 't-dismiss');
  assert.deepEqual(stuckBefore.map((i) => i.item_key).sort(), ['bad-1', 'bad-2']);
  assert.equal(stuckCount('t-dismiss'), 2);

  // dismiss bad-1 → row updated, parked as 'dismissed'
  assert.equal(dismissWorkItem('t-dismiss', 'bad-1'), 1);
  assert.equal(getWorkItem('t-dismiss', 'bad-1')?.status, 'dismissed');

  // dismissed item is gone from the stuck list and the count
  const stuckAfter = stuckItems().filter((i) => i.job_name === 't-dismiss');
  assert.deepEqual(stuckAfter.map((i) => i.item_key), ['bad-2'], 'dismissed item left the stuck list');
  assert.equal(stuckCount('t-dismiss'), 1);

  // a dismissed item counts as done — never reprocessed on a re-run
  assert.equal(isWorkItemDone('t-dismiss', 'bad-1', 4), true, 'dismissed = done, never reprocessed');

  // dismiss only acts on a failed row: a no-op on success, and idempotent on
  // an already-dismissed row (it's no longer 'failed')
  assert.equal(dismissWorkItem('t-dismiss', 'ok-1'), 0, 'cannot dismiss a success');
  assert.equal(getWorkItem('t-dismiss', 'ok-1')?.status, 'success');
  assert.equal(dismissWorkItem('t-dismiss', 'bad-1'), 0, 'already dismissed → no-op');
  assert.equal(dismissWorkItem('t-dismiss', 'never-existed'), 0, 'unknown key → no-op');

  // distinct from unstick: unstick DELETES (to retry), dismiss PARKS (kept, done).
  // unstick won't touch a dismissed row; the still-stuck bad-2 can be unstuck.
  assert.equal(unstickWorkItem('t-dismiss', 'bad-1'), 0, 'unstick does not delete a dismissed row');
  assert.ok(getWorkItem('t-dismiss', 'bad-1'), 'dismissed row still present after unstick attempt');
  assert.equal(unstickWorkItem('t-dismiss', 'bad-2'), 1, 'a still-stuck item can be unstuck');
  assert.equal(getWorkItem('t-dismiss', 'bad-2'), undefined, 'unstick removed the stuck row');
}
console.log('  ✓ dismissWorkItem parks a stuck item (manual, distinct from unstick, stays off stuck list)');

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
