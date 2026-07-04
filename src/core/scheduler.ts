import { Cron } from 'croner';
import { getWorkflow } from '../db/store.js';
import { getWorkflowDefinition, workflows } from '../workflows/registry.js';
import { runWorkflow } from './workflow-executor.js';
import type { WorkflowDefinition } from './types.js';

const workflowCrons = new Map<string, Cron>();

/**
 * Register cron triggers for scheduled workflows. There are NO standalone jobs:
 * every job belongs to a workflow (a single job is a one-stage workflow), and the
 * workflow is the only thing that owns a schedule — it drives its member jobs.
 *
 * The schedule is read from the workflow's DB row (the EFFECTIVE schedule), NOT
 * `def.schedule` directly: after the upsert reconcile (T135) that value is the
 * user's override when set, else the code default. The daemon syncs all workflows
 * to the DB before calling this, so the rows exist. Each fire checks the live
 * `enabled` flag so dashboard toggles take effect without a restart.
 */
export function startScheduler(): void {
  for (const def of workflows) {
    const effective = effectiveSchedule(def);
    if (!effective) continue;
    scheduleWorkflow(def, effective);
  }
}

/** The EFFECTIVE schedule for a workflow: the DB row's value (override or synced
 *  code default), falling back to `def.schedule` if no row exists yet. */
function effectiveSchedule(def: WorkflowDefinition): string | null {
  const row = getWorkflow(def.name);
  return (row ? row.schedule : def.schedule) ?? null;
}

function scheduleWorkflow(def: WorkflowDefinition, schedule: string): void {
  const cron = new Cron(schedule, { name: `workflow:${def.name}` }, async () => {
    const row = getWorkflow(def.name);
    if (!row || row.enabled === 0) return; // respect user toggle
    const result = await runWorkflow(def, 'schedule');
    if (result.skipped) console.log(`[scheduler] workflow ${def.name} skipped: ${result.reason}`);
  });
  workflowCrons.set(def.name, cron);
  console.log(`[scheduler] workflow ${def.name} scheduled (${schedule}); next: ${cron.nextRun()?.toISOString() ?? 'n/a'}`);
}

/**
 * Re-register a workflow's cron LIVE after its schedule is edited (T135), so an
 * edit takes effect without a daemon restart — the same way the fire-time `enabled`
 * check does. Stops + removes any existing cron; if `schedule` is non-null and the
 * workflow is still in the registry, registers a fresh cron reusing the same fire
 * callback. A null schedule leaves it unregistered (manual-only). No-ops on an
 * unknown workflow (not in the registry).
 */
export function rescheduleWorkflow(name: string, schedule: string | null): void {
  const existing = workflowCrons.get(name);
  if (existing) {
    existing.stop();
    workflowCrons.delete(name);
  }
  if (!schedule) {
    console.log(`[scheduler] workflow ${name} rescheduled to manual-only (no cron)`);
    return;
  }
  const def = getWorkflowDefinition(name);
  if (!def) return; // unknown workflow — nothing to fire
  scheduleWorkflow(def, schedule);
}

/** Next scheduled fire time for a workflow, if any. */
export function nextWorkflowRun(name: string): string | null {
  return workflowCrons.get(name)?.nextRun()?.toISOString() ?? null;
}

export function stopScheduler(): void {
  for (const cron of workflowCrons.values()) cron.stop();
  workflowCrons.clear();
}
