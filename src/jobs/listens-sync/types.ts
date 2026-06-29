// Last.fm API response shapes

export interface LastFmTrack {
  mbid: string;
  name: string;
  url: string;
  artist: { mbid: string; '#text': string };
  album: { mbid: string; '#text': string };
  image: { '#text': string; size: string }[];
  date?: { uts: string; '#text': string };
  /** Present on the currently-playing track (no date). */
  '@attr'?: { nowplaying?: string };
}

export interface LastFmRecentTracksResponse {
  recenttracks: {
    track: LastFmTrack[];
    '@attr': {
      user: string;
      page: string;
      perPage: string;
      totalPages: string;
      total: string;
    };
  };
}

// Spotify API shapes (Client Credentials — public metadata only)

export interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface SpotifySearchResponse {
  tracks: {
    items: {
      id: string;
      name: string;
      artists: { id: string; name: string }[];
      album: {
        id: string;
        name: string;
        images: { url: string; width: number; height: number }[];
      };
    }[];
  };
}

// The normalised item written to DynamoDB
export interface ListenItem {
  /** PK: stable identifier for the track — "{artist}::{track}" lowercased. */
  trackId: string;
  /** SK: Unix epoch seconds of the scrobble. */
  scrobbledAt: number;
  trackName: string;
  artistName: string;
  albumName: string;
  /** Last.fm MusicBrainz track id (may be empty string). */
  mbid: string;
  /** Last.fm album art URL (largest image available, or empty). */
  albumArt: string;
  /** Spotify album art URL (larger, from Spotify search; may be empty). */
  spotifyAlbumArt: string;
  /** Spotify track id (may be empty). */
  spotifyTrackId: string;
  /** ISO-8601 date string for human readability. */
  scrobbledAtIso: string;
}
