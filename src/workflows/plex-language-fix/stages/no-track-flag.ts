// Flags files/episodes with NO audio track at all in their title's true original
// language — distinct from `plex-language-apply`'s "switch the default among
// existing tracks" job. A `no-match` file (scan.ts / evaluatePart already sets
// this status when it found zero audio candidates in every candidate language)
// is a strong signal the FILE ITSELF is probably the wrong rip/release (e.g. an
// English-dub-only Western release of a Japanese show) and should be re-acquired.
//
// This reuses the scan stage's own output (data/out/language-scan.json) rather
// than re-scanning the library — it never doubles the TMDB service's rate/quota
// spend. Modeled directly on missing-tv-seasons's "have I already flagged this?"
// notify-once ledger pattern (stages/notify.ts): only actionable (no-match) files
// get ledger rows at all; the first-ever run announces the whole current backlog.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { push } from '../../../core/notifier.js';
import { ignoredItemKeys, isWorkItemDone, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { plexLanguageFixConfig } from '../config.js';
import type { LanguageScanFile, ShowOrMovieEntry } from '../types.js';

/** The work_items key-space for the "already-flagged" ledger. */
export const NO_TRACK_JOB = 'plex-language-no-track-flag';

/** Ledger key for one file: `<itemRatingKey>::part<partId>`. */
export function fileKey(itemRatingKey: string, partId: number): string {
  return `${itemRatingKey}::part${partId}`;
}

/** One flagged file, carrying enough context to group + report on it. */
interface FlaggedFile {
  key: string;
  showOrMovieTitle: string;
  type: 'show' | 'movie';
  itemTitle: string;
  seasonEpisode?: string;
  file?: string;
  note?: string;
}

/** A push function shaped like core/notifier `push` (injectable for tests). */
export type PushFn = typeof push;

export interface NoTrackFlagOpts {
  /** Override the digest push (tests). Defaults to the real `push`. */
  push?: PushFn;
  /** Override "now" (tests). Defaults to a fresh Date. */
  now?: Date;
  /** Override the language-scan file path (tests). */
  scanFile?: string;
}

/** Flatten every `no-match` file out of the scan, tagged with its parent show/movie. */
function collectNoMatchFiles(items: ShowOrMovieEntry[]): FlaggedFile[] {
  const out: FlaggedFile[] = [];
  for (const item of items) {
    for (const f of item.files) {
      if (f.status !== 'no-match') continue;
      out.push({
        key: fileKey(f.itemRatingKey, f.partId),
        showOrMovieTitle: item.title,
        type: item.type,
        itemTitle: f.itemTitle,
        seasonEpisode: f.seasonEpisode,
        file: f.file,
        note: f.note,
      });
    }
  }
  return out;
}

/** Build the single digest push: title carries the count, body groups by show/movie. */
export function buildDigest(newFiles: FlaggedFile[]): { count: number; title: string; body: string } {
  const count = newFiles.length;
  const byTitle = groupByTitle(newFiles);
  const lines = [...byTitle.entries()].map(([title, files]) =>
    files.length > 1 ? `${title} (${files.length} episodes)` : title,
  );
  return {
    count,
    title: `🌐 ${count} file${count === 1 ? '' : 's'} with no original-language track`,
    body: lines.join(', '),
  };
}

function groupByTitle(files: FlaggedFile[]): Map<string, FlaggedFile[]> {
  const map = new Map<string, FlaggedFile[]>();
  for (const f of files) {
    const bucket = map.get(f.showOrMovieTitle) ?? [];
    bucket.push(f);
    map.set(f.showOrMovieTitle, bucket);
  }
  return map;
}

/**
 * Read the scan output, find every `no-match` file NOT already in the "flagged"
 * ledger, send ONE digest push of the newly-detected files, then mark each
 * flagged file done so it's never repeated. Also writes a markdown report
 * (recorded as the ledger items' `detail.markdown`, T110). FIRST run = one big
 * digest of the whole current backlog; if nothing is new, sends nothing.
 *
 * The ledger here is a "flagged" log, NOT a work-done log — only this stage uses
 * it, and only actionable (no-match) files ever get a row.
 */
export async function runNoTrackFlag(ctx: JobContext, opts: NoTrackFlagOpts = {}): Promise<void> {
  const pushFn = opts.push ?? push;
  const now = opts.now ?? new Date();
  const scanFile = opts.scanFile ?? plexLanguageFixConfig.scanOut;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('plex-language-no-track-flag starting');
  if (!existsSync(scanFile)) {
    throw new Error(`language-scan.json not found — run plex-language-scan first (${scanFile}).`);
  }
  const scan = JSON.parse(readFileSync(scanFile, 'utf8')) as LanguageScanFile;
  const allNoMatch = collectNoMatchFiles(scan.items ?? []);
  ctx.log(`Loaded ${allNoMatch.length} file(s) with no original-language audio track from the scan.`);

  const newFiles = allNoMatch.filter((f) => !isWorkItemDone(NO_TRACK_JOB, f.key, 1));
  const alreadyKnown = allNoMatch.length - newFiles.length;
  ctx.log(`Newly-detected: ${newFiles.length} (already flagged previously: ${alreadyKnown}).`);

  const reportPath = writeReport(allNoMatch, newFiles, now);
  ctx.log(`Wrote report ${reportPath}`);

  if (newFiles.length === 0) {
    ctx.progress(100, 'nothing new to flag');
    ctx.log('Nothing new — no digest sent. ✓');
    return;
  }

  const digest = buildDigest(newFiles);
  ctx.log(`Digest: ${digest.title} — ${digest.body}`);
  const res = await pushFn(digest.title, digest.body, { job: 'plex', tags: 'language', priority: 'default' });
  if (!res.ok) {
    ctx.log(
      `digest push FAILED (${res.error}) — NOT marking ${newFiles.length} file(s) flagged, so they're retried next run.`,
      'error',
    );
    throw new Error(`Digest push failed — ${res.error}`);
  }
  ctx.log(`digest push sent — ${digest.title}`);

  for (const f of newFiles) {
    markWorkItem(NO_TRACK_JOB, f.key, 'success', {
      detail: { name: `${f.showOrMovieTitle}${f.seasonEpisode ? ` ${f.seasonEpisode}` : ''}`, markdown: reportPath },
    });
  }

  ctx.progress(100, `${newFiles.length} new file(s) flagged`);
  ctx.log(`Marked ${newFiles.length} file(s) flagged.`);
}

/** Write a markdown report of the current backlog (excluding ignored files); returns its absolute path. */
function writeReport(allNoMatch: FlaggedFile[], newFiles: FlaggedFile[], now: Date): string {
  const ignoredKeys = ignoredItemKeys(NO_TRACK_JOB);
  const visible = allNoMatch.filter((f) => !ignoredKeys.has(f.key));
  const newKeys = new Set(newFiles.map((f) => f.key));

  const lines: string[] = [
    '---',
    `generatedAt: ${now.toISOString()}`,
    `flaggedFiles: ${visible.length}`,
    `newlyDetected: ${newFiles.length}`,
    '---',
    '',
    '# Plex — files with no original-language audio track',
    '',
    '_These are probably the wrong rip/release (e.g. a dub-only release of a foreign-language ' +
      'title) — consider re-acquiring._',
    '',
  ];
  if (visible.length === 0) {
    lines.push('_Nothing flagged — every file has a track in its title\'s original language._', '');
  }
  const byTitle = groupByTitle(visible);
  for (const [title, files] of [...byTitle.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`- **${title}**`);
    for (const f of [...files].sort((a, b) => (a.seasonEpisode ?? '').localeCompare(b.seasonEpisode ?? ''))) {
      const isNew = newKeys.has(f.key);
      const label = f.seasonEpisode ? `${f.seasonEpisode} — ${f.itemTitle}` : f.itemTitle;
      lines.push(`  - ${label}${isNew ? ' 🆕' : ''}${f.note ? ` _(${f.note})_` : ''}`);
    }
  }
  lines.push('');

  mkdirSync(plexLanguageFixConfig.reportDir, { recursive: true });
  const path = join(plexLanguageFixConfig.reportDir, 'no-track.md');
  writeFileSync(path, lines.join('\n'));
  return path;
}
