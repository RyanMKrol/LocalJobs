/**
 * One-time repair: re-unite subtitles orphaned by the 2026-08 backlog sweep.
 *
 * Release packages park subtitles in `Subs/<media stem>/2_eng.srt` next to the
 * video. plex-rename's sidecar enumeration only ever considered FLAT siblings, so
 * moving a video to its canonical name left those trees behind — the files still
 * exist, but Plex no longer offers them because they no longer sit beside the
 * media. `planNestedSubtitles` (naming.ts) fixes that going forward; this script
 * repairs what is already stranded.
 *
 * How it decides where a stranded subtitle belongs: it reads the plex-rename apply
 * ledger, which records the exact from → to of every move we made. For each old
 * release folder still holding a Subs tree, it maps each subtitle onto the SAME
 * canonical name the video received, using the same pure planner the workflow uses.
 * Nothing is inferred from filenames alone.
 *
 * Manual, never scheduled. DRY RUN by default — pass --apply to act.
 * Subtitles are COPIED then verified by checksum before the original is removed,
 * the same never-lose-a-byte procedure as the workflow itself.
 *
 *   npx tsx scripts/plex-rename-backfill-subtitles.ts            # preview
 *   npx tsx scripts/plex-rename-backfill-subtitles.ts --apply    # do it
 */
import 'dotenv/config'; // the path map + share names live in .env (never committed)
import { plexRenameConfig } from '../src/workflows/plex-rename/config.js';
import { mountHealthy, plexToLocal, realWriteFs, type WriteFsSeam } from '../src/workflows/plex-rename/lib.js';
import { pathKey, planNestedSubtitles, posixBasename, posixDirname, splitExt } from '../src/workflows/plex-rename/naming.js';
import { ledgerSuccessRows } from '../src/workflows/plex-rename/stages/ledger.js';
import type { ApplyDetail } from '../src/workflows/plex-rename/types.js';

const APPLY_JOB = 'plex-rename-apply';

export interface BackfillResult {
  planned: number;
  moved: number;
  failed: number;
  skipped: number;
  details: Array<{ from: string; to: string; outcome: 'moved' | 'exists' | 'failed' | 'source-missing'; error?: string }>;
}

/** Every subtitle file under a `Subs`/`Subtitles` tree in `dir`, relative to `dir`. */
async function nestedSubtitleEntries(fs: WriteFsSeam, dir: string): Promise<{ relPath: string }[]> {
  const out: { relPath: string }[] = [];
  const top = (await fs.readdir(dir)) ?? [];
  for (const entry of top) {
    if (!entry.isDir) continue;
    const k = pathKey(entry.name);
    if (k !== 'subs' && k !== 'subtitles') continue;
    const inner = (await fs.readdir(`${dir}/${entry.name}`)) ?? [];
    for (const sub of inner) {
      if (sub.isDir) {
        const deeper = (await fs.readdir(`${dir}/${entry.name}/${sub.name}`)) ?? [];
        for (const f of deeper) if (!f.isDir) out.push({ relPath: `${entry.name}/${sub.name}/${f.name}` });
      } else {
        out.push({ relPath: `${entry.name}/${sub.name}` });
      }
    }
  }
  return out;
}

export async function backfillSubtitles(
  opts: { apply: boolean; fs?: WriteFsSeam; readApplyRows?: () => { itemKey: string; detail: unknown }[]; log?: (s: string) => void } = {
    apply: false,
  },
): Promise<BackfillResult> {
  const fs = opts.fs ?? realWriteFs;
  const readApplyRows = opts.readApplyRows ?? (() => ledgerSuccessRows(APPLY_JOB));
  const log = opts.log ?? ((s: string) => console.log(s));
  const pathMap = plexRenameConfig.pathMap;
  const result: BackfillResult = { planned: 0, moved: 0, failed: 0, skipped: 0, details: [] };

  log(`plex-rename subtitle backfill — ${opts.apply ? 'APPLY' : 'DRY RUN'}`);
  if (pathMap.length === 0) {
    log('PLEX_RENAME_PATH_MAP is empty — nothing can be resolved. Aborting.');
    return result;
  }
  for (const pair of pathMap) {
    if (!(await mountHealthy(pair.local, fs))) {
      log(`Mount ${pair.local} is absent or empty — aborting rather than acting on a half-visible library.`);
      return result;
    }
  }

  const rows = readApplyRows();
  log(`Applied moves on record: ${rows.length}`);

  // One entry per (old release dir → canonical target) pairing we performed.
  const seenDirs = new Set<string>();
  for (const row of rows) {
    const d = row.detail as ApplyDetail | undefined;
    if (!d?.from || !d?.to) continue;
    const oldDir = posixDirname(d.from);
    const newDir = posixDirname(d.to);
    const oldStem = splitExt(posixBasename(d.from)).stem;
    const newStem = splitExt(posixBasename(d.to)).stem;
    const localOldDir = plexToLocal(oldDir, pathMap);
    if (!localOldDir) continue;
    const dirKey = `${pathKey(oldDir)}::${pathKey(oldStem)}`;
    if (seenDirs.has(dirKey)) continue;
    seenDirs.add(dirKey);
    if (!(await fs.stat(localOldDir))) continue; // release folder already gone

    const entries = await nestedSubtitleEntries(fs, localOldDir);
    if (entries.length === 0) continue;
    const plan = planNestedSubtitles(oldDir, oldStem, newDir, newStem, entries);
    for (const move of plan.moves) {
      const localFrom = plexToLocal(move.from, pathMap);
      const localTo = plexToLocal(move.to, pathMap);
      if (!localFrom || !localTo) continue;
      result.planned++;
      const srcStat = await fs.stat(localFrom);
      if (!srcStat) {
        result.skipped++;
        result.details.push({ from: move.from, to: move.to, outcome: 'source-missing' });
        continue;
      }
      if (await fs.stat(localTo)) {
        result.skipped++;
        result.details.push({ from: move.from, to: move.to, outcome: 'exists' });
        continue;
      }
      log(`  ${opts.apply ? 'move' : 'would move'}: ${move.from}`);
      log(`      → ${move.to}`);
      if (!opts.apply) continue;
      try {
        await fs.mkdirp(posixDirname(localTo));
        const partial = `${localTo}.plexrename-partial`;
        const copied = await fs.copyStreamHashed(localFrom, partial);
        const check = await fs.hashFile(partial);
        if (!check || check.sha256 !== copied.sha256 || check.bytes !== srcStat.size) {
          await fs.unlink(partial);
          throw new Error(`checksum/size mismatch (src ${srcStat.size}b, copy ${check?.bytes ?? '?'}b)`);
        }
        await fs.rename(partial, localTo);
        await fs.unlink(localFrom);
        result.moved++;
        result.details.push({ from: move.from, to: move.to, outcome: 'moved' });
      } catch (err) {
        result.failed++;
        result.details.push({ from: move.from, to: move.to, outcome: 'failed', error: err instanceof Error ? err.message : String(err) });
        log(`      FAILED: ${err instanceof Error ? err.message : err}`);
      }
    }
    for (const left of plan.leftBehind) log(`  left behind (never guessed): ${left}`);
  }

  log('─────────────────────────────────────────────');
  log(`Planned: ${result.planned} · moved: ${result.moved} · skipped: ${result.skipped} · failed: ${result.failed}`);
  if (!opts.apply && result.planned > 0) log('DRY RUN — re-run with --apply to perform these moves.');
  return result;
}

const isMain = process.argv[1]?.endsWith('plex-rename-backfill-subtitles.ts');
if (isMain) {
  backfillSubtitles({ apply: process.argv.includes('--apply') })
    .then((r) => process.exit(r.failed > 0 ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
