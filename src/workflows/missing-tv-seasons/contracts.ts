// The data the missing-tv-seasons stages hand to each other.
//
//   plex-tv-snapshot ──snapshot──▶ tmdb-season-check ──missing──▶ plex-seasons-notify ──▶ report, digest
import { fileArtifact, fromChecks, inlineArtifact, jsonArtifact } from '../../engine/index.js';
import type { MissingSeasonsFile, SnapshotFile } from './types.js';

/** The Plex TV library as of this run. */
export const plexTvSnapshot = jsonArtifact<SnapshotFile>({
  key: 'plex-tv-snapshot',
  description: 'The Plex TV library as of this run: every show with its TMDB id and the highest season owned.',
  shape: {
    summary: 'The fresh Plex TV snapshot: each show with its TMDB id and highest owned season.',
    format: 'JSON object { generatedAt, section, shows[] }',
    expectations: [
      { label: 'Contains the shows array', detail: 'It has a `shows` array.' },
      { label: 'At least one show carries a tmdbId', detail: 'At least one show matched a tmdb:// GUID. A Plex shape change that drops GUIDs is caught here.' },
    ],
  },
  check(v) {
    const shows = Array.isArray(v?.shows) ? v.shows : null;
    if (!shows) return fromChecks([{ label: 'Contains the shows array', ok: false, actual: 'no shows array' }]);
    const withTmdb = shows.filter((s) => typeof s.tmdbId === 'number').length;
    return fromChecks([
      { label: 'Contains the shows array', ok: true, actual: `${shows.length} show(s)` },
      { label: 'At least one show carries a tmdbId', ok: shows.length === 0 || withTmdb > 0, actual: `${withTmdb}/${shows.length} with tmdbId` },
    ], `${shows.length} show(s), ${withTmdb} with a TMDB id`);
  },
  summary: (v) => `${v.shows.length} show(s), ${v.shows.filter((s) => typeof s.tmdbId === 'number').length} with a TMDB id`,
  items: (v) => v.shows.map((s) => ({
    id: String(s.tmdbId ?? s.ratingKey),
    title: `${s.title}${s.year ? ` (${s.year})` : ''}`,
    fields: [{ label: 'Owned up to', value: `S${s.highestOwnedSeason}` }, ...(s.tmdbId != null ? [{ label: 'TMDB', value: String(s.tmdbId) }] : [])],
  })),
});

/** The shows with a complete season the owner does not have, plus what could not be checked. */
export const missingSeasons = jsonArtifact<MissingSeasonsFile>({
  key: 'tmdb-missing-seasons',
  description: 'Shows with at least one complete season the owner is missing, plus the shows that could not be checked.',
  shape: {
    summary: 'The TMDB completeness check: shows with complete seasons the owner does not own.',
    format: 'JSON object { generatedAt, shows[], unverifiable[], errors[] }',
    expectations: [
      { label: 'Contains the shows array', detail: 'It has a `shows` array (may be empty when nothing is missing).' },
      { label: 'Every listed show has a missing season', detail: 'Every listed show carries a non-empty completeMissingSeasons array.' },
    ],
  },
  check(v) {
    const shows = Array.isArray(v?.shows) ? v.shows : null;
    if (!shows) return fromChecks([{ label: 'Contains the shows array', ok: false, actual: 'no shows array' }]);
    const bad = shows.find((s) => !Array.isArray(s.completeMissingSeasons) || s.completeMissingSeasons.length === 0);
    return fromChecks([
      { label: 'Contains the shows array', ok: true, actual: `${shows.length} actionable show(s)` },
      { label: 'Every listed show has a missing season', ok: !bad, actual: bad ? `"${bad.title}" lists no missing season` : 'all shows well-formed' },
    ], `${shows.length} actionable show(s)`);
  },
  summary: (v) =>
    `${v.shows.length} show(s) with a complete missing season` +
    (v.unverifiable?.length ? `, ${v.unverifiable.length} unverifiable` : '') +
    (v.errors?.length ? `, ${v.errors.length} errored` : ''),
  // Actionable shows first, then what could not be checked (shown as failed).
  items: (v) => [
    ...v.shows.map((s) => ({
      id: String(s.tmdbId),
      title: `${s.title}${s.year ? ` (${s.year})` : ''}`,
      fields: [
        { label: 'Missing', value: s.completeMissingSeasons.map((n) => `S${n}`).join(', ') },
        { label: 'Owned up to', value: `S${s.highestOwnedSeason}` },
        { label: 'Status', value: s.tmdbStatus },
      ],
    })),
    ...(v.errors ?? []).map((e) => ({ id: `error:${e.tmdbId}`, title: e.title, status: 'failed', fields: [{ label: 'Error', value: e.error.slice(0, 160) }] })),
    ...(v.unverifiable ?? []).map((u) => ({ id: `unverifiable:${u.ratingKey}`, title: u.title, status: 'failed', fields: [{ label: 'Reason', value: 'no tmdb:// GUID' }] })),
  ],
});

/** The markdown report of the current backlog, rewritten every run. */
export const seasonsReport = fileArtifact({
  key: 'missing-seasons-report',
  description: 'The markdown report of every complete season currently missing, marking the newly found ones.',
  format: 'markdown',
  check: (f) => fromChecks([{ label: 'the report has content', ok: f.bytes > 0, actual: `${f.bytes} bytes` }]),
});

/** What one notify run did. */
export interface SeasonsDigest {
  /** (show, season) pairs announced by this run. */
  announced: number;
  alreadyAnnounced: number;
  titles: string[];
}

export const seasonsDigest = inlineArtifact<SeasonsDigest>({
  key: 'missing-seasons-digest',
  description: 'What this run announced: how many missing seasons were new, and how many had been announced before.',
  check: (v) => fromChecks([{ label: 'has counts', ok: typeof v?.announced === 'number', actual: `${v?.announced} announced` }]),
  summary: (v) => `${v.announced} announced, ${v.alreadyAnnounced} already announced`,
});
