// Last.fm API response shapes for the aggregated top-albums / top-tracks
// endpoints (period-based, NOT per-scrobble).

export interface LastFmImage {
  '#text': string;
  size: string;
}

export interface LastFmTopAlbum {
  name: string;
  playcount: string;
  artist: { name: string; mbid?: string; url?: string };
  url: string;
  image: LastFmImage[];
  '@attr'?: { rank: string };
}

export interface LastFmTopAlbumsResponse {
  topalbums: {
    album?: LastFmTopAlbum[] | LastFmTopAlbum;
    '@attr'?: {
      user: string;
      period: string;
      page: string;
      perPage: string;
      totalPages: string;
      total: string;
    };
  };
}

export interface LastFmTopTrack {
  name: string;
  playcount: string;
  artist: { name: string; mbid?: string; url?: string };
  album?: { '#text': string; mbid?: string };
  url: string;
  '@attr'?: { rank: string };
}

export interface LastFmTopTracksResponse {
  toptracks: {
    track?: LastFmTopTrack[] | LastFmTopTrack;
    '@attr'?: {
      user: string;
      period: string;
      page: string;
      perPage: string;
      totalPages: string;
      total: string;
    };
  };
}
