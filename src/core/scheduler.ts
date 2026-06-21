import { Cron } from 'croner';
import { getJob, getPipeline } from '../db/store.js';
import { jobs, memberJobNames, pipelines } from '../jobs/registry.js';
import { runJob } from './executor.js';
import { runPipeline } from './pipeline-executor.js';
import type { JobDefinition, PipelineDefinition } from './types.js';

const crons = new Map<string, Cron>();
const pipelineCrons = new Map<string, Cron>();

/**
 * Register cron triggers for scheduled pipelines and standalone jobs. A job that
 * belongs to a pipeline does NOT get its own cron — the pipeline drives it.
 * Each fire checks the live `enabled` flag so dashboard toggles take effect
 * without a restart.
 */
export function startScheduler(): void {
  const members = memberJobNames();
  for (const def of jobs) {
    if (!def.schedule) continue;
    if (members.has(def.name)) {
      console.log(`[scheduler] ${def.name} is a pipeline member — own schedule suppressed (the pipeline drives it)`);
      continue;
    }
    scheduleJob(def);
  }
  for (const def of pipelines) {
    if (!def.schedule) continue;
    schedulePipeline(def);
  }
}

function scheduleJob(def: JobDefinition): void {
  const cron = new Cron(def.schedule as string, { name: def.name }, async () => {
    const row = getJob(def.name);
    if (!row || row.enabled === 0) return; // respect user toggle
    const result = await runJob(def, 'schedule');
    if (result.skipped) console.log(`[scheduler] ${def.name} skipped: ${result.reason}`);
  });
  crons.set(def.name, cron);
  console.log(`[scheduler] ${def.name} scheduled (${def.schedule}); next: ${cron.nextRun()?.toISOString() ?? 'n/a'}`);
}

function schedulePipeline(def: PipelineDefinition): void {
  const cron = new Cron(def.schedule as string, { name: `pipeline:${def.name}` }, async () => {
    const row = getPipeline(def.name);
    if (!row || row.enabled === 0) return; // respect user toggle
    const result = await runPipeline(def, 'schedule');
    if (result.skipped) console.log(`[scheduler] pipeline ${def.name} skipped: ${result.reason}`);
  });
  pipelineCrons.set(def.name, cron);
  console.log(`[scheduler] pipeline ${def.name} scheduled (${def.schedule}); next: ${cron.nextRun()?.toISOString() ?? 'n/a'}`);
}

/** Next scheduled fire time for a standalone job, if any. */
export function nextRun(jobName: string): string | null {
  return crons.get(jobName)?.nextRun()?.toISOString() ?? null;
}

/** Next scheduled fire time for a pipeline, if any. */
export function nextPipelineRun(name: string): string | null {
  return pipelineCrons.get(name)?.nextRun()?.toISOString() ?? null;
}

export function stopScheduler(): void {
  for (const cron of crons.values()) cron.stop();
  for (const cron of pipelineCrons.values()) cron.stop();
  crons.clear();
  pipelineCrons.clear();
}
