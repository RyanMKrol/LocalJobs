// Pure Plex-parsing/markdown-building helpers (no I/O) — unit-tested in lib.test.ts.
import type { PlexGuid, PlexMovieDetail, PlexShowDetail, PlexTag } from './types.js';

/** Sum every `Media[].Part[].size` on one item — a movie or an episode. Copied
 *  from `plex-space-saver/lib.ts` per the repo's small-per-workflow-helper
 *  convention rather than a new cross-workflow import. */
export function itemBytes(item: { Media?: { Part?: { size?: number }[] }[] }): number {
  let total = 0;
  for (const media of item.Media ?? []) {
    for (const part of media.Part ?? []) {
      if (typeof part.size === 'number') total += part.size;
    }
  }
  return total;
}

/** Format a byte count as a human-readable size (binary units, matching Plex's
 *  own GB display). Copied from `plex-space-saver/lib.ts`. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

/** Flatten a Plex tag array (`[{tag:'Action'}]`) into `['Action']`, dropping blanks. */
export function tags(arr: PlexTag[] | undefined): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((t) => (t?.tag ?? '').trim()).filter(Boolean);
}

/**
 * Extract the tmdb/imdb/tvdb ids from a detail fetch's `Guid[]` — generalizes
 * the single-purpose `extractTmdbId` in `missing-tv-seasons/plex.ts` /
 * `movies/movies.ts` / `tv-recs/tv-shows.ts` to pull all three id families.
 */
export function extractGuidIds(guids: PlexGuid[] | undefined): {
  tmdbId: number | null;
  imdbId: string | null;
  tvdbId: string | null;
} {
  let tmdbId: number | null = null;
  let imdbId: string | null = null;
  let tvdbId: string | null = null;
  if (Array.isArray(guids)) {
    for (const g of guids) {
      const id = g?.id ?? '';
      const tmdbMatch = /^tmdb:\/\/(\d+)/.exec(id);
      if (tmdbMatch && tmdbId === null) tmdbId = Number(tmdbMatch[1]);
      const imdbMatch = /^imdb:\/\/(tt\d+)/.exec(id);
      if (imdbMatch && imdbId === null) imdbId = imdbMatch[1];
      const tvdbMatch = /^tvdb:\/\/(\d+)/.exec(id);
      if (tvdbMatch && tvdbId === null) tvdbId = tvdbMatch[1];
    }
  }
  return { tmdbId, imdbId, tvdbId };
}

/** Build the output markdown filename stem from Plex's own `slug` field (no
 *  re-derivation from the title — Plex already returns one on both movies and
 *  shows), e.g. "37974-the-430-movie-2024". */
export function slugFileName(ratingKey: string | number | undefined, slug: string | undefined): string {
  const key = String(ratingKey ?? '0');
  const s = (slug ?? '').trim();
  return s ? `${key}-${s}` : key;
}

/** Humanize a duration in milliseconds, e.g. "1h 58m". */
function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return 'unknown';
  const totalMinutes = Math.round(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h <= 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Convert a Plex unix-epoch-seconds timestamp to an ISO date string, or '' if absent. */
function isoFromEpochSeconds(epochSeconds: number | undefined): string {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return '';
  return new Date(epochSeconds * 1000).toISOString();
}

function yamlList(values: string[]): string {
  if (values.length === 0) return '[]';
  return `[${values.map((v) => JSON.stringify(v)).join(', ')}]`;
}

function ratingLines(ratings: { image?: string; value?: number; type?: string }[] | undefined): string[] {
  if (!Array.isArray(ratings) || ratings.length === 0) return ['- (no per-source ratings recorded)'];
  return ratings.map((r) => `- ${r.type ?? 'unknown'}: ${typeof r.value === 'number' ? r.value : 'unknown'} (${r.image ?? 'unknown source'})`);
}

/**
 * Build a movie's markdown profile. Deterministic, no LLM — a fixed template
 * (frontmatter keys + `##` section names stay stable across every profile so
 * the corpus stays scannable/queryable; prose within a section is free-form).
 */
export function buildMovieProfileMarkdown(meta: PlexMovieDetail): string {
  const { tmdbId, imdbId, tvdbId } = extractGuidIds(meta.Guid);
  const genres = tags(meta.Genre);
  const countries = tags(meta.Country);
  const directors = tags(meta.Director);
  const writers = tags(meta.Writer);
  const cast = tags(meta.Role).slice(0, 10);
  const media = meta.Media?.[0];
  const part = media?.Part?.[0];

  const frontmatter = [
    '---',
    'type: movie',
    `rating_key: ${JSON.stringify(String(meta.ratingKey ?? ''))}`,
    `title: ${JSON.stringify(meta.title ?? '')}`,
    `year: ${typeof meta.year === 'number' ? meta.year : 'null'}`,
    ...(tmdbId !== null ? [`tmdb_id: ${tmdbId}`] : []),
    ...(imdbId !== null ? [`imdb_id: ${JSON.stringify(imdbId)}`] : []),
    ...(tvdbId !== null ? [`tvdb_id: ${JSON.stringify(tvdbId)}`] : []),
    `content_rating: ${JSON.stringify(meta.contentRating ?? '')}`,
    `genres: ${yamlList(genres)}`,
    `countries: ${yamlList(countries)}`,
    `studio: ${JSON.stringify(meta.studio ?? '')}`,
    `added_at: ${JSON.stringify(isoFromEpochSeconds(meta.addedAt))}`,
    `updated_at: ${JSON.stringify(isoFromEpochSeconds(meta.updatedAt))}`,
    '---',
  ].join('\n');

  const summaryLines = [
    ...(meta.tagline ? [`*${meta.tagline}*`, ''] : []),
    meta.summary || '(no summary available)',
  ];

  const castCrewLines = [
    `- Director(s): ${directors.length > 0 ? directors.join(', ') : 'unknown'}`,
    `- Writer(s): ${writers.length > 0 ? writers.join(', ') : 'unknown'}`,
    `- Cast: ${cast.length > 0 ? cast.join(', ') : 'unknown'}`,
  ];

  const ratingsLines = [
    `- Audience rating: ${typeof meta.audienceRating === 'number' ? meta.audienceRating : 'unknown'}`,
    `- Critic rating: ${typeof meta.rating === 'number' ? meta.rating : 'unknown'}`,
    '- Per-source:',
    ...ratingLines(meta.Rating).map((l) => `  ${l}`),
  ];

  const technicalLines = [
    `- Duration: ${formatDuration(meta.duration)}`,
    `- Resolution: ${media?.videoResolution ?? 'unknown'}`,
    `- Video codec: ${media?.videoCodec ?? 'unknown'}`,
    `- Container: ${media?.container ?? 'unknown'}`,
    `- File size: ${formatBytes(part?.size ?? 0)}`,
  ];

  const sourceLines = [
    `- Plex rating key: ${meta.ratingKey ?? 'unknown'}`,
    `- Library section: movie`,
    `- File path: ${part?.file ?? 'unknown'}`,
  ];

  return [
    frontmatter,
    '',
    '## Summary',
    '',
    ...summaryLines,
    '',
    '## Cast & Crew',
    '',
    ...castCrewLines,
    '',
    '## Ratings',
    '',
    ...ratingsLines,
    '',
    '## Technical',
    '',
    ...technicalLines,
    '',
    '## Source',
    '',
    ...sourceLines,
    '',
  ].join('\n');
}

/**
 * Build a TV show's markdown profile. `totalBytes` is the sum of every
 * episode's media parts (a show has no `Media`/size of its own — it's
 * computed by the caller from the flat episode list, mirroring
 * `plex-space-saver`'s `buildShowRows`).
 */
export function buildShowProfileMarkdown(meta: PlexShowDetail, totalBytes: number): string {
  const { tmdbId, imdbId, tvdbId } = extractGuidIds(meta.Guid);
  const genres = tags(meta.Genre);
  const countries = tags(meta.Country);
  const cast = tags(meta.Role).slice(0, 10);

  const frontmatter = [
    '---',
    'type: show',
    `rating_key: ${JSON.stringify(String(meta.ratingKey ?? ''))}`,
    `title: ${JSON.stringify(meta.title ?? '')}`,
    ...(meta.originalTitle && meta.originalTitle !== meta.title
      ? [`original_title: ${JSON.stringify(meta.originalTitle)}`]
      : []),
    `year: ${typeof meta.year === 'number' ? meta.year : 'null'}`,
    ...(tmdbId !== null ? [`tmdb_id: ${tmdbId}`] : []),
    ...(imdbId !== null ? [`imdb_id: ${JSON.stringify(imdbId)}`] : []),
    ...(tvdbId !== null ? [`tvdb_id: ${JSON.stringify(tvdbId)}`] : []),
    `content_rating: ${JSON.stringify(meta.contentRating ?? '')}`,
    `genres: ${yamlList(genres)}`,
    `countries: ${yamlList(countries)}`,
    `studio: ${JSON.stringify(meta.studio ?? '')}`,
    `added_at: ${JSON.stringify(isoFromEpochSeconds(meta.addedAt))}`,
    `updated_at: ${JSON.stringify(isoFromEpochSeconds(meta.updatedAt))}`,
    '---',
  ].join('\n');

  const summaryLines = [meta.summary || '(no summary available)'];

  const castCrewLines = [
    `- Cast: ${cast.length > 0 ? cast.join(', ') : 'unknown'}`,
  ];

  const ratingsLines = [
    `- Audience rating: ${typeof meta.audienceRating === 'number' ? meta.audienceRating : 'unknown'}`,
    '- Per-source:',
    ...ratingLines(meta.Rating).map((l) => `  ${l}`),
  ];

  const technicalLines = [
    `- Seasons: ${typeof meta.childCount === 'number' ? meta.childCount : 'unknown'}`,
    `- Episodes: ${typeof meta.leafCount === 'number' ? meta.leafCount : 'unknown'}`,
    `- Total library size: ${formatBytes(totalBytes)}`,
  ];

  const sourceLines = [
    `- Plex rating key: ${meta.ratingKey ?? 'unknown'}`,
    `- Library section: show`,
  ];

  return [
    frontmatter,
    '',
    '## Summary',
    '',
    ...summaryLines,
    '',
    '## Cast & Crew',
    '',
    ...castCrewLines,
    '',
    '## Ratings',
    '',
    ...ratingsLines,
    '',
    '## Technical',
    '',
    ...technicalLines,
    '',
    '## Source',
    '',
    ...sourceLines,
    '',
  ].join('\n');
}
