import { getJobDefinition } from '../jobs/registry.js';
import {
  addPipelineLog,
  createPipelineRun,
  finishPipelineRun,
  hasActivePipelineRun,
  pipelineRetryableCount,
  recordGateFailure,
  recordSkippedRun,
  rollUpPipelineProgress,
} from '../db/store.js';
import { type Dag, type Gate, buildDag, deriveGates, executeDag } from './dag.js';
import { runJobForPipeline } from './executor.js';
import { notifyPipeline, notifyStage } from './notifier.js';
import type { LogLevel, PipelineDefinition, PipelineRunStatus, RunStatus } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Enforce one gate: run the producer's `produces[key]` contract (output is
 * well-formed) and the consumer's `consumes[key]` contract (input is acceptable),
 * whichever are declared. A check that returns `ok:false` or throws contributes
 * its violations. Returns the merged verdict so the boundary fails LOUD with the
 * exact drift rather than passing bad data downstream.
 */
async function enforceGate(gate: Gate): Promise<{ ok: boolean; violations: string[] }> {
  const producer = getJobDefinition(gate.producer);
  const consumer = getJobDefinition(gate.consumer);
  const sides: Array<['producer' | 'consumer', ReturnType<typeof getJobDefinition>, 'produces' | 'consumes']> = [
    ['producer', producer, 'produces'],
    ['consumer', consumer, 'consumes'],
  ];
  const violations: string[] = [];
  for (const [side, def, field] of sides) {
    const contract = def?.[field]?.find((c) => c.key === gate.key);
    if (!contract) continue;
    try {
      const r = await contract.check();
      if (!r.ok) violations.push(...(r.violations?.length ? r.violations : [`${gate.key}: ${side} contract not satisfied`]));
    } catch (e) {
      violations.push(`${gate.key}: ${side} check threw — ${msg(e)}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

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

  // Derive the typed-artifact gates between dependent stages from each member's
  // declared produces/consumes keys. Inbound gates are grouped by consumer so a
  // job's contracts are checked the moment it's about to run.
  const produces = new Map<string, string[]>();
  const consumes = new Map<string, string[]>();
  for (const node of dag.nodes) {
    const jd = getJobDefinition(node);
    produces.set(node, (jd?.produces ?? []).map((c) => c.key));
    consumes.set(node, (jd?.consumes ?? []).map((c) => c.key));
  }
  const gates = deriveGates(dag, produces, consumes);
  const inboundGates = new Map<string, Gate[]>();
  for (const g of gates) (inboundGates.get(g.consumer) ?? inboundGates.set(g.consumer, []).get(g.consumer)!).push(g);

  const pipelineRunId = createPipelineRun(def.name, trigger);
  const log = (m: string, level: LogLevel = 'info') => addPipelineLog(pipelineRunId, m, level);
  const total = dag.nodes.length;
  const memberNames = def.jobs.map((j) => j.job);
  const minAttempts = def.minAttempts ?? 4;
  const maxCycles = def.repeatUntilStable ? Math.max(1, def.maxCycles ?? 1) : 1;

  log(`Pipeline "${def.name}" started · ${total} job(s) · ${gates.length} gate(s) · trigger=${trigger}${def.repeatUntilStable ? ` · repeatUntilStable (maxCycles=${maxCycles})` : ''}`);

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
        // Validation gate: every inbound contract from a (now-succeeded) upstream
        // is checked BEFORE the consumer runs. A violation is a first-class failed
        // run — the consumer never spawns and the drift is surfaced + notified,
        // so bad data is stopped at the exact boundary.
        for (const gate of inboundGates.get(job) ?? []) {
          const verdict = await enforceGate(gate);
          if (!verdict.ok) {
            const detail = `Gate violation [${gate.producer} → ${gate.consumer}] artifact "${gate.key}": ${verdict.violations.join('; ')}`;
            log(`⨯ ${detail}`, 'error');
            recordGateFailure(job, pipelineRunId, detail);
            return 'failed';
          }
          log(`✓ gate ok [${gate.producer} → ${gate.consumer}] artifact "${gate.key}"`);
        }
        const { status } = await runJobForPipeline(jd, pipelineRunId);
        return status;
      },
      onStart: (job) => log(`▶ ${job} started`),
      onSettle: async (job, s) => {
        settled++;
        rollUpPipelineProgress(pipelineRunId, `${settled}/${total} stages (${job} ${s})`);
        log(`${s === 'success' ? '✓' : '✗'} ${job} → ${s}`, s === 'success' ? 'info' : 'warn');
        await notifyStage(def.name, pipelineRunId, job, s, log);
      },
      onSkip: async (job, reason) => {
        settled++;
        recordSkippedRun(job, pipelineRunId, `skipped: ${reason}`);
        rollUpPipelineProgress(pipelineRunId, `${settled}/${total} stages (${job} skipped)`);
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
