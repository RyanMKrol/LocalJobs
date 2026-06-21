// Store tests for the pipeline + service helpers. Runs against the scratch DB set
// by `npm test` (LOCALJOBS_DB). Self-asserting: throws on failure.
import assert from 'node:assert/strict';
import {
  addPipelineLog, backfillServiceUsage, createPipelineRun, createRun, finishPipelineRun, finishRun,
  getPipeline, getPipelineJobs, getPipelineLogs, getPipelineRun, hasActivePipelineRun,
  listRunsForPipelineRun, listServices, pipelineRetryableCount, reapOrphanPipelineRuns,
  recordServiceCall, recordSkippedRun, recordUsage, serviceCallsThisMonth, serviceCallsToday,
  syncJob, syncPipeline, syncService, tryReserveMinInterval, tryReserveServiceSlot, usageThisMonth,
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
