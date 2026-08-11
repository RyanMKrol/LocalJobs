import type { JobContext } from '../../../core/types.js';
import { extractImdbId, extractTmdbId, extractTvdbId } from '../../../core/plex-client.js';
import { getWorkItem, markWorkItem, pruneSnapshotRows } from '../../../db/store.js';
import { plexRenameConfig } from '../config.js';
import { fetchAllLeaves, fetchSectionItems, fetchSections } from '../lib.js';
import { pathKey, resolveLibraryRoot, type EpisodeRef, type LibraryRoot } from '../naming.js';
import type { DiscoverDetail, PlexMetadataItem, PlexSection } from '../types.js';

export const JOB_NAME = 'plex-rename-discover';

/** The ledger key shared by every stage in this workflow: one physical file. */
export function fileKey(itemRatingKey: string, partId: number): string {
  return `${itemRatingKey}::part${partId}`;
}

/** Injectable seam for tests — defaults to the real (LIVE, never-cached) lib.ts helpers. */
export interface PlexFetchOverrides {
  fetchSections?: typeof fetchSections;
  fetchSectionItems?: typeof fetchSectionItems;
  fetchAllLeaves?: typeof fetchAllLeaves;
}

interface WalkHooks {
  onSectionsFetched?(sections: PlexSection[], allCount: number): void;
  onSectionItems?(section: PlexSection, count: number): void;
  onItemError?(title: string, message: string): void;
  onItemProgress?(section: PlexSection, index: number, total: number): void;
  onSectionDone?(section: PlexSection, sectionIndex: number, totalSections: number): void;
}

export interface WalkResult {
  entries: DiscoverDetail[];
  /** Library roots as reported by Plex's own section Location paths. */
  roots: LibraryRoot[];
  /** Files skipped because their Part carried no file path (never renameable). */
  skippedNoFile: number;
}

/**
 * The single, shared LIVE Plex library walk: every movie part and every TV
 * episode part across the configured sections, each carrying everything the
 * naming engine needs (title/year/ids/edition for movies; show + episode
 * numbering/titles/airdates for TV). Multi-episode files are detected by
 * grouping a show's leaves by their Part id and merged into ONE entry carrying
 * every episode it represents. Library roots come from Plex's own section
 * `Location` paths — authoritative, no extra env var. Used by both
 * `runDiscover` (records the ledger) and `discoverInputKeys` (the T485
 * live-walk limitable root — never a ledger read-back).
 *
 * CALL BUDGET (deliberate, do not regress): 1 sections call + 1 listing per
 * section (`includeGuids=1` puts Guid/year/Media.Part on every item) + 1
 * `allLeaves` per show (leaves carry their full Media.Part too, live-verified)
 * ≈ ~640 requests for the owner's library. The first implementation fetched
 * `/library/metadata/<key>` PER ITEM — one call per movie and per EPISODE —
 * which at the plex service's 300/min rate cap turned the TV walk into a
 * 1–2+ hour crawl. Never reintroduce a per-episode fetch here.
 */
export async function walkLibraryParts(opts: PlexFetchOverrides = {}, hooks: WalkHooks = {}): Promise<WalkResult> {
  const doFetchSections = opts.fetchSections ?? fetchSections;
  const doFetchSectionItems = opts.fetchSectionItems ?? fetchSectionItems;
  const doFetchAllLeaves = opts.fetchAllLeaves ?? fetchAllLeaves;

  const configuredKeys = new Set([plexRenameConfig.movieSection, plexRenameConfig.tvSection].filter(Boolean));
  const allSections = await doFetchSections();
  const sections = allSections.filter((s) => configuredKeys.has(s.key));
  hooks.onSectionsFetched?.(sections, allSections.length);

  const roots: LibraryRoot[] = [];
  for (const section of sections) {
    for (const loc of section.Location ?? []) {
      if (loc.path) roots.push({ path: loc.path.replace(/\/+$/, ''), kind: section.type === 'movie' ? 'movie' : 'tv' });
    }
  }

  const entries: DiscoverDetail[] = [];
  let skippedNoFile = 0;

  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const section = sections[sIdx];
    const listing = await doFetchSectionItems(section.key, section.type);
    hooks.onSectionItems?.(section, listing.length);

    for (let i = 0; i < listing.length; i++) {
      const it = listing[i];
      try {
        if (section.type === 'movie') {
          collectMovieParts(it, roots, entries, () => skippedNoFile++);
        } else {
          const leaves = await doFetchAllLeaves(it.ratingKey);
          collectShowParts(it, leaves, roots, entries, () => skippedNoFile++);
        }
        hooks.onItemProgress?.(section, i + 1, listing.length);
      } catch (err) {
        hooks.onItemError?.(it.title, err instanceof Error ? err.message : String(err));
      }
    }
    hooks.onSectionDone?.(section, sIdx + 1, sections.length);
  }

  return { entries, roots, skippedNoFile };
}

function rootFor(file: string, roots: LibraryRoot[]): string {
  return resolveLibraryRoot(file, roots)?.path ?? '';
}

function collectMovieParts(
  detail: PlexMetadataItem,
  roots: LibraryRoot[],
  out: DiscoverDetail[],
  onNoFile: () => void,
): void {
  const mediaCount = detail.Media?.length ?? 0;
  for (const media of detail.Media ?? []) {
    const partCount = media.Part?.length ?? 0;
    (media.Part ?? []).forEach((part, partIndex) => {
      if (!part.file) {
        onNoFile();
        return;
      }
      out.push({
        name: `${detail.title}${detail.year ? ` (${detail.year})` : ''}`,
        kind: 'movie',
        file: part.file,
        partId: part.id,
        partSize: part.size,
        mediaCount,
        partCount,
        partIndex,
        rootPath: rootFor(part.file, roots),
        movie: {
          ratingKey: detail.ratingKey,
          title: detail.title,
          year: detail.year,
          tmdbId: extractTmdbId(detail.Guid) ?? undefined,
          imdbId: extractImdbId(detail.Guid) ?? undefined,
          editionTitle: detail.editionTitle,
        },
      });
    });
  }
}

function collectShowParts(
  show: PlexMetadataItem,
  leafDetails: PlexMetadataItem[],
  roots: LibraryRoot[],
  out: DiscoverDetail[],
  onNoFile: () => void,
): void {
  const showRef = {
    ratingKey: show.ratingKey,
    title: show.title,
    year: show.year,
    tvdbId: extractTvdbId(show.Guid) ?? undefined,
    tmdbId: extractTmdbId(show.Guid) ?? undefined,
    imdbId: extractImdbId(show.Guid) ?? undefined,
  };

  // Group every leaf's parts by FILE PATH (case-folded NFC) — a multi-episode
  // FILE surfaces as multiple leaves pointing at the same physical file, and
  // Plex does NOT reliably share one part id across them: a real library
  // double-episode (Mr.Robot.S02E01E02) carried TWO DIFFERENT part ids for
  // the one file, so grouping by part id split it into two single-episode
  // items — the first move renamed the file to an s02e01-only name and the
  // second found its source gone (a harmless soft-skip, but episode 2 would
  // have gone unavailable in Plex). The file path is the ground truth of
  // "same physical file"; the group keeps the FIRST leaf's part id for the
  // ledger key.
  interface PartGroup {
    file: string;
    partId: number;
    partSize?: number;
    mediaCount: number;
    partCount: number;
    partIndex: number;
    firstLeafRatingKey: string;
    episodes: EpisodeRef[];
  }
  const groups = new Map<string, PartGroup>();

  for (const leaf of leafDetails) {
    const ep: EpisodeRef = {
      ratingKey: leaf.ratingKey,
      season: leaf.parentIndex ?? -1,
      episode: leaf.index ?? -1,
      title: leaf.title,
      airDate: leaf.originallyAvailableAt,
    };
    const mediaCount = leaf.Media?.length ?? 0;
    for (const media of leaf.Media ?? []) {
      const partCount = media.Part?.length ?? 0;
      (media.Part ?? []).forEach((part, partIndex) => {
        if (!part.file) {
          onNoFile();
          return;
        }
        const groupKey = pathKey(part.file);
        const existing = groups.get(groupKey);
        if (existing) {
          existing.episodes.push(ep);
          existing.mediaCount = Math.max(existing.mediaCount, mediaCount);
        } else {
          groups.set(groupKey, {
            file: part.file,
            partId: part.id,
            partSize: part.size,
            mediaCount,
            partCount,
            partIndex,
            firstLeafRatingKey: leaf.ratingKey,
            episodes: [ep],
          });
        }
      });
    }
  }

  for (const g of groups.values()) {
    const eps = [...g.episodes].sort((a, b) => a.season - b.season || a.episode - b.episode);
    const label = eps
      .map((e) => (e.season >= 0 && e.episode >= 0 ? `s${String(e.season).padStart(2, '0')}e${String(e.episode).padStart(2, '0')}` : '?'))
      .join('+');
    out.push({
      name: `${show.title} — ${label}`,
      kind: 'episode',
      file: g.file,
      partId: g.partId,
      partSize: g.partSize,
      mediaCount: g.mediaCount,
      partCount: g.partCount,
      partIndex: g.partIndex,
      rootPath: rootFor(g.file, roots),
      show: showRef,
      episodes: eps,
    });
  }
}

/**
 * Root-stage input keys (T094/T485) — a LIVE Plex library walk via the shared
 * `walkLibraryParts`, never a read-back of this job's own prior ledger rows.
 */
export async function discoverInputKeys(opts: PlexFetchOverrides = {}): Promise<string[]> {
  const { entries } = await walkLibraryParts(opts);
  return entries.map((e) => fileKey(kindRatingKey(e), e.partId));
}

/** The ledger's rating-key half: a movie's own key, or the FIRST leaf's key for an episode file. */
export function kindRatingKey(e: DiscoverDetail): string {
  if (e.kind === 'movie') return e.movie?.ratingKey ?? 'unknown';
  return e.episodes?.[0]?.ratingKey ?? 'unknown';
}

/**
 * Walk the whole library LIVE and record one ledger row per physical file —
 * RE-MARKED (upserted) every run, deliberately unlike plex-language-fix's
 * once-ever discover: these rows are SNAPSHOTS, and re-recording a renamed
 * file's refreshed Part.file is exactly how the pipeline converges to
 * `already-canonical` after a successful rename + Plex rescan. Read-only.
 */
export async function runDiscover(ctx: JobContext, opts: PlexFetchOverrides = {}): Promise<void> {
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('plex-rename-discover starting — read-only LIVE library walk (never cached), snapshots re-marked every run.');
  ctx.log(`Configured sections: movie=${plexRenameConfig.movieSection}, tv=${plexRenameConfig.tvSection}`);
  ctx.progress(5, 'fetching library sections');

  const { entries, roots, skippedNoFile } = await walkLibraryParts(opts, {
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
    onItemProgress(_section, i, total) {
      if (i % 50 === 0) ctx.log(`  [${i}/${total}] walked…`);
    },
    onSectionDone(section, sectionIndex, totalSections) {
      ctx.progress(10 + Math.round((80 * sectionIndex) / Math.max(totalSections, 1)), `walked ${section.title}`);
    },
  });

  ctx.log(`Library roots (from Plex section Locations): ${roots.map((r) => `${r.path} [${r.kind}]`).join(' · ') || 'NONE — every item will be unmapped-root'}`);

  // Narrate multi-episode groupings — these files carry SEVERAL episodes and
  // get range names (sNNeNN-eMM), so name each one explicitly.
  const multiEpisode = entries.filter((e) => (e.episodes?.length ?? 0) > 1);
  ctx.log(`Multi-episode files (one physical file, several episodes — grouped by file path): ${multiEpisode.length}`);
  for (const e of multiEpisode) {
    ctx.log(`  ⧉ "${e.name}" — ${e.episodes!.length} episode(s) share ${e.file}`);
  }

  let recorded = 0;
  let outsideLimit = 0;
  let newFiles = 0;
  let movedFiles = 0;
  for (const entry of entries) {
    const key = fileKey(kindRatingKey(entry), entry.partId);
    if (!ctx.rootAllowed(key)) {
      outsideLimit++;
      continue;
    }
    // Narrate CHANGES against the previous snapshot: a brand-new file (never
    // seen before) and a file whose recorded path moved since last run (the
    // convergence signal after an applied rename + Plex rescan) are the two
    // genuinely interesting events in a re-marked snapshot ledger.
    const prior = getWorkItem(JOB_NAME, key);
    if (!prior) {
      newFiles++;
      ctx.log(`  ＋ NEW file: "${entry.name}" at ${entry.file} (${entry.partSize ?? '?'} bytes)`);
    } else {
      try {
        const priorFile = (JSON.parse(prior.detail ?? '{}') as { file?: string }).file;
        if (priorFile && priorFile !== entry.file) {
          movedFiles++;
          ctx.log(`  ⇢ PATH CHANGED: "${entry.name}"`);
          ctx.log(`      was: ${priorFile}`);
          ctx.log(`      now: ${entry.file}`);
        }
      } catch { /* unparseable prior detail — treat as unchanged */ }
    }
    markWorkItem(JOB_NAME, key, 'success', { detail: entry });
    recorded++;
  }

  // Snapshot semantics done right: keys the walk no longer produces are
  // GHOSTS (a file re-grouped, deleted, or re-keyed by Plex) — prune them so
  // downstream stages never re-plan a row that no longer describes reality.
  // Only on UNLIMITED runs: a limited run re-marks just its selected roots.
  if (ctx.selectedRoots() === null) {
    const seen = entries.map((e) => fileKey(kindRatingKey(e), e.partId));
    const pruned = pruneSnapshotRows(JOB_NAME, seen);
    if (pruned > 0) ctx.log(`Pruned ${pruned} stale snapshot row(s) whose keys the live walk no longer produces.`);
  }

  ctx.log('═══════════════ DISCOVER SUMMARY ═══════════════');
  ctx.log(`File snapshot(s) recorded: ${recorded} · outside run limit: ${outsideLimit} · skipped (part with no file path): ${skippedNoFile}`);
  ctx.log(`Never seen before: ${newFiles} · path changed since last snapshot: ${movedFiles} · multi-episode files: ${multiEpisode.length}`);
  ctx.log(`Sections walked: movie=${plexRenameConfig.movieSection}, tv=${plexRenameConfig.tvSection} · library roots: ${roots.length}`);
  ctx.log('══════════════════════════════════════════════');
  ctx.progress(100, `${recorded} file snapshot(s) recorded`);
}
