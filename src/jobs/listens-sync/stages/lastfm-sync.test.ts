// lastfm-sync tests — hermetic: no live Last.fm/Spotify calls, no live AWS writes.
// Uses stub fetchers + stub putter + the scratch DB (npm test sets LOCALJOBS_DB).
// Covers: new scrobbles are synced; already-done scrobbles are skipped; now-playing
// tracks are filtered out; Spotify art is attached when token succeeds; missing
// required env vars throw; DynamoDB failures are handled gracefully.
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import {
  runLastfmSync,
  makeTrackId,
  makeScrobbleKey,
  type LastfmTrack,
  type LastfmRecentTracksResponse,
  type DynamoPutter,
  type SpotifyTokenFetcher,
  type SpotifyArtFetcher,
} from './lastfm-sync.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

let seqCounter = 0;
function uid(): string {
  return `test-track-${Date.now()}-${++seqCounter}`;
}

/** Build an epoch timestamp (unique per test via seqCounter). */
function uts(): number {
  return 1_700_000_000 + seqCounter * 60;
}

function makeTrack(
  name: string,
  artist: string,
  utsVal?: number,
  nowPlaying = false,
): LastfmTrack {
  const t: LastfmTrack = {
    name,
    artist: { '#text': artist },
    album: { '#text': `${artist} Album` },
    mbid: '',
    url: `https://www.last.fm/music/${artist}/_/${name}`,
    image: [{ '#text': 'https://example.com/art.jpg', size: 'large' }],
  };
  if (!nowPlaying && utsVal !== undefined) {
    t.date = { uts: String(utsVal), '#text': new Date(utsVal * 1000).toISOString() };
  }
  if (nowPlaying) {
    t['@attr'] = { nowplaying: 'true' };
  }
  return t;
}

function singlePageResponse(tracks: LastfmTrack[]): LastfmRecentTracksResponse {
  return {
    recenttracks: {
      track: tracks,
      '@attr': { user: 'testuser', page: '1', perPage: '200', totalPages: '1', total: String(tracks.length) },
    },
  };
}

function makeFetchPage(tracks: LastfmTrack[]) {
  return async (_page: number, _limit: number): Promise<LastfmRecentTracksResponse> =>
    singlePageResponse(tracks);
}

function makePutSpy() {
  const calls: { table: string; item: Record<string, unknown> }[] = [];
  const put: DynamoPutter = async (table, item) => {
    calls.push({ table, item });
  };
  return { put, calls };
}

const JOB = 'lastfm-sync';

// ---------------------------------------------------------------------------
// Unit tests: makeTrackId / makeScrobbleKey
// ---------------------------------------------------------------------------

describe('makeTrackId', () => {
  it('lowercases and trims artist + track', () => {
    assert.equal(makeTrackId('  Radiohead ', '  Creep  '), 'radiohead::creep');
  });

  it('produces the same id regardless of case', () => {
    assert.equal(makeTrackId('Radiohead', 'Creep'), makeTrackId('radiohead', 'creep'));
  });
});

describe('makeScrobbleKey', () => {
  it('concatenates trackId and scrobbledAt', () => {
    assert.equal(makeScrobbleKey('radiohead::creep', 1700000000), 'radiohead::creep::1700000000');
  });
});

// ---------------------------------------------------------------------------
// runLastfmSync — integration-style (scratch DB, stub I/O)
// ---------------------------------------------------------------------------

describe('runLastfmSync — core sync behaviour', () => {
  beforeEach(() => {
    process.env.LAST_FM_API_KEY = 'test-key';
    process.env.LAST_FM_USERNAME = 'testuser';
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
  });

  it('throws if LAST_FM_API_KEY is missing', async () => {
    const saved = process.env.LAST_FM_API_KEY;
    delete process.env.LAST_FM_API_KEY;
    try {
      await assert.rejects(
        () => runLastfmSync(fakeCtx(), { fetchPage: makeFetchPage([]) }),
        /LAST_FM_API_KEY/,
      );
    } finally {
      if (saved !== undefined) process.env.LAST_FM_API_KEY = saved;
    }
  });

  it('throws if LAST_FM_USERNAME is missing', async () => {
    const saved = process.env.LAST_FM_USERNAME;
    delete process.env.LAST_FM_USERNAME;
    try {
      await assert.rejects(
        () => runLastfmSync(fakeCtx(), { fetchPage: makeFetchPage([]) }),
        /LAST_FM_USERNAME/,
      );
    } finally {
      if (saved !== undefined) process.env.LAST_FM_USERNAME = saved;
    }
  });

  it('no-ops gracefully when Last.fm returns empty list', async () => {
    const { put, calls } = makePutSpy();
    await runLastfmSync(fakeCtx(), {
      fetchPage: makeFetchPage([]),
      putItem: put,
      listensTable: 'Listens',
    });
    assert.equal(calls.length, 0);
  });

  it('filters out now-playing tracks (no date)', async () => {
    const nowPlayingTrack = makeTrack(uid(), 'Artist', undefined, true);
    const { put, calls } = makePutSpy();
    await runLastfmSync(fakeCtx(), {
      fetchPage: makeFetchPage([nowPlayingTrack]),
      putItem: put,
      listensTable: 'Listens',
    });
    assert.equal(calls.length, 0, 'now-playing track should not be written');
  });

  it('syncs a new scrobble and marks it done in ledger', async () => {
    const name = uid();
    const artist = 'TestArtist';
    const ts = uts();
    const track = makeTrack(name, artist, ts);
    const { put, calls } = makePutSpy();

    await runLastfmSync(fakeCtx(), {
      fetchPage: makeFetchPage([track]),
      putItem: put,
      listensTable: 'Listens',
    });

    assert.equal(calls.length, 1, 'one DynamoDB put per scrobble');
    const item = calls[0].item as Record<string, unknown>;
    const trackId = makeTrackId(artist, name);
    assert.equal(item['trackId'], trackId);
    assert.equal(item['scrobbledAt'], ts);
    assert.equal(item['track'], name);
    assert.equal(item['artist'], artist);
    assert.equal(calls[0].table, 'Listens');

    const key = makeScrobbleKey(trackId, ts);
    assert.ok(isWorkItemDone(JOB, key, 3), 'ledger should mark scrobble done');
  });

  it('skips a scrobble already marked success in the ledger', async () => {
    const name = uid();
    const artist = 'SkipArtist';
    const ts = uts();
    const trackId = makeTrackId(artist, name);
    const key = makeScrobbleKey(trackId, ts);
    markWorkItem(JOB, key, 'success');

    const { put, calls } = makePutSpy();
    await runLastfmSync(fakeCtx(), {
      fetchPage: makeFetchPage([makeTrack(name, artist, ts)]),
      putItem: put,
      listensTable: 'Listens',
    });

    assert.equal(calls.length, 0, 'already-synced scrobble should not be re-written');
  });

  it('syncs only NEW scrobbles when some already done', async () => {
    const existingName = uid();
    const existingTs = uts();
    const newName = uid();
    const newTs = uts();
    const artist = 'MixedArtist';

    const existingKey = makeScrobbleKey(makeTrackId(artist, existingName), existingTs);
    markWorkItem(JOB, existingKey, 'success');

    const { put, calls } = makePutSpy();
    await runLastfmSync(fakeCtx(), {
      fetchPage: makeFetchPage([
        makeTrack(existingName, artist, existingTs),
        makeTrack(newName, artist, newTs),
      ]),
      putItem: put,
      listensTable: 'Listens',
    });

    assert.equal(calls.length, 1, 'only new scrobble written');
    assert.equal(calls[0].item['track'], newName);
  });

  it('marks scrobble failed in ledger when putter throws, then throws at end', async () => {
    const name = uid();
    const artist = 'FailArtist';
    const ts = uts();
    const trackId = makeTrackId(artist, name);
    const key = makeScrobbleKey(trackId, ts);

    const failingPut: DynamoPutter = async () => {
      throw new Error('DynamoDB unavailable');
    };

    await assert.rejects(
      () =>
        runLastfmSync(fakeCtx(), {
          fetchPage: makeFetchPage([makeTrack(name, artist, ts)]),
          putItem: failingPut,
          listensTable: 'Listens',
        }),
      /failed to sync/,
    );

    assert.ok(!isWorkItemDone(JOB, key, 3), 'failed scrobble should not be marked done');
  });
});

// ---------------------------------------------------------------------------
// Spotify enrichment
// ---------------------------------------------------------------------------

describe('runLastfmSync — Spotify album-art enrichment', () => {
  beforeEach(() => {
    process.env.LAST_FM_API_KEY = 'test-key';
    process.env.LAST_FM_USERNAME = 'testuser';
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
  });

  it('attaches albumArtUrl when Spotify token + art fetch succeed', async () => {
    const name = uid();
    const artist = 'SpotifyArtist';
    const ts = uts();
    const track = makeTrack(name, artist, ts);
    const { put, calls } = makePutSpy();

    const tokenFetcher: SpotifyTokenFetcher = async () => 'fake-token';
    const artFetcher: SpotifyArtFetcher = async (_token, _artist, _track) =>
      'https://i.scdn.co/image/fake-art.jpg';

    await runLastfmSync(fakeCtx(), {
      fetchPage: makeFetchPage([track]),
      putItem: put,
      listensTable: 'Listens',
      fetchSpotifyToken: tokenFetcher,
      fetchAlbumArt: artFetcher,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].item['albumArtUrl'], 'https://i.scdn.co/image/fake-art.jpg');
  });

  it('omits albumArtUrl when Spotify token fetch fails (graceful degradation)', async () => {
    const name = uid();
    const artist = 'NoSpotifyArtist';
    const ts = uts();
    const track = makeTrack(name, artist, ts);
    const { put, calls } = makePutSpy();

    const failingToken: SpotifyTokenFetcher = async () => {
      throw new Error('token error');
    };
    const artFetcher: SpotifyArtFetcher = async () => 'https://art.jpg';

    // Should not throw — Spotify failure is non-fatal.
    await runLastfmSync(fakeCtx(), {
      fetchPage: makeFetchPage([track]),
      putItem: put,
      listensTable: 'Listens',
      fetchSpotifyToken: failingToken,
      fetchAlbumArt: artFetcher,
    });

    assert.equal(calls.length, 1, 'scrobble still written despite Spotify failure');
    assert.ok(!('albumArtUrl' in calls[0].item), 'albumArtUrl should be absent');
  });

  it('omits albumArtUrl when art fetch returns undefined', async () => {
    const name = uid();
    const artist = 'NoArtArtist';
    const ts = uts();
    const track = makeTrack(name, artist, ts);
    const { put, calls } = makePutSpy();

    const tokenFetcher: SpotifyTokenFetcher = async () => 'fake-token';
    const artFetcher: SpotifyArtFetcher = async () => undefined;

    await runLastfmSync(fakeCtx(), {
      fetchPage: makeFetchPage([track]),
      putItem: put,
      listensTable: 'Listens',
      fetchSpotifyToken: tokenFetcher,
      fetchAlbumArt: artFetcher,
    });

    assert.equal(calls.length, 1);
    assert.ok(!('albumArtUrl' in calls[0].item), 'albumArtUrl should be absent when art not found');
  });

  it('skips enrichment when no fetchers provided (Spotify disabled)', async () => {
    const name = uid();
    const artist = 'NoEnrichArtist';
    const ts = uts();
    const track = makeTrack(name, artist, ts);
    const { put, calls } = makePutSpy();

    // No fetchSpotifyToken / fetchAlbumArt — simulates SPOTIFY_CLIENT_ID unset.
    await runLastfmSync(fakeCtx(), {
      fetchPage: makeFetchPage([track]),
      putItem: put,
      listensTable: 'Listens',
    });

    assert.equal(calls.length, 1);
    assert.ok(!('albumArtUrl' in calls[0].item));
  });
});

// ---------------------------------------------------------------------------
// DynamoDB item shape
// ---------------------------------------------------------------------------

describe('runLastfmSync — DynamoDB item shape', () => {
  beforeEach(() => {
    process.env.LAST_FM_API_KEY = 'test-key';
    process.env.LAST_FM_USERNAME = 'testuser';
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
  });

  it('item has all required fields: trackId (S), scrobbledAt (N), track, artist, album, trackUrl', async () => {
    const name = uid();
    const artist = 'ShapeTestArtist';
    const ts = uts();
    const { put, calls } = makePutSpy();

    await runLastfmSync(fakeCtx(), {
      fetchPage: makeFetchPage([makeTrack(name, artist, ts)]),
      putItem: put,
      listensTable: 'Listens',
    });

    const item = calls[0].item;
    assert.ok(typeof item['trackId'] === 'string', 'trackId must be a string (PK S)');
    assert.ok(typeof item['scrobbledAt'] === 'number', 'scrobbledAt must be a number (SK N)');
    assert.ok(typeof item['track'] === 'string');
    assert.ok(typeof item['artist'] === 'string');
    assert.ok(typeof item['album'] === 'string');
    assert.ok(typeof item['trackUrl'] === 'string');
  });
});
