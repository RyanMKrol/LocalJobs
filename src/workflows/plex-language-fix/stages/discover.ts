import type { JobContext } from '../../../core/types.js';
import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import { plexLanguageFixConfig } from '../config.js';
import { extractTmdbId, fetchAllLeaves, fetchItemDetail, fetchSectionItems, fetchSections } from '../lib.js';
import type { DiscoverDetail, PlexSection } from '../types.js';

export const JOB_NAME = 'plex-language-discover';
const MAX_ATTEMPTS = 3;

/** The ledger key shared by every stage in this workflow: one file (a movie, or one episode's part). */
export function fileKey(itemRatingKey: string, partId: number): string {
  return `${itemRatingKey}::part${partId}`;
}

/** Injectable seam for tests — defaults to the real Plex-touching lib.ts functions. */
export interface PlexFetchOverrides {
  fetchSections?: typeof fetchSections;
  fetchSectionItems?: typeof fetchSectionItems;
  fetchItemDetail?: typeof fetchItemDetail;
  fetchAllLeaves?: typeof fetchAllLeaves;
}

/** One discoverable file, as surfaced by a live library walk (before any ledger write). */
type LibraryFileEntry = DiscoverDetail;

/** Hooks `walkLibraryFiles` invokes as it walks, so `runDiscover` can narrate progress via `ctx`. */
interface WalkHooks {
  onSectionsFetched?(sections: PlexSection[], allCount: number): void;
  onSectionItems?(section: PlexSection, count: number): void;
  onItemError?(title: string, message: string): void;
  onItemProgress?(section: PlexSection, index: number, total: number): void;
  onSkippedNoTmdb?(): void;
  onSectionDone?(section: PlexSection, sectionIndex: number, totalSections: number): void;
}

/**
 * The single, shared live Plex library walk this workflow uses to enumerate
 * files — every movie (with its parts) and every TV episode (with its parts)
 * across the configured sections, each carrying the tmdb id extracted from its
 * own Plex Guid. Read-only, makes no TMDB call, and reuses the SAME
 * `fetchSections`/`fetchSectionItems`/`fetchItemDetail`/`fetchAllLeaves` helpers
 * from `lib.ts` — which already route every Plex read through
 * `callService('plex', ...)` (T578) — so both `runDiscover` (which records each
 * entry to the ledger) and `discoverInputKeys` (which just needs the current
 * candidate key set, live, with no dependency on any prior ledger state) walk
 * the SAME underlying implementation rather than diverging.
 */
async function walkLibraryFiles(opts: PlexFetchOverrides = {}, hooks: WalkHooks = {}): Promise<LibraryFileEntry[]> {
  const doFetchSections = opts.fetchSections ?? fetchSections;
  const doFetchSectionItems = opts.fetchSectionItems ?? fetchSectionItems;
  const doFetchItemDetail = opts.fetchItemDetail ?? fetchItemDetail;
  const doFetchAllLeaves = opts.fetchAllLeaves ?? fetchAllLeaves;

  const configuredKeys = new Set(
    [plexLanguageFixConfig.movieSection, plexLanguageFixConfig.tvSection, plexLanguageFixConfig.downloadableSection].filter(
      (v): v is string => Boolean(v),
    ),
  );

  const allSections = await doFetchSections();
  const sections: PlexSection[] = allSections.filter((s) => configuredKeys.has(s.key));
  hooks.onSectionsFetched?.(sections, allSections.length);

  const entries: LibraryFileEntry[] = [];

  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const section = sections[sIdx];
    const listing = await doFetchSectionItems(section.key, section.type);
    hooks.onSectionItems?.(section, listing.length);

    for (let i = 0; i < listing.length; i++) {
      const it = listing[i];
      try {
        if (section.type === 'movie') {
          const detail = await doFetchItemDetail(it.ratingKey);
          if (!detail) {
            hooks.onItemError?.(it.title, 'could not fetch item detail');
            continue;
          }
          const tmdbId = extractTmdbId(detail.Guid);
          if (!tmdbId) {
            hooks.onSkippedNoTmdb?.();
            continue;
          }
          for (const media of detail.Media ?? []) {
            for (const part of media.Part ?? []) {
              entries.push({
                itemRatingKey: it.ratingKey,
                partId: part.id,
                file: part.file,
                name: detail.title ?? it.title,
                type: 'movie',
                tmdbId,
              });
            }
          }
        } else {
          const showDetail = await doFetchItemDetail(it.ratingKey);
          if (!showDetail) {
            hooks.onItemError?.(it.title, 'could not fetch item detail');
            continue;
          }
          const tmdbId = extractTmdbId(showDetail.Guid);
          if (!tmdbId) {
            hooks.onSkippedNoTmdb?.();
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
                entries.push({
                  itemRatingKey: leaf.ratingKey,
                  partId: part.id,
                  file: part.file,
                  name: `${it.title} — ${se ?? leaf.title}`,
                  type: 'show',
                  tmdbId,
                  seasonEpisode: se,
                });
              }
            }
          }
        }
        hooks.onItemProgress?.(section, i + 1, listing.length);
      } catch (err) {
        hooks.onItemError?.(it.title, err instanceof Error ? err.message : String(err));
      }
    }
    hooks.onSectionDone?.(section, sIdx + 1, sections.length);
  }

  return entries;
}

/**
 * Root-stage input keys (T094) — this workflow is limitable. Performs a LIVE
 * Plex library walk (via the shared `walkLibraryFiles`, routed through
 * `callService('plex', ...)` per T578) and returns every file key it currently
 * finds — NOT a read-back of this job's own prior `work_items` success rows.
 *
 * This deliberately replaces the earlier ledger-readback implementation, which
 * had a self-referential trap: after "Clear output data" wipes this workflow's
 * ledger, the ledger-readback version had nothing to read and silently returned
 * [] — so a manually-limited run picked zero roots and no-op'd instead of
 * re-discovering the library. A live walk has no such dependency on prior state.
 *
 * Known, accepted tradeoff: every manual limited-run request now pays the cost
 * of a full/partial library crawl just to compute candidate keys, instead of a
 * cheap ledger read — correct versus silently no-opping on a reset ledger.
 */
export async function discoverInputKeys(opts: PlexFetchOverrides = {}): Promise<string[]> {
  const entries = await walkLibraryFiles(opts);
  return entries.map((e) => fileKey(e.itemRatingKey, e.partId));
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
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('plex-language-discover starting — read-only, never mutates Plex, no TMDB calls.');
  ctx.log(
    `Configured sections: movie=${plexLanguageFixConfig.movieSection}, tv=${plexLanguageFixConfig.tvSection}` +
      (plexLanguageFixConfig.downloadableSection ? `, downloadable=${plexLanguageFixConfig.downloadableSection}` : ' (no downloadable section configured)'),
  );
  ctx.progress(5, 'fetching library sections');

  let skippedNoTmdb = 0;

  const entries = await walkLibraryFiles(opts, {
    onSectionsFetched(sections, allCount) {
      ctx.log(
        `Plex reports ${allCount} movie/show section(s); scanning ${sections.length}: ${sections.map((s) => `${s.title} (${s.type}, key=${s.key})`).join(', ') || 'none'}`,
      );
    },
    onSectionItems(section, count) {
      ctx.log(`"${section.title}" (${section.type}): ${count} item(s)`);
    },
    onItemError(title, message) {
      ctx.log(`  ✗ "${title}" — ${message}`, 'warn');
    },
    onSkippedNoTmdb() {
      skippedNoTmdb++;
    },
    onItemProgress(_section, i, total) {
      if (i % 50 === 0) ctx.log(`  [${i}/${total}] walked…`);
    },
    onSectionDone(section, sectionIndex, totalSections) {
      ctx.progress(10 + Math.round((80 * sectionIndex) / Math.max(totalSections, 1)), `discovered ${section.title}`);
    },
  });

  let discovered = 0;
  let alreadyKnown = 0;

  for (const entry of entries) {
    const key = fileKey(entry.itemRatingKey, entry.partId);
    if (!ctx.rootAllowed(key)) continue;
    if (isWorkItemDone(JOB_NAME, key, MAX_ATTEMPTS)) {
      alreadyKnown++;
      continue;
    }
    markWorkItem(JOB_NAME, key, 'success', { detail: entry });
    discovered++;
  }

  ctx.log('═══════════════ DISCOVER SUMMARY ═══════════════');
  ctx.log(`New file(s) recorded: ${discovered} · already known: ${alreadyKnown} · skipped (no tmdb Guid): ${skippedNoTmdb}`);
  ctx.log('══════════════════════════════════════════════');
  ctx.progress(100, `${discovered} new file(s), ${alreadyKnown} already known`);
}
