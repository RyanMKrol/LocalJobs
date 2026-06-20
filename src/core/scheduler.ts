import { Cron } from 'croner';
import { getJob } from '../db/store.js';
import { runJob } from './executor.js';
import { jobs } from '../jobs/registry.js';
import type { JobDefinition } from './types.js';

const crons = new Map<string, Cron>();

/**
 * Register cron triggers for every job that has a schedule. Each fire checks
 * the live `enabled` flag (so dashboard toggles take effect without a restart)
 * and delegates to the executor, which handles overlap prevention.
 */
export function startScheduler(): void {
  for (const def of jobs) {
    if (!def.schedule) continue;
    scheduleJob(def);
  }
}

function scheduleJob(def: JobDefinition): void {
  const cron = new Cron(def.schedule as string, { name: def.name }, async () => {
    const row = getJob(def.name);
    if (!row || row.enabled === 0) return; // respect user toggle
    const result = await runJob(def, 'schedule');
    if (result.skipped) {
      console.log(`[scheduler] ${def.name} skipped: ${result.reason}`);
    }
  });
  crons.set(def.name, cron);
  console.log(`[scheduler] ${def.name} scheduled (${def.schedule}); next: ${cron.nextRun()?.toISOString() ?? 'n/a'}`);
}

/** Next scheduled fire time for a job, if it has one. */
export function nextRun(jobName: string): string | null {
  return crons.get(jobName)?.nextRun()?.toISOString() ?? null;
}

export function stopScheduler(): void {
  for (const cron of crons.values()) cron.stop();
  crons.clear();
}
