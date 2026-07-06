import { mkdirSync, writeFileSync } from 'node:fs';
import type { JobContext } from '../../../core/types.js';
import { markWorkItem } from '../../../db/store.js';
import { QuotaExceededError } from '../../../core/services.js';
import { plexLanguageFixConfig } from '../config.js';
import {
  buildCandidateLanguages,
  evaluatePart,
  extractTmdbId,
  fetchAllLeaves,
  fetchItemDetail,
  fetchSectionItems,
  fetchSections,
  lookupLanguageDetail,
  summarize,
} from '../lib.js';
import type { FileEntry, LanguageScanFile, PlexSection, ShowOrMovieEntry } from '../types.js';

export const JOB_NAME = 'plex-language-scan';

/** "2026-W27" — the ISO-8601 week key, used as the ledger key. Mirrors plex-space-saver's weekKey. */
export function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

const EPISODE_CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function processMovie(ctx: JobContext, sectionTitle: string, ratingKey: string, title: string): Promise<ShowOrMovieEntry> {
  const detail = await fetchItemDetail(ratingKey);
  const base: ShowOrMovieEntry = { sectionTitle, ratingKey, title, type: 'movie', files: [] };
  if (!detail) return { ...base, skippedReason: 'could not fetch item detail' };

  const tmdbId = extractTmdbId(detail.Guid);
  if (!tmdbId) return { ...base, skippedReason: 'no tmdb Guid on this item' };
  base.tmdbId = tmdbId;

  let originalLanguage: string | undefined;
  let spokenLanguages: { code: string; name: string }[] = [];
  try {
    const info = await lookupLanguageDetail(tmdbId, 'movie');
    originalLanguage = info.originalLanguage;
    spokenLanguages = info.spokenLanguages;
  } catch (err) {
    if (err instanceof QuotaExceededError) throw err;
    return { ...base, skippedReason: `TMDB lookup failed: ${err instanceof Error ? err.message : err}` };
  }
  base.originalLanguage = originalLanguage;
  base.spokenLanguages = spokenLanguages;
  const candidateLanguages = buildCandidateLanguages(originalLanguage, spokenLanguages);
  base.candidateLanguages = candidateLanguages;
  if (candidateLanguages.length === 0) return { ...base, skippedReason: 'TMDB returned no original_language or spoken_languages' };

  // Every title gets its audio pinned explicitly (see types.ts's StreamChoice.isExplicit),
  // including English-original titles, so a multi-dub file's own baked-in default flag can
  // never silently win instead.
  const files: FileEntry[] = [];
  for (const media of detail.Media ?? []) {
    for (const part of media.Part ?? []) {
      files.push(evaluatePart(ratingKey, title, undefined, part, candidateLanguages));
    }
  }
  return { ...base, files };
}

async function processShow(ctx: JobContext, sectionTitle: string, ratingKey: string, title: string): Promise<ShowOrMovieEntry> {
  const detail = await fetchItemDetail(ratingKey);
  const base: ShowOrMovieEntry = { sectionTitle, ratingKey, title, type: 'show', files: [] };
  if (!detail) return { ...base, skippedReason: 'could not fetch item detail' };

  const tmdbId = extractTmdbId(detail.Guid);
  if (!tmdbId) return { ...base, skippedReason: 'no tmdb Guid on this item' };
  base.tmdbId = tmdbId;

  let originalLanguage: string | undefined;
  let spokenLanguages: { code: string; name: string }[] = [];
  try {
    const info = await lookupLanguageDetail(tmdbId, 'show');
    originalLanguage = info.originalLanguage;
    spokenLanguages = info.spokenLanguages;
  } catch (err) {
    if (err instanceof QuotaExceededError) throw err;
    return { ...base, skippedReason: `TMDB lookup failed: ${err instanceof Error ? err.message : err}` };
  }
  base.originalLanguage = originalLanguage;
  base.spokenLanguages = spokenLanguages;
  const candidateLanguages = buildCandidateLanguages(originalLanguage, spokenLanguages);
  base.candidateLanguages = candidateLanguages;
  if (candidateLanguages.length === 0) return { ...base, skippedReason: 'TMDB returned no original_language or spoken_languages' };

  const leaves = await fetchAllLeaves(ratingKey);
  const perEpisode = await mapWithConcurrency(leaves, EPISODE_CONCURRENCY, async (leaf) => {
    const epDetail = await fetchItemDetail(leaf.ratingKey);
    if (!epDetail) return [] as FileEntry[];
    const se =
      leaf.parentIndex != null && leaf.index != null
        ? `S${String(leaf.parentIndex).padStart(2, '0')}E${String(leaf.index).padStart(2, '0')}`
        : undefined;
    const out: FileEntry[] = [];
    for (const media of epDetail.Media ?? []) {
      for (const part of media.Part ?? []) {
        out.push(evaluatePart(leaf.ratingKey, leaf.title, se, part, candidateLanguages));
      }
    }
    return out;
  });

  return { ...base, files: perEpisode.flat() };
}

export interface ScanOpts {
  /** Override "now" (tests). Defaults to a fresh Date. */
  now?: Date;
}

/**
 * Scan the whole Plex library (movie + TV sections, plus the optional
 * downloadable section when configured), resolve each title's true original
 * language via TMDB, and work out which audio/subtitle track SHOULD be selected
 * per file — writing the full changeset as a structured JSON artifact.
 * READ-ONLY: never mutates Plex. RE-SCANS FRESH every run (an audit of
 * drifting real-world state, not a one-time build) — idempotent per ISO
 * calendar week via the work_items ledger, mirroring plex-space-saver.
 */
export async function runScan(ctx: JobContext, opts: ScanOpts = {}): Promise<void> {
  mkdirSync(plexLanguageFixConfig.outDir, { recursive: true });
  const now = opts.now ?? new Date();

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('plex-language-scan starting — read-only, never mutates Plex.');

  const configuredKeys = new Set(
    [plexLanguageFixConfig.movieSection, plexLanguageFixConfig.tvSection, plexLanguageFixConfig.downloadableSection].filter(
      (v): v is string => Boolean(v),
    ),
  );
  ctx.log(`Configured sections: movie=${plexLanguageFixConfig.movieSection}, tv=${plexLanguageFixConfig.tvSection}` +
    (plexLanguageFixConfig.downloadableSection ? `, downloadable=${plexLanguageFixConfig.downloadableSection}` : ' (no downloadable section configured)'));

  ctx.progress(5, 'fetching library sections');
  const allSections = await fetchSections();
  const sections: PlexSection[] = allSections.filter((s) => configuredKeys.has(s.key));
  ctx.log(`Plex reports ${allSections.length} movie/show section(s); scanning ${sections.length}: ${sections.map((s) => `${s.title} (${s.type}, key=${s.key})`).join(', ') || 'none'}`);

  const items: ShowOrMovieEntry[] = [];
  for (const section of sections) {
    const listing = await fetchSectionItems(section.key, section.type);
    ctx.log(`"${section.title}" (${section.type}): ${listing.length} item(s)`);
    for (let i = 0; i < listing.length; i++) {
      const it = listing[i];
      try {
        const entry =
          section.type === 'movie'
            ? await processMovie(ctx, section.title, it.ratingKey, it.title)
            : await processShow(ctx, section.title, it.ratingKey, it.title);
        items.push(entry);
        const s = summarize([entry]);
        if (entry.skippedReason) {
          ctx.log(`  [${i + 1}/${listing.length}] "${it.title}" — skipped: ${entry.skippedReason}`);
        } else if (s.changes > 0) {
          ctx.log(`  [${i + 1}/${listing.length}] "${it.title}" — lang=${entry.originalLanguage} — ${s.changes} change(s), ${s.alreadyCorrect} already correct, ${s.noMatch} no-match`);
        } else if ((i + 1) % 50 === 0) {
          ctx.log(`  [${i + 1}/${listing.length}] scanned…`);
        }
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          ctx.log(`TMDB ${err.window} cap reached (${err.used}/${err.cap}) — stopping gracefully.`, 'warn');
          break;
        }
        ctx.log(`  ✗ "${it.title}" — ${err instanceof Error ? err.message : err}`, 'warn');
      }
    }
    ctx.progress(10 + Math.round((70 * (sections.indexOf(section) + 1)) / Math.max(sections.length, 1)), `scanned ${section.title}`);
  }

  const scan: LanguageScanFile = {
    generatedAt: now.toISOString(),
    sectionsScanned: sections.map((s) => `${s.title} (${s.type})`),
    items,
  };

  ctx.progress(90, 'writing scan output');
  writeFileSync(plexLanguageFixConfig.scanOut, JSON.stringify(scan, null, 2));
  ctx.log(`Wrote ${plexLanguageFixConfig.scanOut}`);

  const s = summarize(items);
  ctx.log('═══════════════ SCAN SUMMARY ═══════════════');
  ctx.log(`Scanned ${items.length} show(s)/movie(s) across ${sections.length} section(s).`);
  ctx.log(`Proposed changes: ${s.changes} · already correct: ${s.alreadyCorrect} · no matching track: ${s.noMatch}`);
  ctx.log('═════════════════════════════════════════');

  // Idempotent per ISO week (report-only; a re-run the same week regenerates
  // it). Declared output form (T262): 'json', served from detail.path via
  // safeOutputFile.
  const key = weekKey(now);
  markWorkItem(JOB_NAME, key, 'success', {
    detail: {
      name: `Language scan — ${key}`,
      format: 'json',
      path: plexLanguageFixConfig.scanOut,
    },
  });

  ctx.progress(100, `${items.length} title(s) scanned — ${s.changes} change(s) proposed`);
}
