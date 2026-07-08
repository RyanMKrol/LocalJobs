import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';

import { callService } from '../../../core/services.js';
import { markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { listeningDigestConfig } from '../config.js';
import type {
  LastFmTopAlbum,
  LastFmTopAlbumsResponse,
  LastFmTopTrack,
  LastFmTopTracksResponse,
} from '../types.js';

const JOB_NAME = 'lastfm-digest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Last.fm returns a bare object instead of a 1-item array when there's only one hit. */
export function toArray<T>(value: T[] | T | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/** "2026-07" — the ledger key + output filename suffix for this run's month. */
export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** "July 2026" — human-readable heading. */
export function monthLabel(date: Date): string {
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Drop albums where a single track accounts for >= `ratio` of the album's
 * total plays — usually a sign it's really one song on repeat, not an album
 * listened through. Mirrors the ryankrol.co.uk /listening page's heuristic.
 */
export function filterRealAlbums(
  albums: LastFmTopAlbum[],
  tracks: LastFmTopTrack[],
  ratio: number,
): LastFmTopAlbum[] {
  const albumTrackPlays = new Map<string, number>();
  for (const track of tracks) {
    const albumName = track.album?.['#text'];
    if (!albumName) continue;
    const key = `${track.artist.name}::${albumName}`;
    const plays = parseInt(track.playcount, 10) || 0;
    albumTrackPlays.set(key, (albumTrackPlays.get(key) ?? 0) + plays);
  }

  return albums.filter((album) => {
    const key = `${album.artist.name}::${album.name}`;
    const totalTrackPlays = albumTrackPlays.get(key) ?? 0;
    const albumPlays = parseInt(album.playcount, 10) || 0;
    if (totalTrackPlays > 0 && albumPlays > 0) {
      return totalTrackPlays / albumPlays < ratio;
    }
    return true;
  });
}

export function renderDigestMarkdown(opts: {
  username: string;
  monthLabel: string;
  generatedAtIso: string;
  period: string;
  albums: LastFmTopAlbum[];
  tracks: LastFmTopTrack[];
}): string {
  const lines: string[] = [];
  lines.push(`# Listening Digest — ${opts.monthLabel}`);
  lines.push('');
  lines.push(
    `Generated ${opts.generatedAtIso} · Last.fm user \`${opts.username}\` · trailing \`${opts.period}\` period.`,
  );
  lines.push('');
  lines.push('## Top Albums');
  lines.push('');
  if (opts.albums.length === 0) {
    lines.push('_No album plays in this period._');
  } else {
    lines.push('| # | Album | Artist | Plays |');
    lines.push('|---|---|---|---|');
    opts.albums.forEach((album, i) => {
      lines.push(`| ${i + 1} | ${album.name} | ${album.artist.name} | ${album.playcount} |`);
    });
  }
  lines.push('');
  lines.push('## Top Tracks');
  lines.push('');
  if (opts.tracks.length === 0) {
    lines.push('_No track plays in this period._');
  } else {
    lines.push('| # | Track | Artist | Album | Plays |');
    lines.push('|---|---|---|---|---|');
    opts.tracks.forEach((track, i) => {
      lines.push(
        `| ${i + 1} | ${track.name} | ${track.artist.name} | ${track.album?.['#text'] ?? ''} | ${track.playcount} |`,
      );
    });
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Last.fm fetchers (injectable for tests)
// ---------------------------------------------------------------------------

export type TopAlbumsFetcher = (period: string) => Promise<LastFmTopAlbumsResponse>;
export type TopTracksFetcher = (period: string) => Promise<LastFmTopTracksResponse>;

export function makeTopAlbumsFetcher(apiKey: string, username: string): TopAlbumsFetcher {
  return async (period: string) => {
    const params = new URLSearchParams({
      method: 'user.getTopAlbums',
      user: username,
      api_key: apiKey,
      format: 'json',
      period,
      limit: String(listeningDigestConfig.topAlbumsLimit),
    });
    const url = `${listeningDigestConfig.lastFmApiBase}/?${params}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Last.fm API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<LastFmTopAlbumsResponse>;
  };
}

export function makeTopTracksFetcher(apiKey: string, username: string): TopTracksFetcher {
  return async (period: string) => {
    const params = new URLSearchParams({
      method: 'user.getTopTracks',
      user: username,
      api_key: apiKey,
      format: 'json',
      period,
      limit: String(listeningDigestConfig.topTracksLimit),
    });
    const url = `${listeningDigestConfig.lastFmApiBase}/?${params}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Last.fm API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<LastFmTopTracksResponse>;
  };
}

// ---------------------------------------------------------------------------
// Core digest logic
// ---------------------------------------------------------------------------

export async function runListeningDigest(
  ctx: JobContext,
  opts: {
    fetchTopAlbums?: TopAlbumsFetcher;
    fetchTopTracks?: TopTracksFetcher;
    now?: Date;
    outDir?: string;
  } = {},
): Promise<void> {
  const apiKey = process.env.LAST_FM_API_KEY ?? '';
  const username = process.env.LAST_FM_USERNAME ?? '';
  if (!apiKey) throw new Error('LAST_FM_API_KEY is not set');
  if (!username) throw new Error('LAST_FM_USERNAME is not set');

  const now = opts.now ?? new Date();
  const key = monthKey(now);
  const label = monthLabel(now);
  const outDir = opts.outDir ?? resolve(listeningDigestConfig.dataDir, 'out');

  const fetchTopAlbums = opts.fetchTopAlbums ?? makeTopAlbumsFetcher(apiKey, username);
  const fetchTopTracks = opts.fetchTopTracks ?? makeTopTracksFetcher(apiKey, username);

  ctx.log(
    `info: listening-digest starting — user: ${username}, period: ${listeningDigestConfig.period}, month: ${key}`,
  );

  ctx.log('info: fetching top albums from Last.fm…');
  const albumsData = await callService('lastfm', () => fetchTopAlbums(listeningDigestConfig.period));
  const albums = toArray(albumsData.topalbums?.album);
  ctx.log(`info: fetched ${albums.length} top album(s)`);

  ctx.log('info: fetching top tracks from Last.fm…');
  const tracksData = await callService('lastfm', () => fetchTopTracks(listeningDigestConfig.period));
  const tracks = toArray(tracksData.toptracks?.track);
  ctx.log(`info: fetched ${tracks.length} top track(s)`);

  const filteredAlbums = filterRealAlbums(albums, tracks, listeningDigestConfig.singleTrackAlbumRatio);
  ctx.log(
    `info: kept ${filteredAlbums.length}/${albums.length} album(s) after filtering out single-track-dominated ` +
      `albums (a track making up >= ${listeningDigestConfig.singleTrackAlbumRatio * 100}% of the album's plays)`,
  );
  for (const dropped of albums.filter((a) => !filteredAlbums.includes(a))) {
    ctx.log(`info: dropped "${dropped.name}" by ${dropped.artist.name} — single-track-dominated`);
  }

  const markdown = renderDigestMarkdown({
    username,
    monthLabel: label,
    generatedAtIso: now.toISOString(),
    period: listeningDigestConfig.period,
    albums: filteredAlbums,
    tracks,
  });

  mkdirSync(outDir, { recursive: true });
  const mdPath = resolve(outDir, `listening-digest-${key}.md`);
  writeFileSync(mdPath, markdown, 'utf8');
  ctx.log(`info: wrote digest markdown to ${mdPath}`);

  markWorkItem(JOB_NAME, key, 'success', {
    detail: { name: `Listening digest — ${label}`, markdown: mdPath },
  });

  ctx.progress(
    50,
    `digest for ${label} written — starting trailing ${listeningDigestConfig.trailingPeriod} pass`,
  );
  ctx.log(
    `info: 1-month pass complete — ${filteredAlbums.length} album(s), ${tracks.length} track(s) for ${label}`,
  );

  const trailingPeriod = listeningDigestConfig.trailingPeriod;
  const trailingKey = `${key}-3month`;
  const trailingLabel = `${label} (Trailing 3 Months)`;

  ctx.log(
    `info: listening-digest starting trailing pass — user: ${username}, period: ${trailingPeriod}, key: ${trailingKey}`,
  );

  ctx.log('info: fetching trailing top albums from Last.fm…');
  const trailingAlbumsData = await callService('lastfm', () => fetchTopAlbums(trailingPeriod));
  const trailingAlbums = toArray(trailingAlbumsData.topalbums?.album);
  ctx.log(`info: fetched ${trailingAlbums.length} trailing top album(s)`);

  ctx.log('info: fetching trailing top tracks from Last.fm…');
  const trailingTracksData = await callService('lastfm', () => fetchTopTracks(trailingPeriod));
  const trailingTracks = toArray(trailingTracksData.toptracks?.track);
  ctx.log(`info: fetched ${trailingTracks.length} trailing top track(s)`);

  const filteredTrailingAlbums = filterRealAlbums(
    trailingAlbums,
    trailingTracks,
    listeningDigestConfig.singleTrackAlbumRatio,
  );
  ctx.log(
    `info: kept ${filteredTrailingAlbums.length}/${trailingAlbums.length} trailing album(s) after filtering out ` +
      `single-track-dominated albums (a track making up >= ${listeningDigestConfig.singleTrackAlbumRatio * 100}% ` +
      `of the album's plays)`,
  );
  for (const dropped of trailingAlbums.filter((a) => !filteredTrailingAlbums.includes(a))) {
    ctx.log(`info: dropped trailing "${dropped.name}" by ${dropped.artist.name} — single-track-dominated`);
  }

  const trailingMarkdown = renderDigestMarkdown({
    username,
    monthLabel: trailingLabel,
    generatedAtIso: now.toISOString(),
    period: trailingPeriod,
    albums: filteredTrailingAlbums,
    tracks: trailingTracks,
  });

  const trailingMdPath = resolve(outDir, `listening-digest-${key}-3month.md`);
  writeFileSync(trailingMdPath, trailingMarkdown, 'utf8');
  ctx.log(`info: wrote trailing digest markdown to ${trailingMdPath}`);

  markWorkItem(JOB_NAME, trailingKey, 'success', {
    detail: { name: `Listening digest (trailing 3 months) — ${label}`, markdown: trailingMdPath },
  });

  ctx.progress(100, `digest for ${label} (both periods) written`);
  ctx.log(
    `info: listening-digest complete — 1-month: ${filteredAlbums.length} album(s)/${tracks.length} track(s); ` +
      `trailing 3-month: ${filteredTrailingAlbums.length} album(s)/${trailingTracks.length} track(s) for ${label}`,
  );
}
