import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDag, DagError } from '../core/dag.js';
import { registerService } from '../core/services.js';
import type { JobDefinition, PipelineDefinition, ServiceDefinition } from '../core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Auto-discover units of work under this folder (including subfolders):
 *   *.job.ts       → a JobDefinition (the unit of work)
 *   *.pipeline.ts  → a PipelineDefinition (a DAG composing jobs)
 *   *.service.ts   → a ServiceDefinition (a shared rate-limited dependency)
 * Dropping a file in is all that's needed — no edit to this file.
 *
 * Privacy: top-level `*.job.ts` files are gitignored. The `places/` and
 * `perfumes/` pipeline subfolders are tracked as public examples; any new private
 * pipeline lives in its own gitignored subfolder. Discovery is by filesystem walk,
 * so this registry never names private jobs in the public repo.
 */
const isJobFile = (f: string) => f.endsWith('.job.ts') || f.endsWith('.job.js');
const isPipelineFile = (f: string) => f.endsWith('.pipeline.ts') || f.endsWith('.pipeline.js');
const isServiceFile = (f: string) => f.endsWith('.service.ts') || f.endsWith('.service.js');

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
for (const file of findFiles(__dirname, isServiceFile).sort()) {
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

// ──────────────────────────────── pipelines ────────────────────────────────
const jobNameSet = new Set(jobs.map((j) => j.name));
const loadedPipelines: PipelineDefinition[] = [];
const seenPipelineNames = new Set<string>();

for (const file of findFiles(__dirname, isPipelineFile).sort()) {
  const def = await loadDefault<PipelineDefinition>(file);
  if (!def || typeof def.name !== 'string' || !Array.isArray(def.jobs)) {
    console.warn(`[registry] ${file} has no valid default PipelineDefinition export — skipped`);
    continue;
  }
  const err = validatePipeline(def, jobNameSet, seenPipelineNames);
  if (err) {
    console.warn(`[registry] pipeline "${def.name}" (${file}) is invalid — skipped: ${err}`);
    continue;
  }
  seenPipelineNames.add(def.name);
  loadedPipelines.push(def);
}

export const pipelines: PipelineDefinition[] = loadedPipelines;

export function getPipelineDefinition(name: string): PipelineDefinition | undefined {
  return pipelines.find((p) => p.name === name);
}

/** Union of every member job name across all valid pipelines (scheduler uses this
 *  to suppress a member job's own cron — the pipeline drives it). */
export function memberJobNames(): Set<string> {
  const set = new Set<string>();
  for (const p of pipelines) for (const ref of p.jobs) set.add(ref.job);
  return set;
}

function validatePipeline(
  def: PipelineDefinition,
  jobNames: Set<string>,
  seenNames: Set<string>,
): string | null {
  if (seenNames.has(def.name)) return `duplicate pipeline name "${def.name}"`;
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
