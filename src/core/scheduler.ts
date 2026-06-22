import { Cron } from 'croner';
import { getPipeline } from '../db/store.js';
import { pipelines } from '../jobs/registry.js';
import { runPipeline } from './pipeline-executor.js';
import type { PipelineDefinition } from './types.js';

const pipelineCrons = new Map<string, Cron>();

/**
 * Register cron triggers for scheduled pipelines. There are NO standalone jobs:
 * every job belongs to a pipeline (a single job is a one-stage pipeline), and the
 * pipeline is the only thing that owns a schedule — it drives its member jobs.
 * Each fire checks the live `enabled` flag so dashboard toggles take effect
 * without a restart.
 */
export function startScheduler(): void {
  for (const def of pipelines) {
    if (!def.schedule) continue;
    schedulePipeline(def);
  }
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

/**
 * Next scheduled fire time for a job. Always null: jobs have no schedule of their
 * own — the pipeline they belong to drives them — so a job never has a standalone
 * next-run. Kept so the job API view can report "next run" uniformly.
 */
export function nextRun(_jobName: string): string | null {
  return null;
}

/** Next scheduled fire time for a pipeline, if any. */
export function nextPipelineRun(name: string): string | null {
  return pipelineCrons.get(name)?.nextRun()?.toISOString() ?? null;
}

export function stopScheduler(): void {
  for (const cron of pipelineCrons.values()) cron.stop();
  pipelineCrons.clear();
}
