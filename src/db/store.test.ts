// Store tests for the pipeline + service helpers. Runs against the scratch DB set
// by `npm test` (LOCALJOBS_DB). Self-asserting: throws on failure.
import assert from 'node:assert/strict';
import {
  addPipelineLog, createPipelineRun, createRun, finishPipelineRun, finishRun, getPipeline,
  getPipelineJobs, getPipelineLogs, getPipelineRun, hasActivePipelineRun, listRunsForPipelineRun,
  listServices, pipelineRetryableCount, reapOrphanPipelineRuns, recordServiceCall, recordSkippedRun,
  serviceCallsToday, syncJob, syncPipeline, syncService, tryReserveServiceSlot,
} from './store.js';

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

console.log('  ✓ store pipeline + service helpers');
