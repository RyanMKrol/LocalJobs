import { callService } from '../../../core/services.js';
import { isWorkItemDone, markWorkItem, workItemCounts } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { dynamoPut } from '../../../services/dynamodb.service.js';
import { listensConfig } from '../config.js';
import type {
  LastFmTrack,
  LastFmRecentTracksResponse,
  SpotifyTokenResponse,
  SpotifySearchResponse,
  ListenItem,
} from '../types.js';

const JOB_NAME = 'lastfm-sync';
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// trackId key — stable identity for a (artist, track) pair, used as the
// DynamoDB partition key AND the composite work_items key prefix.
// ---------------------------------------------------------------------------

export function makeTrackId(artist: string, track: string): string {
  return `${artist.toLowerCase().trim()}::${track.toLowerCase().trim()}`;
}

/** Composite work_items key for a single scrobble: unique per (track, time). */
export function makeScrobbleKey(trackId: string, scrobbledAt: number): string {
  return `${trackId}::${scrobbledAt}`;
}

// ---------------------------------------------------------------------------
// Last.fm fetcher
// ---------------------------------------------------------------------------

export type LastFmFetcher = (page: number) => Promise<LastFmRecentTracksResponse>;

export function makeLastFmFetcher(apiKey: string, username: string, fromTs: number): LastFmFetcher {
  return async (page: number) => {
    const params = new URLSearchParams({
      method: 'user.getRecentTracks',
      user: username,
      api_key: apiKey,
      format: 'json',
      limit: String(listensConfig.lastFmPageSize),
      from: String(fromTs),
      page: String(page),
    });
    const url = `${listensConfig.lastFmApiBase}/?${params}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Last.fm API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<LastFmRecentTracksResponse>;
  };
}

// ---------------------------------------------------------------------------
// Spotify enrichment (Client Credentials — public metadata)
// ---------------------------------------------------------------------------

export interface SpotifyClient {
  /** Search for a track and return album art URL + track id (or empty strings). */
  enrich(artist: string, track: string): Promise<{ albumArt: string; trackId: string }>;
}

export type SpotifyTokenFetcher = () => Promise<SpotifyTokenResponse>;
export type SpotifySearcher = (
  query: string,
  token: string,
) => Promise<SpotifySearchResponse>;

export function makeSpotifyClient(
  clientId: string,
  clientSecret: string,
  fetchToken?: SpotifyTokenFetcher,
  search?: SpotifySearcher,
): SpotifyClient {
  let cachedToken: string | null = null;
  let tokenExpiry = 0;

  const doFetchToken: SpotifyTokenFetcher = fetchToken ?? (async () => {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(`${listensConfig.spotifyAuthBase}/api/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      throw new Error(`Spotify auth error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<SpotifyTokenResponse>;
  });

  const doSearch: SpotifySearcher = search ?? (async (query, token) => {
    const params = new URLSearchParams({ q: query, type: 'track', limit: '1' });
    const res = await fetch(`${listensConfig.spotifyApiBase}/search?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Spotify search error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<SpotifySearchResponse>;
  });

  async function getToken(): Promise<string> {
    const now = Date.now();
    if (cachedToken && now < tokenExpiry) return cachedToken;
    const data = await doFetchToken();
    cachedToken = data.access_token;
    tokenExpiry = now + (data.expires_in - 60) * 1000;
    return cachedToken;
  }

  return {
    async enrich(artist: string, track: string) {
      try {
        const token = await getToken();
        const query = `track:${track} artist:${artist}`;
        const data = await doSearch(query, token);
        const hit = data.tracks?.items?.[0];
        if (!hit) return { albumArt: '', trackId: '' };
        const img = hit.album.images[0]?.url ?? '';
        return { albumArt: img, trackId: hit.id };
      } catch {
        return { albumArt: '', trackId: '' };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Normalise a Last.fm track into a ListenItem
// ---------------------------------------------------------------------------

export function normaliseTrack(
  track: LastFmTrack,
  spotifyAlbumArt = '',
  spotifyTrackId = '',
): ListenItem {
  const scrobbledAt = Number(track.date?.uts ?? 0);
  const artistName = track.artist['#text'] ?? '';
  const trackName = track.name ?? '';
  const albumName = track.album['#text'] ?? '';
  const trackId = makeTrackId(artistName, trackName);

  // Pick the largest Last.fm image (extralarge → large → medium → small).
  const sizePriority = ['extralarge', 'large', 'medium', 'small'];
  let albumArt = '';
  for (const size of sizePriority) {
    const img = track.image?.find((i) => i.size === size);
    if (img?.['#text']) {
      albumArt = img['#text'];
      break;
    }
  }

  return {
    trackId,
    scrobbledAt,
    trackName,
    artistName,
    albumName,
    mbid: track.mbid ?? '',
    albumArt,
    spotifyAlbumArt,
    spotifyTrackId,
    scrobbledAtIso: new Date(scrobbledAt * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// DynamoDB writer (injectable)
// ---------------------------------------------------------------------------

export type DynamoPutter = (table: string, item: Record<string, unknown>) => Promise<void>;

// ---------------------------------------------------------------------------
// Core sync logic
// ---------------------------------------------------------------------------

export async function runListensSync(
  ctx: JobContext,
  opts: {
    fetchPage?: LastFmFetcher;
    spotify?: SpotifyClient | null;
    putItem?: DynamoPutter;
    listensTable?: string;
    nowSeconds?: number;
  } = {},
): Promise<void> {
  const apiKey = process.env.LAST_FM_API_KEY ?? '';
  const username = process.env.LAST_FM_USERNAME ?? '';
  if (!apiKey) throw new Error('LAST_FM_API_KEY is not set');
  if (!username) throw new Error('LAST_FM_USERNAME is not set');

  const listensTable = opts.listensTable ?? process.env.LISTENS_TABLE ?? 'Listens';
  const nowSeconds = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const fromTs = nowSeconds - listensConfig.lookbackSeconds;

  const fetchPage = opts.fetchPage ?? makeLastFmFetcher(apiKey, username, fromTs);
  const putItem =
    opts.putItem ??
    ((table: string, item: Record<string, unknown>) =>
      callService('dynamodb', () => dynamoPut(table, item)));

  // Spotify is optional — only initialise if both creds are present.
  const spotify =
    opts.spotify !== undefined
      ? opts.spotify
      : (() => {
          const id = process.env.SPOTIFY_CLIENT_ID ?? '';
          const secret = process.env.SPOTIFY_CLIENT_SECRET ?? '';
          if (!id || !secret) {
            ctx.log('warn: SPOTIFY_CLIENT_ID/SECRET not set — skipping album art enrichment');
            return null;
          }
          return makeSpotifyClient(id, secret);
        })();

  ctx.log(
    `info: listens-sync starting — user: ${username}, table: ${listensTable}, lookback: ${listensConfig.lookbackSeconds}s from ${fromTs}`,
  );

  // Paginate Last.fm recenttracks
  ctx.log('info: paginating Last.fm recenttracks…');
  const allTracks: LastFmTrack[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const data = await callService('lastfm', () => fetchPage(page));
    const attr = data.recenttracks['@attr'];
    totalPages = Number(attr.totalPages);
    const tracks = data.recenttracks.track;

    // Filter out the currently-playing track (no date).
    const scrobbled = tracks.filter((t) => !t['@attr']?.nowplaying);
    allTracks.push(...scrobbled);
    ctx.log(
      `info: fetched page ${page}/${totalPages} — ${scrobbled.length} scrobbles (${tracks.length - scrobbled.length} now-playing filtered)`,
    );
    page++;
  } while (page <= totalPages);

  ctx.log(`info: discovered ${allTracks.length} scrobble(s) in the lookback window`);

  if (allTracks.length === 0) {
    ctx.log('info: nothing to sync — done');
    ctx.progress(100, 'no scrobbles in window');
    return;
  }

  // Deduplicate by scrobble key before checking the ledger.
  const seen = new Set<string>();
  const deduped = allTracks.filter((t) => {
    const scrobbledAt = Number(t.date?.uts ?? 0);
    if (!scrobbledAt) return false; // skip tracks with no timestamp
    const key = makeScrobbleKey(makeTrackId(t.artist['#text'], t.name), scrobbledAt);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  ctx.log(`info: ${deduped.length} unique scrobble(s) after dedup (${allTracks.length - deduped.length} dupes dropped)`);

  const counts = workItemCounts(JOB_NAME);
  ctx.log(
    `info: ledger: ${counts['success'] ?? 0} already synced, ${counts['failed'] ?? 0} failed previously`,
  );

  const todo = deduped.filter((t) => {
    const scrobbledAt = Number(t.date!.uts);
    const key = makeScrobbleKey(makeTrackId(t.artist['#text'], t.name), scrobbledAt);
    return !isWorkItemDone(JOB_NAME, key, MAX_RETRIES);
  });
  ctx.log(
    `info: ${todo.length} scrobble(s) to sync this run (${deduped.length - todo.length} already done)`,
  );

  if (todo.length === 0) {
    ctx.log('info: all scrobbles in window already synced — done');
    ctx.progress(100, 'all scrobbles already synced');
    return;
  }

  let done = 0;
  let failed = 0;

  for (const track of todo) {
    const scrobbledAt = Number(track.date!.uts);
    const trackId = makeTrackId(track.artist['#text'], track.name);
    const scrobbleKey = makeScrobbleKey(trackId, scrobbledAt);

    ctx.log(
      `info: syncing "${track.name}" by ${track.artist['#text']} @ ${new Date(scrobbledAt * 1000).toISOString()}`,
    );

    try {
      // Enrich with Spotify if available.
      let spotifyAlbumArt = '';
      let spotifyTrackId = '';
      if (spotify) {
        const enriched = await callService('spotify', () =>
          spotify.enrich(track.artist['#text'], track.name),
        );
        spotifyAlbumArt = enriched.albumArt;
        spotifyTrackId = enriched.trackId;
        if (spotifyTrackId) {
          ctx.log(`info: spotify enrichment: trackId=${spotifyTrackId}`);
        }
      }

      const item = normaliseTrack(track, spotifyAlbumArt, spotifyTrackId);
      await putItem(listensTable, item as unknown as Record<string, unknown>);

      markWorkItem(JOB_NAME, scrobbleKey, 'success');
      done++;
      ctx.log(`info: synced ${done}/${todo.length} — ${scrobbleKey}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`error: failed to sync scrobble ${scrobbleKey}: ${msg}`);
      markWorkItem(JOB_NAME, scrobbleKey, 'failed');
      failed++;
    }
    ctx.progress(((done + failed) / todo.length) * 100, `${done}/${todo.length} synced`);
  }

  ctx.log(
    `info: listens-sync complete — synced ${done}, failed ${failed} out of ${todo.length} new scrobbles`,
  );

  if (failed > 0) {
    throw new Error(`${failed} scrobble(s) failed to sync — see logs above`);
  }
}
