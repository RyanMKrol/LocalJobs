import { Cron } from 'croner';
import { getWorkflow } from '../db/store.js';
import { workflows } from '../jobs/registry.js';
import { runWorkflow } from './workflow-executor.js';
import type { WorkflowDefinition } from './types.js';

const workflowCrons = new Map<string, Cron>();

/**
 * Register cron triggers for scheduled workflows. There are NO standalone jobs:
 * every job belongs to a workflow (a single job is a one-stage workflow), and the
 * workflow is the only thing that owns a schedule — it drives its member jobs.
 * Each fire checks the live `enabled` flag so dashboard toggles take effect
 * without a restart.
 */
export function startScheduler(): void {
  for (const def of workflows) {
    if (!def.schedule) continue;
    scheduleWorkflow(def);
  }
}

function scheduleWorkflow(def: WorkflowDefinition): void {
  const cron = new Cron(def.schedule as string, { name: `workflow:${def.name}` }, async () => {
    const row = getWorkflow(def.name);
    if (!row || row.enabled === 0) return; // respect user toggle
    const result = await runWorkflow(def, 'schedule');
    if (result.skipped) console.log(`[scheduler] workflow ${def.name} skipped: ${result.reason}`);
  });
  workflowCrons.set(def.name, cron);
  console.log(`[scheduler] workflow ${def.name} scheduled (${def.schedule}); next: ${cron.nextRun()?.toISOString() ?? 'n/a'}`);
}

/**
 * Next scheduled fire time for a job. Always null: jobs have no schedule of their
 * own — the workflow they belong to drives them — so a job never has a standalone
 * next-run. Kept so the job API view can report "next run" uniformly.
 */
export function nextRun(_jobName: string): string | null {
  return null;
}

/** Next scheduled fire time for a workflow, if any. */
export function nextWorkflowRun(name: string): string | null {
  return workflowCrons.get(name)?.nextRun()?.toISOString() ?? null;
}

export function stopScheduler(): void {
  for (const cron of workflowCrons.values()) cron.stop();
  workflowCrons.clear();
}
