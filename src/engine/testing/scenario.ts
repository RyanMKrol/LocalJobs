// The harness for engine SCENARIO tests: run a fixture workflow for real (the
// daemon-side executor in this process, each stage in its own child process
// through the production child runtime) and inspect what happened.
//
// A scenario is a module that exports `jobs` (fixture stages built with
// `defineStage`) and one or more workflows. Nothing of the real application is
// loaded on either side: this process uses the fixture host, and each child
// looks its stage up in the scenario module.
//
// Fixture stages find their working directory in LJ_SCENARIO_DIR and can be
// steered per run through `control.json` there (see `scenarioMode`).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../config.js';
import {
  activeWorkflowRunId, artifactsForWorkflowRun, getWorkflowLogs, getWorkflowRun, listRunsForWorkflowRun, resolvedInputsForStage,
  syncJob, syncWorkflow, type RunArtifactRow,
} from '../../db/store.js';
import type { JobDefinition, RunRow, WorkflowDefinition, WorkflowRunRow } from '../types.js';
import { cancelWorkflowRun, isWorkflowRunActive, runWorkflow } from '../workflow-executor.js';
import { jobs as hostJobs, notifications } from './fixture-host.js';

/** The directory a scenario's stages read and write in. */
export function scenarioDir(): string {
  const d = process.env.LJ_SCENARIO_DIR;
  if (!d) throw new Error('LJ_SCENARIO_DIR is not set');
  return d;
}
/** A path inside the scenario directory, as a location function for an output port. */
export const inScenario = (name: string) => () => join(scenarioDir(), name);
/** How a stage should behave this run: 'ok' unless the test's control file says otherwise. */
export function scenarioMode(stage: string): string {
  const f = join(scenarioDir(), 'control.json');
  if (!existsSync(f)) return 'ok';
  return (JSON.parse(readFileSync(f, 'utf8')) as Record<string, string>)[stage] ?? 'ok';
}

/** What one workflow run did, in the terms a test asserts on. */
export interface RunReport {
  id: string;
  run: WorkflowRunRow;
  status: string;
  /** Every member run row, oldest first (one per attempt, per cycle). */
  runs: RunRow[];
  /** The latest row of a stage. */
  stage(name: string): RunRow | undefined;
  /** Every attempt of a stage, oldest first. */
  attempts(name: string): RunRow[];
  /** `stage → status` of each stage's latest row. */
  statuses: Record<string, string>;
  /** Every artifact committed in the run. */
  artifacts: RunArtifactRow[];
  /** The artifact a stage's latest attempt committed for a port. */
  artifact(stage: string, port: string): RunArtifactRow | undefined;
  /** A stage's resolved inputs as `port<-producer`, sorted. */
  inputsOf(stage: string, cycle?: number): string[];
  /** The run's framework log, one line per entry. */
  log: string;
}

export interface Scenario {
  dir: string;
  /** Steer the fixture stages for the next run(s): `{ "<stage>": "<mode>" }`. */
  control(c: Record<string, string>): void;
  run(workflow: WorkflowDefinition, opts?: { limit?: number; trigger?: 'manual' | 'schedule' }): Promise<RunReport>;
  /**
   * Start a run without waiting for it to finish (to cancel it, or watch it
   * mid-flight). Resolves once the run exists, with its id and a `done` promise
   * for its final report.
   */
  start(workflow: WorkflowDefinition, opts?: { limit?: number }): Promise<{ id: string; done: Promise<RunReport> }>;
  /** Wait until `pred` holds for the run (polling its report), or throw after 8s. */
  until(workflowRunId: string, what: string, pred: (r: RunReport) => boolean): Promise<RunReport>;
  report(workflowRunId: string): RunReport;
  readJson<T>(name: string): T;
  path(name: string): string;
  notifications: typeof notifications;
  cleanup(): void;
}

export function reportFor(workflowRunId: string): RunReport {
  const runs = listRunsForWorkflowRun(workflowRunId);
  const run = getWorkflowRun(workflowRunId)!;
  const latest = new Map<string, RunRow>();
  for (const r of runs) latest.set(r.job_name, r);
  const artifacts = artifactsForWorkflowRun(workflowRunId);
  return {
    id: workflowRunId,
    run,
    status: run.status,
    runs,
    stage: (name) => latest.get(name),
    attempts: (name) => runs.filter((r) => r.job_name === name),
    statuses: Object.fromEntries([...latest].map(([k, v]) => [k, v.status])),
    artifacts,
    artifact: (stage, port) => artifacts.filter((a) => a.job_name === stage && a.port === port && a.run_id === latest.get(stage)?.id).at(-1),
    inputsOf: (stage, cycle = 1) => resolvedInputsForStage(workflowRunId, stage, cycle).map((i) => `${i.port}<-${i.producer_job}`).sort(),
    log: getWorkflowLogs(workflowRunId).map((l) => l.message).join('\n'),
  };
}

/**
 * Set a scenario up: a fresh working directory, its stages known to the engine
 * (in this process and, through the scenario module, in each child), its
 * workflows synced. `moduleUrl` is the scenario module's own `import.meta.url`.
 */
export function setupScenario(opts: { moduleUrl: string; jobs: JobDefinition[]; workflows: WorkflowDefinition[] }): Scenario {
  const dir = mkdtempSync(join(tmpdir(), 'lj-scenario-'));
  const original = { script: config.runJobScript, topic: config.ntfyTopic };
  config.runJobScript = fileURLToPath(new URL('./fixture-runner.ts', import.meta.url));
  config.ntfyTopic = '';
  // Each child must open THIS process's scratch database, load the same scenario
  // module, and work in the same directory.
  process.env.LOCALJOBS_DB = config.dbPath;
  process.env.LJ_SCENARIO_DIR = dir;
  process.env.LJ_SCENARIO_MODULE = fileURLToPath(opts.moduleUrl);

  for (const d of opts.jobs) {
    syncJob(d);
    hostJobs.push(d);
  }
  for (const w of opts.workflows) syncWorkflow(w);
  const started = new Set<string>();

  return {
    dir,
    control: (c) => writeFileSync(join(dir, 'control.json'), JSON.stringify(c)),
    async run(workflow, o = {}) {
      const { workflowRunId } = await runWorkflow(workflow, o.trigger ?? 'manual', { limit: o.limit });
      if (!workflowRunId) throw new Error(`workflow "${workflow.name}" did not start`);
      return reportFor(workflowRunId);
    },
    async start(workflow, o = {}) {
      const settled = runWorkflow(workflow, 'manual', { limit: o.limit });
      const deadline = Date.now() + 8000;
      for (;;) {
        const id = activeWorkflowRunId(workflow.name);
        if (id && isWorkflowRunActive(id)) {
          started.add(id);
          return { id, done: settled.then(() => reportFor(id)) };
        }
        if (Date.now() > deadline) throw new Error(`workflow "${workflow.name}" did not start within 8s`);
        await new Promise((r) => setTimeout(r, 15));
      }
    },
    async until(workflowRunId, what, pred) {
      const deadline = Date.now() + 8000;
      for (;;) {
        const r = reportFor(workflowRunId);
        if (pred(r)) return r;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((res) => setTimeout(res, 15));
      }
    },
    report: reportFor,
    readJson: <T>(name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T,
    path: (name) => join(dir, name),
    notifications,
    cleanup() {
      // A test that failed part-way may have left a run in flight: stop it, so its
      // child processes do not outlive the test (and keep this process alive).
      for (const id of started) cancelWorkflowRun(id, 'scenario cleanup');
      config.runJobScript = original.script;
      config.ntfyTopic = original.topic;
      for (const d of opts.jobs) {
        const i = hostJobs.indexOf(d);
        if (i >= 0) hostJobs.splice(i, 1);
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
