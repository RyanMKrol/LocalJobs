import { callService } from '../../../core/services.js';
import { isWorkItemDone, markWorkItem, workItemCounts } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { dynamoPut } from '../../../services/dynamodb.service.js';

const JOB_NAME = 'lastfm-sync';
const MAX_RETRIES = 3;
const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_SEARCH_URL = 'https://api.spotify.com/v1/search';

// ---------------------------------------------------------------------------
// Types — Last.fm API shapes
// ---------------------------------------------------------------------------

export interface LastfmTrack {
  name: string;
  artist: { '#text': string; mbid?: string };
  album: { '#text': string; mbid?: string };
  mbid?: string;
  url: string;
  /** Absent when the track is "now playing" — skip those. */
  date?: { uts: string; '#text': string };
  image?: Array<{ '#text': string; size: string }>;
  '@attr'?: { nowplaying?: string };
}

export interface LastfmRecentTracksResponse {
  recenttracks: {
    track: LastfmTrack | LastfmTrack[];
    '@attr': {
      user: string;
      page: string;
      perPage: string;
      totalPages: string;
      total: string;
    };
  };
}

// DynamoDB item written to the listens table.
export interface ListenItem extends Record<string, unknown> {
  trackId: string;      // PK (S) — stable identity: "artist::trackName" (lowercased)
  scrobbledAt: number;  // SK (N) — epoch seconds
  track: string;
  artist: string;
  album: string;
  trackUrl: string;
  albumArtUrl?: string; // Spotify large album art (optional enrichment)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a stable, human-readable track identity from artist + track name. */
export function makeTrackId(artist: string, track: string): string {
  return `${artist.trim().toLowerCase()}::${track.trim().toLowerCase()}`;
}

/** Build the ledger key that uniquely identifies one scrobble. */
export function makeScrobbleKey(trackId: string, scrobbledAt: number): string {
  return `${trackId}::${scrobbledAt}`;
}

// ---------------------------------------------------------------------------
// Injectable fetchers (real = globalThis.fetch; tests inject stubs)
// ---------------------------------------------------------------------------

export type LastfmFetcher = (page: number, pageLimit: number) => Promise<LastfmRecentTracksResponse>;
export type SpotifyTokenFetcher = () => Promise<string>;
export type SpotifyArtFetcher = (token: string, artist: string, track: string) => Promise<string | undefined>;
export type DynamoPutter = (table: string, item: Record<string, unknown>) => Promise<void>;

export function makeLastfmFetcher(apiKey: string, username: string): LastfmFetcher {
  return async (page: number, pageLimit: number): Promise<LastfmRecentTracksResponse> => {
    const url = new URL(LASTFM_API);
    url.searchParams.set('method', 'user.getRecentTracks');
    url.searchParams.set('user', username);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', String(pageLimit));
    url.searchParams.set('page', String(page));
    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Last.fm API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<LastfmRecentTracksResponse>;
  };
}

export function makeSpotifyTokenFetcher(clientId: string, clientSecret: string): SpotifyTokenFetcher {
  return async (): Promise<string> => {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      throw new Error(`Spotify token error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  };
}

export function makeSpotifyArtFetcher(): SpotifyArtFetcher {
  return async (token: string, artist: string, track: string): Promise<string | undefined> => {
    const q = `track:${encodeURIComponent(track)} artist:${encodeURIComponent(artist)}`;
    const url = `${SPOTIFY_SEARCH_URL}?q=${q}&type=track&limit=1`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      tracks?: { items?: Array<{ album?: { images?: Array<{ url: string; width: number }> } }> };
    };
    const images = data.tracks?.items?.[0]?.album?.images;
    if (!images || images.length === 0) return undefined;
    // Return the largest image (sorted by width descending).
    const sorted = [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    return sorted[0]?.url;
  };
}

// ---------------------------------------------------------------------------
// Core sync logic
// ---------------------------------------------------------------------------

export async function runLastfmSync(
  ctx: JobContext,
  opts: {
    fetchPage?: LastfmFetcher;
    fetchSpotifyToken?: SpotifyTokenFetcher;
    fetchAlbumArt?: SpotifyArtFetcher;
    putItem?: DynamoPutter;
    listensTable?: string;
    maxPages?: number;
    pageLimit?: number;
  } = {},
): Promise<void> {
  const apiKey = process.env.LAST_FM_API_KEY ?? '';
  if (!apiKey) throw new Error('LAST_FM_API_KEY is not set');

  const username = process.env.LAST_FM_USERNAME ?? '';
  if (!username) throw new Error('LAST_FM_USERNAME is not set');

  const listensTable = opts.listensTable ?? process.env.LISTENS_TABLE ?? 'Listens';
  const maxPages = opts.maxPages ?? Number(process.env.LASTFM_MAX_PAGES ?? 2);
  const pageLimit = opts.pageLimit ?? 200;

  const fetchPage = opts.fetchPage ?? makeLastfmFetcher(apiKey, username);
  const putItem = opts.putItem ?? ((t, i) => callService('dynamodb', () => dynamoPut(t, i)));

  // Spotify enrichment is optional — skip if creds unset.
  const spotifyId = process.env.SPOTIFY_CLIENT_ID ?? '';
  const spotifySecret = process.env.SPOTIFY_CLIENT_SECRET ?? '';
  const hasSpotify = Boolean(spotifyId && spotifySecret);
  const fetchSpotifyToken = opts.fetchSpotifyToken ?? (hasSpotify ? makeSpotifyTokenFetcher(spotifyId, spotifySecret) : undefined);
  const fetchAlbumArt = opts.fetchAlbumArt ?? (hasSpotify ? makeSpotifyArtFetcher() : undefined);

  ctx.log(`info: listens-sync starting — user: ${username}, table: ${listensTable}, spotify: ${hasSpotify ? 'enabled' : 'disabled'}`);

  // ---------------------------------------------------------------------------
  // 1. Fetch recent scrobbles from Last.fm (up to maxPages pages, newest first)
  // ---------------------------------------------------------------------------
  ctx.log(`info: fetching up to ${maxPages} page(s) × ${pageLimit} tracks from Last.fm…`);
  const allTracks: LastfmTrack[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await callService('lastfm', () => fetchPage(page, pageLimit));
    const raw = data.recenttracks.track;
    const tracks = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const totalPages = Number(data.recenttracks['@attr'].totalPages);
    ctx.log(`info: fetched page ${page}/${Math.min(maxPages, totalPages)} — ${tracks.length} tracks`);
    allTracks.push(...tracks);
    if (page >= totalPages) break; // no more pages available
  }

  // Filter out "now playing" tracks (no date).
  const scrobbles = allTracks.filter((t) => t.date?.uts && !t['@attr']?.nowplaying);
  ctx.log(`info: discovered ${allTracks.length} tracks total; ${scrobbles.length} completed scrobbles (${allTracks.length - scrobbles.length} now-playing/filtered)`);

  // ---------------------------------------------------------------------------
  // 2. Skip already-synced scrobbles via the work_items ledger
  // ---------------------------------------------------------------------------
  const counts = workItemCounts(JOB_NAME);
  ctx.log(`info: ledger — ${counts['success'] ?? 0} already synced, ${counts['failed'] ?? 0} previously failed`);

  const todo = scrobbles.filter((t) => {
    const trackId = makeTrackId(t.artist['#text'], t.name);
    const scrobbledAt = Number(t.date!.uts);
    const key = makeScrobbleKey(trackId, scrobbledAt);
    return !isWorkItemDone(JOB_NAME, key, MAX_RETRIES);
  });
  ctx.log(`info: ${todo.length} new scrobbles to sync (${scrobbles.length - todo.length} skipped — already done)`);

  if (todo.length === 0) {
    ctx.log('info: nothing new to sync — done');
    ctx.progress(100, 'all scrobbles already synced');
    return;
  }

  // ---------------------------------------------------------------------------
  // 3. Optionally fetch a Spotify access token once (reused across all tracks)
  // ---------------------------------------------------------------------------
  let spotifyToken: string | undefined;
  if (fetchSpotifyToken) {
    try {
      spotifyToken = await callService('spotify', () => fetchSpotifyToken());
      ctx.log('info: obtained Spotify access token for album-art enrichment');
    } catch (err) {
      ctx.log(`warn: failed to get Spotify token — skipping album art (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Write each new scrobble to DynamoDB
  // ---------------------------------------------------------------------------
  let done = 0;
  let failed = 0;

  for (const track of todo) {
    const trackId = makeTrackId(track.artist['#text'], track.name);
    const scrobbledAt = Number(track.date!.uts);
    const key = makeScrobbleKey(trackId, scrobbledAt);

    ctx.log(`info: syncing "${track.name}" by "${track.artist['#text']}" at ${new Date(scrobbledAt * 1000).toISOString()}`);

    try {
      // Optional Spotify album art enrichment.
      let albumArtUrl: string | undefined;
      if (spotifyToken && fetchAlbumArt) {
        try {
          albumArtUrl = await callService('spotify', () =>
            fetchAlbumArt!(spotifyToken!, track.artist['#text'], track.name),
          );
        } catch (err) {
          ctx.log(`warn: Spotify art lookup failed for "${track.name}" — continuing without (${err instanceof Error ? err.message : String(err)})`);
        }
      }

      const item: ListenItem = {
        trackId,
        scrobbledAt,
        track: track.name,
        artist: track.artist['#text'],
        album: track.album['#text'],
        trackUrl: track.url,
        ...(albumArtUrl ? { albumArtUrl } : {}),
      };

      await putItem(listensTable, item);
      markWorkItem(JOB_NAME, key, 'success');
      done++;
      ctx.log(`info: synced ${done}/${todo.length} — "${track.name}" by "${track.artist['#text']}"${albumArtUrl ? ' (with art)' : ''}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`error: failed to sync scrobble ${key}: ${msg}`);
      markWorkItem(JOB_NAME, key, 'failed');
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
