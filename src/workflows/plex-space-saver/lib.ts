// Pure Plex-parsing/formatting helpers (no I/O) — unit-tested in plex-space-saver.test.ts.
import { existsSync, readFileSync } from 'node:fs';
import { ensureDirs as coreEnsureDirs, writeJsonFile } from '../../core/fsjson.js';
import { plexSpaceSaverConfig } from './config.js';
import type {
  PlexEpisodeMeta,
  PlexMovieMeta,
  PlexShowMeta,
  SizeBaselineFile,
  SizeBreakdownFile,
  SizeBreakdownItem,
} from './types.js';

export function ensureDirs(): void {
  coreEnsureDirs(plexSpaceSaverConfig.outDir);
}

export { writeJsonFile };

/** Read the persisted prior-run baseline, or `null` if this is the first run. */
export function readBaseline(path: string): SizeBaselineFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SizeBaselineFile;
    if (typeof parsed?.totalBytes !== 'number' || typeof parsed?.at !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist this run's total as the new baseline for the NEXT run to diff against. */
export function writeBaseline(path: string, totalBytes: number, at: string): void {
  writeJsonFile(path, { totalBytes, at } satisfies SizeBaselineFile);
}

/** The outcome of diffing this run's total against the prior baseline. */
export interface DropCheck {
  /** Whether a prior baseline existed to diff against (false on the first-ever run). */
  hasPrior: boolean;
  /** `prior.totalBytes - current.totalBytes` (positive = shrink). Only meaningful when `hasPrior`. */
  dropBytes: number;
  /** Whether the drop exceeds the configured threshold — the library alert-worthy. */
  exceeds: boolean;
}

/**
 * Diff this run's total against the prior baseline (if any) and decide whether the
 * shrink exceeds the absolute-GB threshold (T519 owner decision — GB, not a
 * percentage). No prior baseline, or `current >= prior` (stable/growing), never
 * exceeds.
 */
export function checkDrop(prior: SizeBaselineFile | null, currentTotalBytes: number, thresholdGb: number): DropCheck {
  if (!prior) return { hasPrior: false, dropBytes: 0, exceeds: false };
  const dropBytes = prior.totalBytes - currentTotalBytes;
  const thresholdBytes = thresholdGb * 1024 ** 3;
  return { hasPrior: true, dropBytes, exceeds: dropBytes > thresholdBytes };
}

/** Sum every `Media[].Part[].size` on one item — a movie or an episode. */
export function itemBytes(item: { Media?: { Part?: { size?: number }[] }[] }): number {
  let total = 0;
  for (const media of item.Media ?? []) {
    for (const part of media.Part ?? []) {
      if (typeof part.size === 'number') total += part.size;
    }
  }
  return total;
}

/** Format a byte count as a human-readable size (binary units, matching Plex's own GB display). */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

/** One row per movie: sum its own media parts. */
export function buildMovieRows(movies: PlexMovieMeta[]): SizeBreakdownItem[] {
  return movies.map((m) => {
    const bytes = itemBytes(m);
    return {
      title: m.title ?? '(untitled)',
      year: typeof m.year === 'number' ? m.year : null,
      type: 'movie' as const,
      ratingKey: String(m.ratingKey ?? ''),
      bytes,
      human: formatBytes(bytes),
    };
  });
}

/** One row per show: sum every episode's media parts, grouped by grandparentRatingKey. */
export function buildShowRows(shows: PlexShowMeta[], episodes: PlexEpisodeMeta[]): SizeBreakdownItem[] {
  const bytesByShow = new Map<string, number>();
  for (const ep of episodes) {
    const key = String(ep.grandparentRatingKey ?? '');
    if (!key) continue;
    bytesByShow.set(key, (bytesByShow.get(key) ?? 0) + itemBytes(ep));
  }
  return shows.map((s) => {
    const ratingKey = String(s.ratingKey ?? '');
    const bytes = bytesByShow.get(ratingKey) ?? 0;
    return {
      title: s.title ?? '(untitled)',
      year: typeof s.year === 'number' ? s.year : null,
      type: 'show' as const,
      ratingKey,
      bytes,
      human: formatBytes(bytes),
    };
  });
}

/** Combine movie + show rows into the final biggest-first breakdown artifact. */
export function buildBreakdown(
  movieRows: SizeBreakdownItem[],
  showRows: SizeBreakdownItem[],
  movieSection: string,
  tvSection: string,
  now: Date,
): SizeBreakdownFile {
  const items = [...movieRows, ...showRows].sort((a, b) => b.bytes - a.bytes);
  const totalBytes = items.reduce((n, i) => n + i.bytes, 0);
  return {
    generatedAt: now.toISOString(),
    movieSection,
    tvSection,
    totalBytes,
    totalHuman: formatBytes(totalBytes),
    movieCount: movieRows.length,
    showCount: showRows.length,
    items,
  };
}
