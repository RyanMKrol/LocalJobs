import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { plexGet } from '../../../core/plex-client.js';
import { callService } from '../../../core/services.js';
import { getWorkItem, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { plexProfilesConfig } from '../config.js';
import { buildMovieProfileMarkdown, buildShowProfileMarkdown, itemBytes, slugFileName } from '../lib.js';
import type { PlexEpisodeMeta, PlexListItem, PlexMovieDetail, PlexShowDetail } from '../types.js';

export const JOB_NAME = 'plex-profiles-build';

interface PlexAllResponse<T> {
  MediaContainer?: { Metadata?: T[] };
}

interface PlexMetadataResponse<T> {
  MediaContainer?: { Metadata?: T[] };
}

interface WorkItemDetail {
  name?: string;
  markdown?: string;
  updatedAt?: number;
}

export function movieKey(ratingKey: string | number | undefined): string {
  return `movie:${ratingKey ?? ''}`;
}

export function showKey(ratingKey: string | number | undefined): string {
  return `show:${ratingKey ?? ''}`;
}

/**
 * Fetch every current movie + show key — the job's `inputKeys()` (T094): the
 * candidate roots for a manual run-limit. Re-fetches the two list endpoints
 * fresh (cheap, no detail fetch) rather than caching, since a stale key list
 * would misrepresent what the library currently contains.
 */
export async function resolveInputKeys(): Promise<string[]> {
  const { movieSection, tvSection } = plexProfilesConfig;
  const moviesResp = await callService('plex', () => plexGet<PlexAllResponse<PlexListItem>>(`/library/sections/${movieSection}/all`));
  const movies = moviesResp?.MediaContainer?.Metadata ?? [];
  const showsResp = await callService('plex', () => plexGet<PlexAllResponse<PlexListItem>>(`/library/sections/${tvSection}/all`));
  const shows = showsResp?.MediaContainer?.Metadata ?? [];
  return [
    ...movies.map((m) => movieKey(m.ratingKey)),
    ...shows.map((s) => showKey(s.ratingKey)),
  ];
}

function readStoredUpdatedAt(itemKey: string): number | undefined {
  const row = getWorkItem(JOB_NAME, itemKey);
  if (!row?.detail) return undefined;
  try {
    return (JSON.parse(row.detail) as WorkItemDetail).updatedAt;
  } catch {
    return undefined;
  }
}

function ensureDirs(): void {
  mkdirSync(plexProfilesConfig.moviesOutDir, { recursive: true });
  mkdirSync(plexProfilesConfig.showsOutDir, { recursive: true });
}

/**
 * Single-stage build: scan the Plex movie + TV library sections via the API
 * (list endpoints, cheap), fetch full per-title detail ONLY for titles that are
 * new or whose `updatedAt` moved since the last build, and write one markdown
 * profile per title to `data/out/movies/` / `data/out/shows/`. Idempotent via
 * the `work_items` ledger's `detail.updatedAt` marker — mirrors
 * `projects-sync/project-summarize.ts`'s `pushedAt`-marker idiom. This is a
 * BUILD (like places/perfumes/projects-sync), not a re-scan-fresh audit like
 * plex-space-saver/missing-tv-seasons.
 *
 * No LLM call anywhere in this stage — purely Plex API data (phase 2, an
 * optional Claude-narrated layer, is a deliberately separate future task; see
 * this workflow's CLAUDE.md).
 */
export async function runBuild(ctx: JobContext): Promise<void> {
  ensureDirs();
  const { movieSection, tvSection, runLimit } = plexProfilesConfig;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`plex-profiles-build starting — movie section ${movieSection}, TV section ${tvSection}, run limit ${runLimit || 'unlimited'}`);

  ctx.progress(5, 'fetching movies');
  const moviesResp = await callService('plex', () => plexGet<PlexAllResponse<PlexListItem>>(`/library/sections/${movieSection}/all`));
  const movies = moviesResp?.MediaContainer?.Metadata ?? [];
  ctx.log(`Fetched ${movies.length} movie(s) from section ${movieSection}.`);

  ctx.progress(15, 'fetching shows');
  const showsResp = await callService('plex', () => plexGet<PlexAllResponse<PlexListItem>>(`/library/sections/${tvSection}/all`));
  const shows = showsResp?.MediaContainer?.Metadata ?? [];
  ctx.log(`Fetched ${shows.length} show(s) from section ${tvSection}.`);

  ctx.progress(25, 'fetching episodes for show byte totals');
  const epsResp = await callService('plex', () => plexGet<PlexAllResponse<PlexEpisodeMeta>>(`/library/sections/${tvSection}/all?type=4`));
  const episodes = epsResp?.MediaContainer?.Metadata ?? [];
  ctx.log(`Fetched ${episodes.length} episode(s) (flat read, type=4) for show byte totals.`);

  const showBytes = new Map<string, number>();
  for (const ep of episodes) {
    const key = String(ep.grandparentRatingKey ?? '');
    if (!key) continue;
    showBytes.set(key, (showBytes.get(key) ?? 0) + itemBytes(ep));
  }

  interface Candidate {
    key: string;
    kind: 'movie' | 'show';
    ratingKey: string | number | undefined;
    updatedAt: number | undefined;
  }

  const candidates: Candidate[] = [
    ...movies.map((m): Candidate => ({ key: movieKey(m.ratingKey), kind: 'movie', ratingKey: m.ratingKey, updatedAt: m.updatedAt })),
    ...shows.map((s): Candidate => ({ key: showKey(s.ratingKey), kind: 'show', ratingKey: s.ratingKey, updatedAt: s.updatedAt })),
  ];

  const allowed = candidates.filter((c) => ctx.rootAllowed(c.key));
  ctx.log(`${allowed.length}/${candidates.length} title(s) allowed after root-selection filtering.`);

  // Decide which need (re)building — new key, or updatedAt has moved.
  const needsBuild: Candidate[] = [];
  let skippedUnchanged = 0;
  for (const c of allowed) {
    const stored = readStoredUpdatedAt(c.key);
    if (stored !== undefined && stored === c.updatedAt) {
      skippedUnchanged++;
      ctx.log(`Skipping ${c.key} — unchanged since last build (updatedAt ${c.updatedAt}).`);
      continue;
    }
    needsBuild.push(c);
  }

  const cap = runLimit > 0 ? runLimit : Infinity;
  const todo = needsBuild.slice(0, Math.min(needsBuild.length, cap));
  if (needsBuild.length > todo.length) {
    ctx.log(`Reached per-run limit of ${runLimit} — building ${todo.length} of ${needsBuild.length} outstanding; next run continues.`);
  }

  ctx.log(`Plan: ${todo.length} to (re)build, ${skippedUnchanged} skipped (unchanged), out of ${allowed.length} allowed.`);

  let built = 0;
  let failed = 0;
  const total = todo.length;

  for (let i = 0; i < todo.length; i++) {
    const c = todo[i];
    try {
      ctx.log(`Building ${c.key} (${i + 1}/${total}) — fetching detail for ratingKey ${c.ratingKey}...`);
      const detailResp = await callService('plex', () => plexGet<PlexMetadataResponse<PlexMovieDetail | PlexShowDetail>>(
        `/library/metadata/${c.ratingKey}`,
      ));
      const detail = detailResp?.MediaContainer?.Metadata?.[0];
      if (!detail) {
        throw new Error(`no detail metadata returned for ratingKey ${c.ratingKey}`);
      }

      let md: string;
      let outPath: string;
      let name: string;
      if (c.kind === 'movie') {
        const movieDetail = detail as PlexMovieDetail;
        md = buildMovieProfileMarkdown(movieDetail);
        outPath = resolve(plexProfilesConfig.moviesOutDir, `${slugFileName(movieDetail.ratingKey, movieDetail.slug)}.md`);
        name = movieDetail.title ?? String(c.ratingKey);
      } else {
        const showDetail = detail as PlexShowDetail;
        const totalBytes = showBytes.get(String(showDetail.ratingKey ?? '')) ?? 0;
        md = buildShowProfileMarkdown(showDetail, totalBytes);
        outPath = resolve(plexProfilesConfig.showsOutDir, `${slugFileName(showDetail.ratingKey, showDetail.slug)}.md`);
        name = showDetail.title ?? String(c.ratingKey);
      }

      writeFileSync(outPath, md);
      ctx.log(`Wrote ${outPath}`);

      markWorkItem(JOB_NAME, c.key, 'success', {
        detail: { name, markdown: outPath, updatedAt: c.updatedAt },
      });
      built++;
    } catch (e) {
      ctx.log(`error: failed to build profile for ${c.key}: ${String(e)}`, 'error');
      markWorkItem(JOB_NAME, c.key, 'failed', { detail: { name: c.key } });
      failed++;
    }

    ctx.progress(25 + ((i + 1) / Math.max(total, 1)) * 70, `${i + 1}/${total} processed`);
  }

  ctx.log(
    `plex-profiles-build complete — ${built} built, ${skippedUnchanged} skipped (unchanged), ${failed} failed, ` +
      `out of ${allowed.length} allowed title(s). Output: ${plexProfilesConfig.moviesOutDir} / ${plexProfilesConfig.showsOutDir}`,
  );

  ctx.progress(100, `${built} built, ${skippedUnchanged} skipped, ${failed} failed`);

  if (failed > 0) {
    throw new Error(`${failed}/${todo.length} title(s) failed to build this run — see logs above`);
  }
}
