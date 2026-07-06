// One-time repair for `work_items.detail` rows whose `markdown`/`path` value is a
// STALE ABSOLUTE FILESYSTEM PATH frozen at write time — orphaned by the
// 2026-07 `src/jobs` -> `src/workflows` rename (T331), and now handled going
// forward by storing these paths relative to the workflows root instead of a
// frozen absolute one (T447, see `toStoredPath`/`markWorkItem` in
// `src/db/store.ts`). This script repairs rows recorded BEFORE that fix.
//
// For each row it finds an absolute `markdown`/`path` value that:
//   1. does NOT exist on disk at its recorded location, but
//   2. has a `<old-root>/<workflow>/data/...` suffix that DOES exist under the
//      CURRENT workflows root (src/workflows/<workflow>/data/...),
// and rewrites `detail` in place to the corrected, workflows-root-relative path
// (the same format `markWorkItem` now writes for new rows). Rows it can't
// confidently repair are left untouched and logged, never guessed at.
//
// IDEMPOTENT: a value already relative, or one that resolves fine as-is, is
// left alone — a second run touches nothing. Makes NO network/paid calls —
// local filesystem + SQLite only.
//
// Run against the live DB:  npx tsx scripts/backfill-fix-stale-output-paths.ts
// Dry-test against a scratch DB:  LOCALJOBS_DB=/tmp/foo.db npx tsx scripts/backfill-fix-stale-output-paths.ts
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join as joinPath, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { db } from '../src/db/index.js';
import { toStoredPath } from '../src/db/store.js';

const WORKFLOWS_ROOT = realpathSync(fileURLToPath(new URL('../src/workflows', import.meta.url)));

interface Row {
  job_name: string;
  item_key: string;
  detail: string;
}

/**
 * Given a stale absolute path (e.g. `.../src/jobs/plex-space-saver/data/out/x.json`),
 * try each path segment as the start of a suffix relative to the CURRENT workflows
 * root, from most-specific (longest suffix) to least, and return the first suffix
 * that actually resolves to a real file under {@link WORKFLOWS_ROOT}. Returns null
 * if nothing resolves. Handles the plain `src/jobs` -> `src/workflows` root rename.
 */
function findRepairedPath(staleAbsPath: string): string | null {
  const segments = staleAbsPath.split(sep).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const suffix = segments.slice(i).join(sep);
    const candidate = resolvePath(WORKFLOWS_ROOT, suffix);
    if (!candidate.startsWith(WORKFLOWS_ROOT + sep) && candidate !== WORKFLOWS_ROOT) continue; // stay in root
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Cache of workflow name -> its CURRENT root directory, resolved by scanning for
// `*.workflow.ts` files and matching the exported default's `name` (mirrors
// `findWorkflowDataOut` in src/api/server.ts). Lets us repair a row whose OWNING
// WORKFLOW FOLDER was itself renamed (e.g. `plex` -> `missing-tv-seasons`), which
// the plain segment-matching above can't handle since no path segment survives.
let workflowDirCache: Map<string, string> | null = null;

async function loadWorkflowDirs(): Promise<Map<string, string>> {
  if (workflowDirCache) return workflowDirCache;
  const map = new Map<string, string>();
  const isWfFile = (f: string) => f.endsWith('.workflow.ts') || f.endsWith('.workflow.js');
  function walk(dir: string): string[] {
    const out: string[] = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        // Never scan into a `data/` folder for code (see root CLAUDE.md's
        // "Never let data/ folders be scanned for code, by anything" gotcha) — a
        // workflow that clones repos into its own data/ tree (e.g. projects-sync)
        // can otherwise shadow the real *.workflow.ts with a stale nested copy.
        if (entry.isDirectory() && entry.name === 'data') continue;
        const full = joinPath(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (isWfFile(entry.name)) out.push(full);
      }
    } catch { /* skip unreadable dirs */ }
    return out;
  }
  for (const file of walk(WORKFLOWS_ROOT)) {
    try {
      const mod = await import(pathToFileURL(file).href) as { default?: { name?: string } };
      if (mod.default?.name) map.set(mod.default.name, dirname(file));
    } catch { /* skip import errors */ }
  }
  workflowDirCache = map;
  return map;
}

/** Which workflow a job currently belongs to (via the `workflow_jobs` table). */
function workflowForJob(jobName: string): string | null {
  const row = db.prepare('SELECT workflow_name FROM workflow_jobs WHERE job_name = ?').get(jobName) as
    | { workflow_name: string }
    | undefined;
  return row?.workflow_name ?? null;
}

/**
 * Fallback repair for when the owning workflow's FOLDER (not just the `src/jobs`
 * root) was renamed, so no segment of the stale path survives on disk. Finds the
 * `data/...` suffix of the stale path and re-joins it against the job's current
 * workflow directory (resolved fresh via {@link loadWorkflowDirs}).
 */
async function findRepairedPathViaWorkflow(jobName: string, staleAbsPath: string): Promise<string | null> {
  const workflowName = workflowForJob(jobName);
  if (!workflowName) return null;
  const dirs = await loadWorkflowDirs();
  const workflowDir = dirs.get(workflowName);
  if (!workflowDir) return null;
  const segments = staleAbsPath.split(sep);
  const dataIdx = segments.lastIndexOf('data');
  if (dataIdx === -1) return null;
  const suffix = segments.slice(dataIdx).join(sep);
  const candidate = resolvePath(workflowDir, suffix);
  if (!candidate.startsWith(WORKFLOWS_ROOT + sep) && candidate !== WORKFLOWS_ROOT) return null; // stay in root
  return existsSync(candidate) ? candidate : null;
}

async function repairKey(
  jobName: string,
  detail: Record<string, unknown>,
  key: 'markdown' | 'path',
): Promise<{ fixed: boolean; note?: string }> {
  const value = detail[key];
  if (typeof value !== 'string' || !value) return { fixed: false };
  if (!isAbsolute(value)) return { fixed: false }; // already the new relative format
  if (existsSync(value)) return { fixed: false }; // still resolves as-is, nothing stale about it
  const repaired = findRepairedPath(value) ?? (await findRepairedPathViaWorkflow(jobName, value));
  if (!repaired) return { fixed: false, note: `could not find a matching file under ${WORKFLOWS_ROOT} for ${value}` };
  detail[key] = toStoredPath(repaired);
  return { fixed: true };
}

async function main(): Promise<void> {
  console.log('── backfill-fix-stale-output-paths ──\n');
  console.log(`workflows root: ${WORKFLOWS_ROOT}\n`);

  const rows = db.prepare(`SELECT job_name, item_key, detail FROM work_items WHERE detail IS NOT NULL`).all() as Row[];

  let scanned = 0;
  let fixed = 0;
  let leftAlone = 0;
  const fixedByJob = new Map<string, number>();
  const update = db.prepare('UPDATE work_items SET detail = ? WHERE job_name = ? AND item_key = ?');

  for (const row of rows) {
    let detail: Record<string, unknown>;
    try {
      detail = JSON.parse(row.detail) as Record<string, unknown>;
    } catch {
      continue;
    }
    scanned++;

    let rowFixed = false;
    for (const key of ['markdown', 'path'] as const) {
      const { fixed: keyFixed, note } = await repairKey(row.job_name, detail, key);
      if (keyFixed) rowFixed = true;
      if (note) {
        leftAlone++;
        console.log(`  left alone: ${row.job_name} / ${row.item_key} (${key}) — ${note}`);
      }
    }

    if (rowFixed) {
      update.run(JSON.stringify(detail), row.job_name, row.item_key);
      fixed++;
      fixedByJob.set(row.job_name, (fixedByJob.get(row.job_name) ?? 0) + 1);
      console.log(`  fixed: ${row.job_name} / ${row.item_key}`);
    }
  }

  console.log(`\nScanned ${scanned} row(s) with a detail blob.`);
  console.log(`Fixed ${fixed} row(s) across ${fixedByJob.size} job(s):`);
  for (const [job, count] of fixedByJob) console.log(`  ${job}: ${count}`);
  if (leftAlone > 0) console.log(`Left ${leftAlone} value(s) alone (see notes above) — could not confidently repair.`);
}

await main();
