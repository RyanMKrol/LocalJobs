import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDag, DagError } from '../core/dag.js';
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
// rather than buried in one workflow folder. We still scan `src/jobs` too, so a
// private job MAY colocate a service it owns.
const servicesDir = resolve(__dirname, '..', 'services');

function findFiles(dir: string, pred: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findFiles(full, pred));
    else if (pred(entry.name)) out.push(full);
  }
  return out;
}

async function loadDefault<T>(file: string): Promise<T | undefined> {
  const mod = (await import(pathToFileURL(file).href)) as { default?: T };
  return mod.default;
}

// ──────────────────────────────── jobs ────────────────────────────────
const loadedJobs: JobDefinition[] = [];
for (const file of findFiles(__dirname, isJobFile).sort()) {
  const def = await loadDefault<JobDefinition>(file);
  if (def && typeof def.name === 'string' && typeof def.run === 'function') loadedJobs.push(def);
  else console.warn(`[registry] ${file} has no valid default JobDefinition export — skipped`);
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
    console.warn(`[registry] ${file} has no valid default WorkflowDefinition export — skipped`);
    continue;
  }
  const err = validateWorkflow(def, jobNameSet, seenWorkflowNames);
  if (err) {
    console.warn(`[registry] workflow "${def.name}" (${file}) is invalid — skipped: ${err}`);
    continue;
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

// Fail LOUD at load if any discovered job belongs to no workflow. A job with no
// manifest is a config error — better to refuse to start than to silently host an
// orphan that can never be scheduled or composed.
const orphans = orphanJobNames(jobs, workflows);
if (orphans.length > 0) {
  throw new Error(
    `[registry] standalone jobs are not allowed — every job must be declared in a *.workflow.ts manifest ` +
      `(a single job = a one-stage workflow). Orphaned job(s) with no workflow: ${orphans.join(', ')}`,
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
