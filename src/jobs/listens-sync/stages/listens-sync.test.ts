// listens-sync tests — hermetic: no live Last.fm / Spotify API calls, no live AWS writes.
// Uses stub fetchers + stub putter + scratch DB (npm test sets LOCALJOBS_DB).
// Covers: new scrobbles synced + marked done; already-synced skipped; now-playing
// filtered; Spotify enrichment wired; failures handled; missing env vars throw.
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import {
  runListensSync,
  normaliseTrack,
  makeTrackId,
  makeScrobbleKey,
  type LastFmFetcher,
  type DynamoPutter,
  type SpotifyClient,
} from './listens-sync.js';
import type { LastFmRecentTracksResponse, LastFmTrack } from '../types.js';

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

let idCounter = 0;
function uid(): string {
  return `test-track-${Date.now()}-${++idCounter}`;
}

function fakeTrack(
  artist: string,
  name: string,
  uts: string,
  nowPlaying = false,
): LastFmTrack {
  return {
    mbid: '',
    name,
    url: '',
    artist: { mbid: '', '#text': artist },
    album: { mbid: '', '#text': 'Test Album' },
    image: [
      { '#text': 'https://img.last.fm/small.jpg', size: 'small' },
      { '#text': 'https://img.last.fm/large.jpg', size: 'large' },
    ],
    ...(nowPlaying ? { '@attr': { nowplaying: 'true' } } : { date: { uts, '#text': '' } }),
  };
}

function makeFetcher(tracks: LastFmTrack[]): LastFmFetcher {
  return async (_page) => ({
    recenttracks: {
      track: tracks,
      '@attr': { user: 'test', page: '1', perPage: '200', totalPages: '1', total: String(tracks.length) },
    },
  } as LastFmRecentTracksResponse);
}

function makeMultiPageFetcher(pages: LastFmTrack[][]): LastFmFetcher {
  return async (page) => ({
    recenttracks: {
      track: pages[page - 1] ?? [],
      '@attr': {
        user: 'test',
        page: String(page),
        perPage: '200',
        totalPages: String(pages.length),
        total: String(pages.flat().length),
      },
    },
  } as LastFmRecentTracksResponse);
}

function makePutSpy() {
  const calls: { table: string; item: Record<string, unknown> }[] = [];
  const put: DynamoPutter = async (table, item) => {
    calls.push({ table, item });
  };
  return { put, calls };
}

function noSpotify(): SpotifyClient | null {
  return null;
}

function stubSpotify(albumArt = 'https://spotify.com/art.jpg', trackId = 'sp123'): SpotifyClient {
  return {
    async enrich() {
      return { albumArt, trackId };
    },
  };
}

const JOB = 'lastfm-sync';

// ---------------------------------------------------------------------------
// normaliseTrack
// ---------------------------------------------------------------------------

describe('normaliseTrack', () => {
  it('builds a correct ListenItem from a Last.fm track', () => {
    const track = fakeTrack('Radiohead', 'Creep', '1700000000');
    const item = normaliseTrack(track);
    assert.equal(item.trackId, makeTrackId('Radiohead', 'Creep'));
    assert.equal(item.scrobbledAt, 1700000000);
    assert.equal(item.trackName, 'Creep');
    assert.equal(item.artistName, 'Radiohead');
    assert.equal(item.albumName, 'Test Album');
    assert.equal(item.albumArt, 'https://img.last.fm/large.jpg');
    assert.equal(item.spotifyAlbumArt, '');
    assert.equal(item.spotifyTrackId, '');
  });

  it('includes Spotify enrichment when provided', () => {
    const track = fakeTrack('Portishead', 'Glory Box', '1700000001');
    const item = normaliseTrack(track, 'https://sp.art/img.jpg', 'sp456');
    assert.equal(item.spotifyAlbumArt, 'https://sp.art/img.jpg');
    assert.equal(item.spotifyTrackId, 'sp456');
  });

  it('picks largest Last.fm image (extralarge > large)', () => {
    const track = fakeTrack('Blur', 'Song 2', '1700000002');
    track.image = [
      { '#text': 'https://img/small.jpg', size: 'small' },
      { '#text': 'https://img/large.jpg', size: 'large' },
      { '#text': 'https://img/xl.jpg', size: 'extralarge' },
    ];
    const item = normaliseTrack(track);
    assert.equal(item.albumArt, 'https://img/xl.jpg');
  });
});

// ---------------------------------------------------------------------------
// makeTrackId / makeScrobbleKey
// ---------------------------------------------------------------------------

describe('makeTrackId', () => {
  it('lowercases and trims both parts', () => {
    assert.equal(makeTrackId('  Radiohead ', ' Creep '), 'radiohead::creep');
  });

  it('is consistent for same artist+track regardless of case', () => {
    assert.equal(makeTrackId('BLUR', 'Song 2'), makeTrackId('blur', 'song 2'));
  });
});

describe('makeScrobbleKey', () => {
  it('combines trackId and scrobbledAt', () => {
    assert.equal(makeScrobbleKey('blur::song 2', 1700000000), 'blur::song 2::1700000000');
  });
});

// ---------------------------------------------------------------------------
// runListensSync — core behaviour
// ---------------------------------------------------------------------------

describe('runListensSync — environment guards', () => {
  it('throws if LAST_FM_API_KEY missing', async () => {
    const saved = process.env.LAST_FM_API_KEY;
    delete process.env.LAST_FM_API_KEY;
    process.env.LAST_FM_USERNAME = 'testuser';
    try {
      await assert.rejects(
        () => runListensSync(fakeCtx(), { fetchPage: makeFetcher([]), putItem: async () => {}, spotify: noSpotify() }),
        /LAST_FM_API_KEY/,
      );
    } finally {
      if (saved !== undefined) process.env.LAST_FM_API_KEY = saved;
    }
  });

  it('throws if LAST_FM_USERNAME missing', async () => {
    process.env.LAST_FM_API_KEY = 'test-key';
    const savedUser = process.env.LAST_FM_USERNAME;
    delete process.env.LAST_FM_USERNAME;
    try {
      await assert.rejects(
        () => runListensSync(fakeCtx(), { fetchPage: makeFetcher([]), putItem: async () => {}, spotify: noSpotify() }),
        /LAST_FM_USERNAME/,
      );
    } finally {
      if (savedUser !== undefined) process.env.LAST_FM_USERNAME = savedUser;
    }
  });
});

describe('runListensSync — normal behaviour', () => {
  beforeEach(() => {
    process.env.LAST_FM_API_KEY = 'test-key';
    process.env.LAST_FM_USERNAME = 'testuser';
  });

  it('no-ops gracefully when Last.fm returns empty list', async () => {
    const { put, calls } = makePutSpy();
    await runListensSync(fakeCtx(), {
      fetchPage: makeFetcher([]),
      putItem: put,
      spotify: noSpotify(),
      listensTable: 'Listens',
      nowSeconds: 1700010000,
    });
    assert.equal(calls.length, 0);
  });

  it('syncs a new scrobble and marks it done in the ledger', async () => {
    const artist = uid();
    const track = uid();
    const uts = '1700001000';

    const { put, calls } = makePutSpy();
    await runListensSync(fakeCtx(), {
      fetchPage: makeFetcher([fakeTrack(artist, track, uts)]),
      putItem: put,
      spotify: noSpotify(),
      listensTable: 'Listens',
      nowSeconds: 1700010000,
    });

    assert.equal(calls.length, 1);
    const item = calls[0].item;
    assert.equal(item['trackName'], track);
    assert.equal(item['artistName'], artist);
    assert.equal(item['scrobbledAt'], 1700001000);
    assert.ok(calls[0].table === 'Listens');

    const key = makeScrobbleKey(makeTrackId(artist, track), 1700001000);
    assert.ok(isWorkItemDone(JOB, key, 3), 'scrobble should be marked done');
  });

  it('skips a scrobble already in the ledger', async () => {
    const artist = uid();
    const track = uid();
    const uts = '1700002000';
    const key = makeScrobbleKey(makeTrackId(artist, track), 1700002000);
    markWorkItem(JOB, key, 'success');

    const { put, calls } = makePutSpy();
    await runListensSync(fakeCtx(), {
      fetchPage: makeFetcher([fakeTrack(artist, track, uts)]),
      putItem: put,
      spotify: noSpotify(),
      listensTable: 'Listens',
      nowSeconds: 1700010000,
    });

    assert.equal(calls.length, 0, 'no DynamoDB write for already-synced scrobble');
  });

  it('filters out now-playing track (no date)', async () => {
    const artist = uid();
    const track = uid();

    const { put, calls } = makePutSpy();
    await runListensSync(fakeCtx(), {
      fetchPage: makeFetcher([fakeTrack(artist, track, '', true)]),
      putItem: put,
      spotify: noSpotify(),
      listensTable: 'Listens',
      nowSeconds: 1700010000,
    });

    assert.equal(calls.length, 0, 'now-playing track must not be written');
  });

  it('deduplicates identical scrobbles from Last.fm response', async () => {
    const artist = uid();
    const track = uid();
    const uts = '1700003000';
    // Same track at same timestamp twice (Last.fm can return duplicates).
    const tracks = [fakeTrack(artist, track, uts), fakeTrack(artist, track, uts)];

    const { put, calls } = makePutSpy();
    await runListensSync(fakeCtx(), {
      fetchPage: makeFetcher(tracks),
      putItem: put,
      spotify: noSpotify(),
      listensTable: 'Listens',
      nowSeconds: 1700010000,
    });

    assert.equal(calls.length, 1, 'duplicate scrobble must be synced only once');
  });

  it('handles multiple pages correctly', async () => {
    const tracks1 = [fakeTrack(uid(), uid(), '1700004000'), fakeTrack(uid(), uid(), '1700004001')];
    const tracks2 = [fakeTrack(uid(), uid(), '1700004002')];

    const { put, calls } = makePutSpy();
    await runListensSync(fakeCtx(), {
      fetchPage: makeMultiPageFetcher([tracks1, tracks2]),
      putItem: put,
      spotify: noSpotify(),
      listensTable: 'Listens',
      nowSeconds: 1700010000,
    });

    assert.equal(calls.length, 3, 'all scrobbles across pages should be synced');
  });

  it('includes Spotify album art when spotify client provided', async () => {
    const artist = uid();
    const track = uid();
    const uts = '1700005000';

    const { put, calls } = makePutSpy();
    await runListensSync(fakeCtx(), {
      fetchPage: makeFetcher([fakeTrack(artist, track, uts)]),
      putItem: put,
      spotify: stubSpotify('https://sp.art/cover.jpg', 'sp999'),
      listensTable: 'Listens',
      nowSeconds: 1700010000,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].item['spotifyAlbumArt'], 'https://sp.art/cover.jpg');
    assert.equal(calls[0].item['spotifyTrackId'], 'sp999');
  });

  it('continues without Spotify art when spotify is null', async () => {
    const artist = uid();
    const track = uid();
    const uts = '1700006000';

    const { put, calls } = makePutSpy();
    await runListensSync(fakeCtx(), {
      fetchPage: makeFetcher([fakeTrack(artist, track, uts)]),
      putItem: put,
      spotify: null,
      listensTable: 'Listens',
      nowSeconds: 1700010000,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].item['spotifyAlbumArt'], '');
    assert.equal(calls[0].item['spotifyTrackId'], '');
  });

  it('marks scrobble failed in ledger when putter throws, then throws at end', async () => {
    const artist = uid();
    const track = uid();
    const uts = '1700007000';
    const key = makeScrobbleKey(makeTrackId(artist, track), 1700007000);

    const failPut: DynamoPutter = async () => {
      throw new Error('DynamoDB unavailable');
    };

    await assert.rejects(
      () =>
        runListensSync(fakeCtx(), {
          fetchPage: makeFetcher([fakeTrack(artist, track, uts)]),
          putItem: failPut,
          spotify: noSpotify(),
          listensTable: 'Listens',
          nowSeconds: 1700010000,
        }),
      /failed to sync/,
    );

    assert.ok(!isWorkItemDone(JOB, key, 3), 'failed scrobble must not be marked done');
  });

  it('syncs only NEW scrobbles when some already done', async () => {
    const existingArtist = uid();
    const existingTrack = uid();
    const existingUts = '1700008000';
    const existingKey = makeScrobbleKey(makeTrackId(existingArtist, existingTrack), 1700008000);
    markWorkItem(JOB, existingKey, 'success');

    const newArtist = uid();
    const newTrack = uid();
    const newUts = '1700008001';

    const { put, calls } = makePutSpy();
    await runListensSync(fakeCtx(), {
      fetchPage: makeFetcher([
        fakeTrack(existingArtist, existingTrack, existingUts),
        fakeTrack(newArtist, newTrack, newUts),
      ]),
      putItem: put,
      spotify: noSpotify(),
      listensTable: 'Listens',
      nowSeconds: 1700010000,
    });

    assert.equal(calls.length, 1, 'only the new scrobble should be written');
    assert.equal(calls[0].item['trackName'], newTrack);
  });
});
