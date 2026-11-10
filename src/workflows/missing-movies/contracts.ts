// The data the missing-movies stages hand to each other.
//
//   plex-movie-snapshot ──snapshot──▶ franchise-gaps ──gaps──▶ movie-gaps-notify ──▶ report, digest
import { fileArtifact, fromChecks, inlineArtifact, jsonArtifact } from '../../engine/index.js';
import type { FranchiseGapsFile, MovieSnapshotFile } from '../movies/types.js';

/** This workflow's own Plex movie library snapshot. */
export const plexMovieSnapshot = jsonArtifact<MovieSnapshotFile>({
  key: 'plex-movie-snapshot',
  description: 'The Plex movie library as of this run: every movie with its TMDB id.',
  shape: {
    summary: 'The fresh Plex movie snapshot: each movie with its TMDB id.',
    format: 'JSON object { generatedAt, section, movies[] }',
    expectations: [
      { label: 'Contains the movies array', detail: 'It has a `movies` array.' },
      { label: 'At least one movie carries a tmdbId', detail: 'At least one movie matched a tmdb:// GUID. A Plex shape change that drops GUIDs is caught here.' },
    ],
  },
  check(v) {
    const movies = Array.isArray(v?.movies) ? v.movies : null;
    if (!movies) return fromChecks([{ label: 'Contains the movies array', ok: false, actual: 'no movies array' }]);
    const withTmdb = movies.filter((m) => typeof m.tmdbId === 'number').length;
    return fromChecks([
      { label: 'Contains the movies array', ok: true, actual: `${movies.length} movie(s)` },
      { label: 'At least one movie carries a tmdbId', ok: movies.length === 0 || withTmdb > 0, actual: `${withTmdb}/${movies.length} with tmdbId` },
    ], `${movies.length} movie(s), ${withTmdb} with a TMDB id`);
  },
  summary: (v) => `${v.movies.length} movie(s), ${v.movies.filter((m) => typeof m.tmdbId === 'number').length} with a TMDB id`,
  items: (v) => v.movies.map((m) => ({
    id: String(m.tmdbId ?? m.ratingKey),
    title: `${m.title}${m.year ? ` (${m.year})` : ''}`,
    fields: m.tmdbId != null ? [{ label: 'TMDB', value: String(m.tmdbId) }] : [],
  })),
});

/** Every released franchise film the owner does not have. */
export const franchiseGaps = jsonArtifact<FranchiseGapsFile>({
  key: 'franchise-gaps',
  description: 'Every released film missing from a collection the owner has part of. May be empty when nothing is missing.',
  shape: {
    summary: 'The deterministic franchise-gap detection: released franchise films the owner does not own.',
    format: 'JSON object { generatedAt, collectionsChecked, gaps[] }',
    expectations: [
      { label: 'Contains the gaps array', detail: 'It has a `gaps` array (may be empty when nothing is missing).' },
      { label: 'Each gap carries a collection name and tmdbId', detail: 'Every gap carries a collectionName and a numeric tmdbId.' },
    ],
  },
  check(v) {
    const gaps = Array.isArray(v?.gaps) ? v.gaps : null;
    if (!gaps) return fromChecks([{ label: 'Contains the gaps array', ok: false, actual: 'no gaps array' }]);
    const bad = gaps.find((g) => !g.collectionName || typeof g.tmdbId !== 'number');
    return fromChecks([
      { label: 'Contains the gaps array', ok: true, actual: `${gaps.length} gap(s)` },
      { label: 'Each gap carries a collection name and tmdbId', ok: !bad, actual: bad ? 'a gap is missing collectionName/tmdbId' : 'all gaps well-formed' },
    ], `${gaps.length} gap(s)`);
  },
  summary: (v) => `${v.gaps.length} gap(s) across ${v.collectionsChecked} collection(s) checked`,
  items: (v) => v.gaps.map((g) => ({
    id: String(g.tmdbId),
    title: `${g.title}${g.year ? ` (${g.year})` : ''}`,
    subtitle: g.collectionName,
    fields: g.tmdbRating != null ? [{ label: 'TMDB', value: g.tmdbRating.toFixed(1) }] : [],
  })),
});

/** The markdown report of the current gaps, rewritten every run. */
export const gapsReport = fileArtifact({
  key: 'franchise-gaps-report',
  description: 'The markdown report of the current franchise gaps, grouped by collection.',
  format: 'markdown',
  check: (f) => fromChecks([{ label: 'the report has content', ok: f.bytes > 0, actual: `${f.bytes} bytes` }]),
});

/** What one notify run did. */
export interface GapsDigest {
  /** Gaps announced by this run (first seen now). */
  announced: number;
  alreadyAnnounced: number;
  ignored: number;
  titles: string[];
}

export const gapsDigest = inlineArtifact<GapsDigest>({
  key: 'franchise-gaps-digest',
  description: 'What this run announced: how many gaps were new, and how many were already announced or dismissed.',
  check: (v) => fromChecks([{ label: 'has counts', ok: typeof v?.announced === 'number', actual: `${v?.announced} announced` }]),
  summary: (v) => `${v.announced} announced, ${v.alreadyAnnounced} already announced, ${v.ignored} dismissed`,
});
