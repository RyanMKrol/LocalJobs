import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

export const listensConfig = {
  dataDir: resolve(here, 'data'),
  /** Last.fm API base URL */
  lastFmApiBase: 'https://ws.audioscrobbler.com/2.0',
  /** Spotify API base URLs */
  spotifyAuthBase: 'https://accounts.spotify.com',
  spotifyApiBase: 'https://api.spotify.com/v1',
  /** How many tracks to fetch per Last.fm page (max 200). */
  lastFmPageSize: 200,
  /** How far back to look on each run (seconds). Run every 4h, look back 5h
   *  for a comfortable overlap window that never misses a scrobble. */
  lookbackSeconds: 5 * 60 * 60,
};
