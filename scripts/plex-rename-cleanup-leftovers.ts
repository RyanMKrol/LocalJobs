/**
 * One-time cleanup of what the 2026-08 canonical-rename sweep left behind in the
 * OLD release folders: bonus featurettes, orphaned artwork/nfo files, and the
 * husk directories that survive only because Finder dropped a `.DS_Store` in them.
 *
 * Safety rules, in order of importance:
 *  1. NOTHING Plex knows about is ever touched. Every candidate is checked against
 *     the plex-rename discover snapshot (the live library walk) — if Plex indexes
 *     the file, it is skipped, no matter which category it looks like.
 *  2. Only NON-canonical folders are considered — a directory carrying a
 *     `{tvdb-…}` / `{tmdb-…}` / `{imdb-…}` tag is a real library folder and is
 *     never entered. Loose files at a library root are left alone too: those are
 *     pending renames, not leftovers.
 *  3. Nothing is unlinked. Everything removed is MOVED into the share's own
 *     `#recycle/plex-rename-cleanup-<timestamp>/` tree, preserving its relative
 *     path, so any mistake is a drag-and-drop away from being undone. Empty the
 *     Synology recycle bin to reclaim the space.
 *  4. Directories are only removed once a fresh listing shows them empty.
 *
 * Manual, never scheduled. DRY RUN by default — pass --apply to act.
 *
 *   npx tsx scripts/plex-rename-cleanup-leftovers.ts             # preview
 *   npx tsx scripts/plex-rename-cleanup-leftovers.ts --apply     # do it
 *   npx tsx scripts/plex-rename-cleanup-leftovers.ts --only=husks # one category
 */
import 'dotenv/config';
import { plexRenameConfig } from '../src/workflows/plex-rename/config.js';
import { mountHealthy, plexToLocal, realWriteFs, type WriteFsSeam } from '../src/workflows/plex-rename/lib.js';
import { pathKey, posixBasename, splitExt } from '../src/workflows/plex-rename/naming.js';
import { ledgerSuccessRows } from '../src/workflows/plex-rename/stages/ledger.js';
import type { DiscoverDetail } from '../src/workflows/plex-rename/types.js';

const DISCOVER_JOB = 'plex-rename-discover';

/** Extensions treated as real media (a featurette is still media — recycled, never unlinked). */
const VIDEO_EXTS = new Set(['mkv', 'mp4', 'avi', 'm4v', 'ts', 'wmv', 'mpg', 'mpeg', 'mov', 'flv', 'iso', 'img']);
/** Artwork/metadata a release ships that Plex neither needs nor reads once the media has moved. */
const META_EXTS = new Set(['nfo', 'jpg', 'jpeg', 'png', 'webp', 'txt', 'md', 'xml', 'sfv', 'nzb', 'torrent', 'url', 'srr']);
/** Filesystem noise that keeps an otherwise-empty directory alive. */
const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', '.apdisk', 'desktop.ini', '@eadir']);
const SUBTITLE_EXTS = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub', 'idx', 'smi']);

const CANONICAL_DIR = /\{(tvdb|tmdb|imdb)-[^}]+\}/i;

export type Category = 'extras' | 'metadata' | 'husks';

export interface CleanupResult {
  recycled: { path: string; category: Category; bytes: number }[];
  dirsRemoved: string[];
  skippedPlexKnown: string[];
  failures: { path: string; error: string }[];
}

interface Candidate {
  local: string;
  rel: string;
  category: Category;
  bytes: number;
}

function classify(fileName: string): Category | null {
  const lower = fileName.toLowerCase();
  if (JUNK_NAMES.has(lower)) return 'husks';
  const { ext } = splitExt(fileName);
  const e = ext.toLowerCase();
  if (VIDEO_EXTS.has(e)) return 'extras';
  if (SUBTITLE_EXTS.has(e)) return null; // never touched here — see plex-rename-backfill-subtitles.ts
  if (META_EXTS.has(e)) return 'metadata';
  if (lower.startsWith('.')) return 'husks'; // dotfiles are noise, not content
  return null; // unknown → leave it alone and report nothing
}

async function walk(fs: WriteFsSeam, dir: string, rel = ''): Promise<{ files: { path: string; rel: string }[]; dirs: string[] }> {
  const files: { path: string; rel: string }[] = [];
  const dirs: string[] = [];
  const entries = (await fs.readdir(dir)) ?? [];
  for (const e of entries) {
    const child = `${dir}/${e.name}`;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDir) {
      dirs.push(child);
      const inner = await walk(fs, child, childRel);
      files.push(...inner.files);
      dirs.push(...inner.dirs);
    } else {
      files.push({ path: child, rel: childRel });
    }
  }
  return { files, dirs };
}

export async function cleanupLeftovers(
  opts: {
    apply: boolean;
    only?: Category[];
    fs?: WriteFsSeam;
    readDiscoverRows?: () => { itemKey: string; detail: unknown }[];
    stamp?: string;
    log?: (s: string) => void;
  } = { apply: false },
): Promise<CleanupResult> {
  const fs = opts.fs ?? realWriteFs;
  const log = opts.log ?? ((s: string) => console.log(s));
  const readDiscoverRows = opts.readDiscoverRows ?? (() => ledgerSuccessRows(DISCOVER_JOB));
  const categories: Category[] = opts.only ?? ['extras', 'metadata', 'husks'];
  const pathMap = plexRenameConfig.pathMap;
  const result: CleanupResult = { recycled: [], dirsRemoved: [], skippedPlexKnown: [], failures: [] };

  log(`plex-rename leftover cleanup — ${opts.apply ? 'APPLY' : 'DRY RUN'} · categories: ${categories.join(', ')}`);
  if (pathMap.length === 0) {
    log('PLEX_RENAME_PATH_MAP is empty — aborting.');
    return result;
  }

  // Rule 1: every file Plex currently indexes, as a local path — untouchable.
  const plexKnown = new Set<string>();
  for (const row of readDiscoverRows()) {
    const d = row.detail as DiscoverDetail | undefined;
    if (!d?.file) continue;
    const local = plexToLocal(d.file, pathMap);
    if (local) plexKnown.add(pathKey(local));
  }
  log(`Plex currently indexes ${plexKnown.size} file(s) — none of them can be touched by this script.`);

  for (const pair of pathMap) {
    if (!(await mountHealthy(pair.local, fs))) {
      log(`Mount ${pair.local} absent or empty — aborting rather than acting on a half-visible library.`);
      return result;
    }
  }

  const stamp = opts.stamp ?? new Date().toISOString().replace(/[:.]/g, '-');

  for (const pair of pathMap) {
    for (const lib of ['TV', 'Movies']) {
      const libRoot = `${pair.local}/${lib}`;
      if (!(await fs.stat(libRoot))) continue;
      const top = (await fs.readdir(libRoot)) ?? [];
      for (const entry of top) {
        // Rule 2: only non-canonical DIRECTORIES; loose files are pending renames.
        if (!entry.isDir) continue;
        if (CANONICAL_DIR.test(entry.name)) continue;
        if (entry.name.startsWith('#') || entry.name.startsWith('@')) continue; // #recycle, @eaDir
        const folder = `${libRoot}/${entry.name}`;
        const { files, dirs } = await walk(fs, folder);

        const candidates: Candidate[] = [];
        let untouchable = 0;
        for (const f of files) {
          if (plexKnown.has(pathKey(f.path))) {
            untouchable++;
            result.skippedPlexKnown.push(f.path);
            continue;
          }
          const cat = classify(posixBasename(f.path));
          if (!cat || !categories.includes(cat)) continue;
          const st = await fs.stat(f.path);
          candidates.push({ local: f.path, rel: `${lib}/${entry.name}/${f.rel}`, category: cat, bytes: st?.size ?? 0 });
        }
        if (candidates.length === 0 && untouchable > 0) continue;
        if (candidates.length === 0) {
          // Nothing to recycle, but the folder may still be an empty husk.
          if (categories.includes('husks') && files.length === 0) {
            for (const d of [...dirs].sort((a, b) => b.length - a.length).concat(folder)) {
              if (!opts.apply) continue;
              if ((await fs.rmdirIfEmpty(d)) === 'removed') result.dirsRemoved.push(d);
            }
            if (!opts.apply) log(`  would remove empty dir tree: ${folder}`);
          }
          continue;
        }

        const totalBytes = candidates.reduce((n, c) => n + c.bytes, 0);
        log(`\n  ${entry.name}`);
        log(
          `    ${candidates.length} file(s) to recycle (${(totalBytes / 1024 ** 3).toFixed(2)} GB)` +
            (untouchable > 0 ? ` · ${untouchable} Plex-indexed file(s) left untouched` : ''),
        );
        for (const c of candidates) {
          if (!opts.apply) {
            log(`      [${c.category}] ${c.local.replace(libRoot + '/', '')}`);
            continue;
          }
          // Rule 3: recycle, never unlink.
          const dest = `${pair.local}/#recycle/plex-rename-cleanup-${stamp}/${c.rel}`;
          try {
            await fs.mkdirp(dest.slice(0, dest.lastIndexOf('/')));
            await fs.rename(c.local, dest);
            result.recycled.push({ path: c.local, category: c.category, bytes: c.bytes });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.failures.push({ path: c.local, error: msg });
            log(`      FAILED to recycle ${c.local}: ${msg}`);
          }
        }

        // Rule 4: remove directories only once a fresh listing shows them empty,
        // deepest first so a drained tree collapses in one pass.
        if (opts.apply && categories.includes('husks')) {
          for (const d of [...dirs].sort((a, b) => b.length - a.length).concat(folder)) {
            if ((await fs.rmdirIfEmpty(d)) === 'removed') result.dirsRemoved.push(d);
          }
        }
      }
    }
  }

  const gb = result.recycled.reduce((n, r) => n + r.bytes, 0) / 1024 ** 3;
  const byCat = (c: Category) => result.recycled.filter((r) => r.category === c).length;
  log('\n─────────────────────────────────────────────');
  log(`Recycled: ${result.recycled.length} file(s), ${gb.toFixed(2)} GB — extras ${byCat('extras')}, metadata ${byCat('metadata')}, junk ${byCat('husks')}`);
  log(`Empty directories removed: ${result.dirsRemoved.length} · failures: ${result.failures.length}`);
  log(`Plex-indexed files skipped (untouchable): ${result.skippedPlexKnown.length}`);
  if (opts.apply) log(`Recycled content is under each share's #recycle/plex-rename-cleanup-${stamp}/ — empty the DSM recycle bin to reclaim space.`);
  else log('DRY RUN — re-run with --apply to perform this cleanup.');
  return result;
}

const isMain = process.argv[1]?.endsWith('plex-rename-cleanup-leftovers.ts');
if (isMain) {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? (onlyArg.slice(7).split(',') as Category[]) : undefined;
  cleanupLeftovers({ apply: process.argv.includes('--apply'), only })
    .then((r) => process.exit(r.failures.length > 0 ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
