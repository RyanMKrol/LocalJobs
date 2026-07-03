// Pure Plex-parsing/formatting helpers (no I/O) — unit-tested in plex-space-saver.test.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { plexSpaceSaverConfig } from './config.js';
import type {
  PlexEpisodeMeta,
  PlexMovieMeta,
  PlexShowMeta,
  SizeBreakdownFile,
  SizeBreakdownItem,
} from './types.js';

export function ensureDirs(): void {
  mkdirSync(plexSpaceSaverConfig.outDir, { recursive: true });
}

export function writeJsonFile(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
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
