import type { JobContext } from '../../../core/types.js';
import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import { plexLanguageFixConfig } from '../config.js';
import { extractTmdbId, fetchAllLeaves, fetchItemDetail, fetchSectionItems, fetchSections } from '../lib.js';
import type { DiscoverDetail, PlexSection } from '../types.js';
import { ledgerSuccessRows } from './ledger.js';

export const JOB_NAME = 'plex-language-discover';
const MAX_ATTEMPTS = 3;

/** The ledger key shared by every stage in this workflow: one file (a movie, or one episode's part). */
export function fileKey(itemRatingKey: string, partId: number): string {
  return `${itemRatingKey}::part${partId}`;
}

/**
 * Root-stage input keys (T094) — this workflow is limitable for the first time.
 * Returns every file key the discover ledger already knows about (from a prior
 * run); a manual run-limit selects among these. Guarded like `places`'s
 * `resolveInputKeys`: an empty ledger (first-ever run) returns [] — the limit
 * then selects nothing, so an unlimited first run is required to seed it.
 */
export function discoverInputKeys(): string[] {
  return ledgerSuccessRows(JOB_NAME).map((r) => r.itemKey);
}

/** Injectable seam for tests — defaults to the real Plex-touching lib.ts functions. */
export interface PlexFetchOverrides {
  fetchSections?: typeof fetchSections;
  fetchSectionItems?: typeof fetchSectionItems;
  fetchItemDetail?: typeof fetchItemDetail;
  fetchAllLeaves?: typeof fetchAllLeaves;
}

/**
 * Enumerate every file (movie, or TV episode) across the configured library
 * sections and record it on the `plex-language-discover` ledger, keyed by
 * `${itemRatingKey}::part${partId}` — PERMANENTLY: once a file is known it is
 * never re-marked (skip if `isWorkItemDone` is already true). Read-only, never
 * mutates Plex, and makes NO TMDB call (that's `plex-language-resolve`'s job) —
 * it only extracts a title's tmdb id from its own Plex Guid.
 *
 * This ALWAYS walks the whole configured library fresh (like the old
 * `plex-language-scan`) so a newly-added file is discovered — only the LEDGER
 * WRITE is skipped for a file already known, not the Plex read. Idempotency for
 * expensive/mutating work lives downstream (resolve/evaluate/apply each process
 * a file exactly once, ever).
 */
export async function runDiscover(ctx: JobContext, opts: PlexFetchOverrides = {}): Promise<void> {
  const doFetchSections = opts.fetchSections ?? fetchSections;
  const doFetchSectionItems = opts.fetchSectionItems ?? fetchSectionItems;
  const doFetchItemDetail = opts.fetchItemDetail ?? fetchItemDetail;
  const doFetchAllLeaves = opts.fetchAllLeaves ?? fetchAllLeaves;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('plex-language-discover starting — read-only, never mutates Plex, no TMDB calls.');

  const configuredKeys = new Set(
    [plexLanguageFixConfig.movieSection, plexLanguageFixConfig.tvSection, plexLanguageFixConfig.downloadableSection].filter(
      (v): v is string => Boolean(v),
    ),
  );
  ctx.log(
    `Configured sections: movie=${plexLanguageFixConfig.movieSection}, tv=${plexLanguageFixConfig.tvSection}` +
      (plexLanguageFixConfig.downloadableSection ? `, downloadable=${plexLanguageFixConfig.downloadableSection}` : ' (no downloadable section configured)'),
  );

  ctx.progress(5, 'fetching library sections');
  const allSections = await doFetchSections();
  const sections: PlexSection[] = allSections.filter((s) => configuredKeys.has(s.key));
  ctx.log(
    `Plex reports ${allSections.length} movie/show section(s); scanning ${sections.length}: ${sections.map((s) => `${s.title} (${s.type}, key=${s.key})`).join(', ') || 'none'}`,
  );

  let discovered = 0;
  let alreadyKnown = 0;
  let skippedNoTmdb = 0;

  function recordFile(
    itemRatingKey: string,
    partId: number,
    file: string | undefined,
    name: string,
    type: 'movie' | 'show',
    tmdbId: number,
    seasonEpisode?: string,
  ): void {
    const key = fileKey(itemRatingKey, partId);
    if (!ctx.rootAllowed(key)) return;
    if (isWorkItemDone(JOB_NAME, key, MAX_ATTEMPTS)) {
      alreadyKnown++;
      return;
    }
    const detail: DiscoverDetail = { name, file, itemRatingKey, partId, type, tmdbId, seasonEpisode };
    markWorkItem(JOB_NAME, key, 'success', { detail });
    discovered++;
  }

  for (const section of sections) {
    const listing = await doFetchSectionItems(section.key, section.type);
    ctx.log(`"${section.title}" (${section.type}): ${listing.length} item(s)`);

    for (let i = 0; i < listing.length; i++) {
      const it = listing[i];
      try {
        if (section.type === 'movie') {
          const detail = await doFetchItemDetail(it.ratingKey);
          if (!detail) {
            ctx.log(`  ✗ "${it.title}" — could not fetch item detail`, 'warn');
            continue;
          }
          const tmdbId = extractTmdbId(detail.Guid);
          if (!tmdbId) {
            skippedNoTmdb++;
            continue;
          }
          for (const media of detail.Media ?? []) {
            for (const part of media.Part ?? []) {
              recordFile(it.ratingKey, part.id, part.file, detail.title ?? it.title, 'movie', tmdbId);
            }
          }
        } else {
          const showDetail = await doFetchItemDetail(it.ratingKey);
          if (!showDetail) {
            ctx.log(`  ✗ "${it.title}" — could not fetch item detail`, 'warn');
            continue;
          }
          const tmdbId = extractTmdbId(showDetail.Guid);
          if (!tmdbId) {
            skippedNoTmdb++;
            continue;
          }
          const leaves = await doFetchAllLeaves(it.ratingKey);
          for (const leaf of leaves) {
            const epDetail = await doFetchItemDetail(leaf.ratingKey);
            if (!epDetail) continue;
            const se =
              leaf.parentIndex != null && leaf.index != null
                ? `S${String(leaf.parentIndex).padStart(2, '0')}E${String(leaf.index).padStart(2, '0')}`
                : undefined;
            for (const media of epDetail.Media ?? []) {
              for (const part of media.Part ?? []) {
                recordFile(leaf.ratingKey, part.id, part.file, `${it.title} — ${se ?? leaf.title}`, 'show', tmdbId, se);
              }
            }
          }
        }
        if ((i + 1) % 50 === 0) ctx.log(`  [${i + 1}/${listing.length}] walked…`);
      } catch (err) {
        ctx.log(`  ✗ "${it.title}" — ${err instanceof Error ? err.message : err}`, 'warn');
      }
    }
    ctx.progress(10 + Math.round((80 * (sections.indexOf(section) + 1)) / Math.max(sections.length, 1)), `discovered ${section.title}`);
  }

  ctx.log('═══════════════ DISCOVER SUMMARY ═══════════════');
  ctx.log(`New file(s) recorded: ${discovered} · already known: ${alreadyKnown} · skipped (no tmdb Guid): ${skippedNoTmdb}`);
  ctx.log('══════════════════════════════════════════════');
  ctx.progress(100, `${discovered} new file(s), ${alreadyKnown} already known`);
}
