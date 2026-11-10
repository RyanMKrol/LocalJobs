import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDag, DagError } from '../core/dag.js';
import { validateWorkflowContracts } from '../core/ports.js';
import { registerService } from '../core/services.js';
import type { JobDefinition, WorkflowDefinition, ServiceDefinition } from '../core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Auto-discover units of work under this folder (including subfolders):
 *   *.job.ts       → a JobDefinition (the unit of work)
 *   *.workflow.ts  → a WorkflowDefinition (a DAG composing jobs)
 *   *.service.ts   → a ServiceDefinition (a shared rate-limited dependency)
 * Dropping a file in is all that's needed — no edit to this file.
 *
 * Privacy: top-level `*.job.ts` files are gitignored. The `places/` and
 * `perfumes/` workflow subfolders are tracked as public examples; any new private
 * workflow lives in its own gitignored subfolder. Discovery is by filesystem walk,
 * so this registry never names private jobs in the public repo.
 */
const isJobFile = (f: string) => f.endsWith('.job.ts') || f.endsWith('.job.js');
const isWorkflowFile = (f: string) => f.endsWith('.workflow.ts') || f.endsWith('.workflow.js');
const isServiceFile = (f: string) => f.endsWith('.service.ts') || f.endsWith('.service.js');

// Services are a daemon-wide, top-level concern (their rate-limit/quota is
// coordinated globally by service NAME), so they live in a sibling `src/services/`
// rather than buried in one workflow folder. We still scan `src/workflows` too, so a
// private job MAY colocate a service it owns.
const servicesDir = resolve(__dirname, '..', 'services');

/**
 * Recursively find files matching `pred`, NEVER descending into a directory
 * literally named `data` — the documented job-local resource convention
 * (`src/workflows/**\/data/`) is always gitignored, input/output only, never code.
 * This matters more than it looks: a workflow can generate a `data/` tree that
 * itself contains job/workflow-shaped files (e.g. `projects-sync`'s
 * clone-and-summarize stage shallow-clones the owner's own GitHub repos into
 * `data/repos/<name>/`, and cloning THIS repo produces a full copy of every
 * `*.job.ts`/`*.workflow.ts` file under `src/workflows/`). Since job/workflow lookup
 * is by NAME, not by file path, an undetected duplicate discovered inside a
 * `data/` tree can silently shadow the real definition (`jobs.find`/`workflows`
 * pick whichever sorts first) — found live: `stocks-sync`, `tv-recs`,
 * `workouts-sync`, and even `projects-sync` itself were all being served from a
 * stale clone nested under `projects-sync/data/repos/LocalJobs/`, not the real,
 * currently-edited source.
 */
export function findFiles(dir: string, pred: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'data') continue;
      out.push(...findFiles(full, pred));
    } else if (pred(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function loadDefault<T>(file: string): Promise<T | undefined> {
  const mod = (await import(pathToFileURL(file).href)) as { default?: T };
  return mod.default;
}

/**
 * A broken definition is FATAL: the registry throws and the daemon refuses to
 * start, naming every problem at once. It used to `console.warn` and skip the
 * offending file. That was never really "skip": an invalid workflow's member jobs
 * then usually tripped the orphan check below and crashed the process anyway,
 * with a message about orphans rather than the actual mistake; and where it did
 * not crash, a workflow quietly vanished from the schedule with nothing but a
 * line in the daemon log. A configuration error should stop the daemon at the
 * door with the real reason.
 *
 * Problems are collected and thrown together so one start shows all of them.
 */
const loadErrors: string[] = [];

// ──────────────────────────────── jobs ────────────────────────────────
const loadedJobs: JobDefinition[] = [];
const jobFileByName = new Map<string, string>();
for (const file of findFiles(__dirname, isJobFile).sort()) {
  const def = await loadDefault<JobDefinition>(file);
  if (!def || typeof def.name !== 'string' || typeof def.run !== 'function') {
    loadErrors.push(`${file} has no valid default JobDefinition export (needs a string \`name\` and a \`run\` function)`);
    continue;
  }
  // Job lookup is by NAME, so two files declaring the same name means one silently
  // shadows the other (this has happened: a stray copy discovered inside a
  // workflow's own generated output served stale code for four workflows).
  const first = jobFileByName.get(def.name);
  if (first) {
    loadErrors.push(`duplicate job name "${def.name}": declared by both ${first} and ${file}`);
    continue;
  }
  jobFileByName.set(def.name, file);
  loadedJobs.push(def);
}

export const jobs: JobDefinition[] = loadedJobs;

export function getJobDefinition(name: string): JobDefinition | undefined {
  return jobs.find((j) => j.name === name);
}

// ──────────────────────────────── services ────────────────────────────────
const loadedServices: ServiceDefinition[] = [];
const serviceFiles = [
  ...findFiles(__dirname, isServiceFile),
  ...(existsSync(servicesDir) ? findFiles(servicesDir, isServiceFile) : []),
].sort();
for (const file of serviceFiles) {
  const def = await loadDefault<ServiceDefinition>(file);
  if (def && typeof def.name === 'string') {
    loadedServices.push(def);
    registerService(def); // make it available to callService (no registry import there)
  } else console.warn(`[registry] ${file} has no valid default ServiceDefinition export — skipped`);
}

export const services: ServiceDefinition[] = loadedServices;

export function getServiceDefinition(name: string): ServiceDefinition | undefined {
  return services.find((s) => s.name === name);
}

// ──────────────────────────────── workflows ────────────────────────────────
const jobNameSet = new Set(jobs.map((j) => j.name));
const loadedWorkflows: WorkflowDefinition[] = [];
const seenWorkflowNames = new Set<string>();

for (const file of findFiles(__dirname, isWorkflowFile).sort()) {
  const def = await loadDefault<WorkflowDefinition>(file);
  if (!def || typeof def.name !== 'string' || !Array.isArray(def.jobs)) {
    loadErrors.push(`${file} has no valid default WorkflowDefinition export (needs a string \`name\` and a \`jobs\` array)`);
    continue;
  }
  const err = validateWorkflow(def, jobNameSet, seenWorkflowNames);
  if (err) {
    loadErrors.push(`workflow "${def.name}" (${file}) is invalid: ${err}`);
    continue;
  }
  // The contract between stages is checked HERE, at load: every edge of a ports
  // workflow must carry a declared input that the upstream stage really outputs,
  // and every edge of a legacy workflow must have a produces/consumes gate. This
  // used to be asserted only by a unit test, so a daemon could start with a
  // workflow whose stages did not line up.
  const contractErrors = validateWorkflowContracts(def, (n) => loadedJobs.find((j) => j.name === n));
  for (const e of contractErrors) loadErrors.push(`workflow "${def.name}" (${file}): ${e}`);
  for (const ref of def.jobs) {
    for (const other of loadedJobs.find((j) => j.name === ref.job)?.reads ?? []) {
      if (!jobNameSet.has(other)) loadErrors.push(`workflow "${def.name}": "${ref.job}" declares it reads "${other}", which is not a known job`);
    }
  }
  seenWorkflowNames.add(def.name);
  loadedWorkflows.push(def);
}

export const workflows: WorkflowDefinition[] = loadedWorkflows;

export function getWorkflowDefinition(name: string): WorkflowDefinition | undefined {
  return workflows.find((p) => p.name === name);
}

/** Union of every member job name across all valid workflows. Every job MUST be a
 *  member — there are no standalone jobs — so this is also the set of all runnable
 *  jobs the scheduler considers. */
export function memberJobNames(): Set<string> {
  const set = new Set<string>();
  for (const p of workflows) for (const ref of p.jobs) set.add(ref.job);
  return set;
}

/**
 * Job names that belong to NO workflow. There are no standalone jobs in this
 * framework: every job must be declared in a `*.workflow.ts` manifest (a single
 * job is a one-stage workflow with its own manifest — there is no implicit
 * wrapping). A non-empty result is therefore a configuration error. Pure +
 * exported so it can be unit-tested without importing the live registry.
 */
export function orphanJobNames(
  jobDefs: ReadonlyArray<{ name: string }>,
  workflowDefs: ReadonlyArray<{ jobs: ReadonlyArray<{ job: string }> }>,
): string[] {
  const members = new Set<string>();
  for (const p of workflowDefs) for (const ref of p.jobs) members.add(ref.job);
  return jobDefs.filter((j) => !members.has(j.name)).map((j) => j.name);
}

/**
 * Job names that are a member of MORE than one workflow, with the workflows that
 * claim them. A job belongs to exactly one workflow: its ledger rows, its
 * overlap guard (`runJobForWorkflow` skips a job that is already running
 * anywhere, and that skip cascades to its dependents) and its inputs are all
 * keyed by job name, so sharing one between two workflows makes whichever runs
 * second silently skip a stage. Share the IMPLEMENTATION instead (a function two
 * job files both call). Pure + exported for unit tests.
 */
export function sharedJobNames(
  workflowDefs: ReadonlyArray<{ name: string; jobs: ReadonlyArray<{ job: string }> }>,
): { job: string; workflows: string[] }[] {
  const owners = new Map<string, string[]>();
  for (const wf of workflowDefs) {
    for (const ref of wf.jobs) (owners.get(ref.job) ?? owners.set(ref.job, []).get(ref.job)!).push(wf.name);
  }
  return [...owners.entries()].filter(([, w]) => w.length > 1).map(([job, w]) => ({ job, workflows: w }));
}

for (const { job, workflows: owners } of sharedJobNames(workflows)) {
  loadErrors.push(`job "${job}" is a member of ${owners.length} workflows (${owners.join(', ')}); a job belongs to exactly one`);
}

// A job that belongs to no workflow is a config error — it can never be scheduled
// or composed. Only reported when nothing else is wrong: an invalid workflow
// above would otherwise list all of ITS members here as orphans and bury the
// real cause.
if (loadErrors.length === 0) {
  const orphans = orphanJobNames(jobs, workflows);
  if (orphans.length > 0) {
    loadErrors.push(
      `standalone jobs are not allowed — every job must be declared in a *.workflow.ts manifest ` +
        `(a single job = a one-stage workflow). Orphaned job(s) with no workflow: ${orphans.join(', ')}`,
    );
  }
}

if (loadErrors.length > 0) {
  throw new Error(
    `[registry] ${loadErrors.length} definition problem(s) — refusing to load:\n` +
      loadErrors.map((e) => `  • ${e}`).join('\n'),
  );
}

function validateWorkflow(
  def: WorkflowDefinition,
  jobNames: Set<string>,
  seenNames: Set<string>,
): string | null {
  if (seenNames.has(def.name)) return `duplicate workflow name "${def.name}"`;
  if (jobNames.has(def.name)) return `name collides with a job named "${def.name}"`;
  if (def.jobs.length === 0) return 'has no member jobs';
  for (const ref of def.jobs) {
    if (!jobNames.has(ref.job)) return `member "${ref.job}" is not a known job`;
    for (const dep of ref.dependsOn ?? []) {
      if (!jobNames.has(dep)) return `"${ref.job}" dependsOn "${dep}", which is not a known job`;
    }
  }
  try {
    buildDag(def.jobs); // acyclic / no-dup / no-dangling-edge
  } catch (e) {
    return e instanceof DagError ? e.message : String(e);
  }
  return null;
}
