import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { JobDefinition } from '../core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Auto-discover every `*.job.ts` / `*.job.js` file under this folder (including
 * subfolders) and load its default-exported JobDefinition. Dropping a new job
 * file in is all that's needed — no edit to this file required.
 *
 * Privacy: real job files are gitignored; only `demo.job.ts` is tracked.
 * Subfolders (e.g. `places/`) hold private pipelines and are gitignored wholesale.
 * Because discovery is by filesystem walk (not a hardcoded list), this registry
 * never names or leaks your private jobs into the public repo.
 */
function isJobFile(f: string): boolean {
  return f.endsWith('.job.ts') || f.endsWith('.job.js');
}

function findJobFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findJobFiles(full));
    else if (isJobFile(entry.name)) out.push(full);
  }
  return out;
}

const loaded: JobDefinition[] = [];
for (const file of findJobFiles(__dirname).sort()) {
  const mod = await import(pathToFileURL(file).href);
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
