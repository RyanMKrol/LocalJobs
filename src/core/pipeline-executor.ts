import { getJobDefinition } from '../jobs/registry.js';
import {
  addPipelineLog,
  createPipelineRun,
  finishPipelineRun,
  hasActivePipelineRun,
  pipelineRetryableCount,
  recordSkippedRun,
  setPipelineProgress,
} from '../db/store.js';
import { type Dag, buildDag, executeDag } from './dag.js';
import { runJobForPipeline } from './executor.js';
import { notifyPipeline, notifyStage } from './notifier.js';
import type { LogLevel, PipelineDefinition, PipelineRunStatus, RunStatus } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PipelineRunResult {
  pipelineRunId: string | null;
  skipped?: boolean;
  reason?: string;
}

/**
 * Run a pipeline: execute its DAG (one topological pass), optionally repeating in
 * cycles until no retryable work remains. The daemon owns this (it's the DB
 * writer). Member job runs link to the pipeline run; the pipeline emits per-stage
 * + aggregate notifications and writes framework logs.
 */
export async function runPipeline(def: PipelineDefinition, trigger: 'schedule' | 'manual'): Promise<PipelineRunResult> {
  if (hasActivePipelineRun(def.name)) {
    return { pipelineRunId: null, skipped: true, reason: 'already running' };
  }

  let dag: Dag;
  try {
    dag = buildDag(def.jobs);
  } catch (e) {
    const id = createPipelineRun(def.name, trigger);
    addPipelineLog(id, `Invalid pipeline DAG: ${e instanceof Error ? e.message : e}`, 'error');
    finishPipelineRun(id, 'failed');
    return { pipelineRunId: id };
  }

  const pipelineRunId = createPipelineRun(def.name, trigger);
  const log = (m: string, level: LogLevel = 'info') => addPipelineLog(pipelineRunId, m, level);
  const total = dag.nodes.length;
  const memberNames = def.jobs.map((j) => j.job);
  const minAttempts = def.minAttempts ?? 4;
  const maxCycles = def.repeatUntilStable ? Math.max(1, def.maxCycles ?? 1) : 1;

  log(`Pipeline "${def.name}" started · ${total} job(s) · trigger=${trigger}${def.repeatUntilStable ? ` · repeatUntilStable (maxCycles=${maxCycles})` : ''}`);

  let lastStatuses = new Map<string, RunStatus>();
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    if (def.repeatUntilStable) log(`──── cycle ${cycle}/${maxCycles} ────`);
    let settled = 0;

    lastStatuses = await executeDag(dag, {
      concurrency: def.maxConcurrency ?? 1,
      runOne: async (job) => {
        const jd = getJobDefinition(job);
        if (!jd) {
          log(`job "${job}" has no definition — failing it`, 'error');
          return 'failed';
        }
        const { status } = await runJobForPipeline(jd, pipelineRunId);
        return status;
      },
      onStart: (job) => log(`▶ ${job} started`),
      onSettle: async (job, s) => {
        settled++;
        setPipelineProgress(pipelineRunId, (settled / total) * 100, `${settled}/${total} stages (${job} ${s})`);
        log(`${s === 'success' ? '✓' : '✗'} ${job} → ${s}`, s === 'success' ? 'info' : 'warn');
        await notifyStage(def.name, pipelineRunId, job, s, log);
      },
      onSkip: async (job, reason) => {
        settled++;
        recordSkippedRun(job, pipelineRunId, `skipped: ${reason}`);
        setPipelineProgress(pipelineRunId, (settled / total) * 100, `${settled}/${total} stages (${job} skipped)`);
        log(`⊘ ${job} skipped — ${reason}`, 'warn');
        await notifyStage(def.name, pipelineRunId, job, 'skipped', log);
      },
    });

    if (!def.repeatUntilStable) break;
    const retryable = pipelineRetryableCount(memberNames, minAttempts);
    log(`cycle ${cycle} complete · retryable work left = ${retryable}`);
    if (retryable === 0) {
      log('Stable — no retryable work remaining.');
      break;
    }
    if (cycle < maxCycles && (def.cycleSleepMs ?? 0) > 0) {
      log(`sleeping ${Math.round((def.cycleSleepMs ?? 0) / 1000)}s before next cycle…`);
      await sleep(def.cycleSleepMs ?? 0);
    }
  }

  const statuses = [...lastStatuses.values()];
  const status: PipelineRunStatus =
    statuses.length === 0 ? 'failed' : statuses.every((s) => s === 'success') ? 'success' : 'partial';
  finishPipelineRun(pipelineRunId, status);
  log(`Pipeline "${def.name}" finished: ${status}`);
  await notifyPipeline(def.name, pipelineRunId, status, log);
  return { pipelineRunId };
}
