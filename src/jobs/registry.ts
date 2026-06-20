import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { JobDefinition } from '../core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Auto-discover every `*.job.ts` / `*.job.js` file in this folder and load its
 * default-exported JobDefinition. Dropping a new job file in is all that's
 * needed — no edit to this file required.
 *
 * Privacy: real job files are gitignored; only `demo.job.ts` is tracked. Because
 * discovery is by filesystem glob (not a hardcoded list), this registry never
 * names or leaks your private jobs into the public repo.
 */
function isJobFile(f: string): boolean {
  return f.endsWith('.job.ts') || f.endsWith('.job.js');
}

const loaded: JobDefinition[] = [];
for (const file of readdirSync(__dirname).filter(isJobFile).sort()) {
  const mod = await import(pathToFileURL(resolve(__dirname, file)).href);
  const def = mod.default as JobDefinition | undefined;
  if (def && typeof def.name === 'string' && typeof def.run === 'function') {
    loaded.push(def);
  } else {
    console.warn(`[registry] ${file} has no valid default JobDefinition export — skipped`);
  }
}

export const jobs: JobDefinition[] = loaded;

export function getJobDefinition(name: string): JobDefinition | undefined {
  return jobs.find((j) => j.name === name);
}
