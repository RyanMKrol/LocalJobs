// Manual, NEVER-scheduled recovery tool for plex-language-apply. Reads the most
// recent applied-changes log (or one passed by path) and, for every 'applied'
// entry, reverts the file's audio/subtitle selection back to its recorded
// "before" state via Plex's own stream-selection endpoint.
//
// Defaults to a DRY RUN (prints what it WOULD revert, calls nothing). Pass
// --apply to actually issue the PUT requests.
//
// Usage:
//   tsx scripts/plex-language-undo.ts [--apply] [path/to/applied-log-*.json]
//
// With no path given, it picks the most recent
// src/workflows/plex-language-fix/data/out/applied-log-*.json file.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { plexPutStreams } from '../src/core/plex-client.js';
import type { AppliedLog } from '../src/workflows/plex-language-fix/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const defaultOutDir = resolve(here, '..', 'src', 'workflows', 'plex-language-fix', 'data', 'out');

export function findLatestAppliedLog(outDir: string): string | null {
  if (!existsSync(outDir)) return null;
  const files = readdirSync(outDir)
    .filter((f) => f.startsWith('applied-log-') && f.endsWith('.json'))
    .sort();
  if (files.length === 0) return null;
  return join(outDir, files[files.length - 1]);
}

export interface UndoResult {
  partId: number;
  itemTitle: string;
  outcome: 'reverted' | 'failed' | 'dry-run';
  error?: string;
}

/**
 * Compute (and, if `apply`, execute) the revert for every 'applied' entry in a
 * log — swapping before/after so undo restores the pre-apply selection.
 * `put` is injectable so this is testable without a real Plex server.
 */
export async function runUndo(
  log: AppliedLog,
  opts: { apply: boolean; put?: typeof plexPutStreams; log?: (msg: string) => void } = { apply: false },
): Promise<UndoResult[]> {
  const put = opts.put ?? plexPutStreams;
  const say = opts.log ?? console.log;
  const results: UndoResult[] = [];

  const revertible = log.entries.filter((e) => e.outcome === 'applied');
  say(`${revertible.length} applied entrie(s) found in this log (${log.entries.length} total).`);

  for (const entry of revertible) {
    const revertAudio = entry.beforeAudio;
    const revertSubtitle = entry.beforeSubtitle;
    if (!revertAudio) {
      say(`  ⚠ "${entry.itemTitle}" (partId=${entry.partId}) — no recorded beforeAudio, cannot revert`);
      results.push({ partId: entry.partId, itemTitle: entry.itemTitle, outcome: 'failed', error: 'no recorded beforeAudio' });
      continue;
    }
    if (!opts.apply) {
      say(
        `  [dry-run] "${entry.itemTitle}" (partId=${entry.partId}) — would revert audio → ${revertAudio.label}` +
          `${revertSubtitle ? `, subtitle → ${revertSubtitle.label}` : ', subtitle → none'}`,
      );
      results.push({ partId: entry.partId, itemTitle: entry.itemTitle, outcome: 'dry-run' });
      continue;
    }
    try {
      await put(entry.partId, revertAudio.streamId, revertSubtitle?.streamId ?? null);
      say(`  ✓ "${entry.itemTitle}" (partId=${entry.partId}) — reverted audio → ${revertAudio.label}`);
      results.push({ partId: entry.partId, itemTitle: entry.itemTitle, outcome: 'reverted' });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      say(`  ✗ "${entry.itemTitle}" (partId=${entry.partId}) — ${error}`);
      results.push({ partId: entry.partId, itemTitle: entry.itemTitle, outcome: 'failed', error });
    }
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const pathArg = args.find((a) => !a.startsWith('--'));

  const logPath = pathArg ? resolve(pathArg) : findLatestAppliedLog(defaultOutDir);
  if (!logPath || !existsSync(logPath)) {
    console.error(`No applied-log file found${pathArg ? ` at ${logPath}` : ` in ${defaultOutDir}`}.`);
    process.exitCode = 1;
    return;
  }

  console.log(`── plex-language-undo (${apply ? 'APPLY' : 'DRY RUN — pass --apply to actually revert'}) ──`);
  console.log(`Reading ${logPath}\n`);

  const log = JSON.parse(readFileSync(logPath, 'utf8')) as AppliedLog;
  const results = await runUndo(log, { apply });

  const outPath = logPath.replace(/\.json$/, `-undo-results-${apply ? 'applied' : 'dry-run'}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nWrote undo results to ${outPath}`);

  const failures = results.filter((r) => r.outcome === 'failed').length;
  if (failures > 0) {
    console.error(`✗ ${failures} revert(s) failed.`);
    process.exitCode = 1;
  }
}

// Only run when invoked directly (tsx scripts/plex-language-undo.ts), not when imported by a test.
if (process.argv[1] && process.argv[1].endsWith('plex-language-undo.ts')) {
  main();
}
