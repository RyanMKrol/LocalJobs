// listens-backfill tests — hermetic: no live Last.fm API calls, no live AWS writes.
// Uses stub fetchers + stub putter + scratch DB (npm test sets LOCALJOBS_DB).
// Covers: new scrobbles synced; already-done skipped; now-playing filtered;
// failures handled; missing env vars throw; multi-page pagination.
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import {
  runListensBackfill,
  makeBackfillFetcher,
} from './listens-backfill.js';
import {
  makeTrackId,
  makeScrobbleKey,
  type DynamoPutter,
  type LastFmFetcher,
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
  return `bf-track-${Date.now()}-${++idCounter}`;
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
    album: { mbid: '', '#text': 'Album' },
    image: [{ '#text': 'https://img/large.jpg', size: 'large' }],
    ...(nowPlaying ? { '@attr': { nowplaying: 'true' } } : { date: { uts, '#text': '' } }),
  };
}

function makeFetcher(tracks: LastFmTrack[]): LastFmFetcher {
  return async (_page) =>
    ({
      recenttracks: {
        track: tracks,
        '@attr': {
          user: 'test',
          page: '1',
          perPage: '200',
          totalPages: '1',
          total: String(tracks.length),
        },
      },
    }) as LastFmRecentTracksResponse;
}

function makeMultiPageFetcher(pages: LastFmTrack[][]): LastFmFetcher {
  return async (page) =>
    ({
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
    }) as LastFmRecentTracksResponse;
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
// makeBackfillFetcher — URL construction
// ---------------------------------------------------------------------------

describe('makeBackfillFetcher', () => {
  it('builds a fetcher that constructs a URL without a `from` parameter', () => {
    // We verify the fetcher doesn't blow up on construction (actual HTTP is
    // only tested via integration; here we just confirm it returns a function).
    const fetcher = makeBackfillFetcher('api-key', 'testuser');
    assert.equal(typeof fetcher, 'function');
  });
});

// ---------------------------------------------------------------------------
// runListensBackfill — environment guards
// ---------------------------------------------------------------------------

describe('runListensBackfill — environment guards', () => {
  it('throws if LAST_FM_API_KEY missing', async () => {
    const saved = process.env.LAST_FM_API_KEY;
    delete process.env.LAST_FM_API_KEY;
    process.env.LAST_FM_USERNAME = 'testuser';
    try {
      await assert.rejects(
        () => runListensBackfill(fakeCtx(), { fetchPage: makeFetcher([]), putItem: async () => {} }),
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
        () => runListensBackfill(fakeCtx(), { fetchPage: makeFetcher([]), putItem: async () => {} }),
        /LAST_FM_USERNAME/,
      );
    } finally {
      if (savedUser !== undefined) process.env.LAST_FM_USERNAME = savedUser;
    }
  });
});

// ---------------------------------------------------------------------------
// runListensBackfill — core behaviour
// ---------------------------------------------------------------------------

describe('runListensBackfill — core behaviour', () => {
  beforeEach(() => {
    process.env.LAST_FM_API_KEY = 'test-key';
    process.env.LAST_FM_USERNAME = 'testuser';
  });

  it('no-ops gracefully when Last.fm returns empty history', async () => {
    const { put, calls } = makePutSpy();
    await runListensBackfill(fakeCtx(), {
      fetchPage: makeFetcher([]),
      putItem: put,
      listensTable: 'Listens',
    });
    assert.equal(calls.length, 0);
  });

  it('syncs a new scrobble and marks it done in the shared ledger', async () => {
    const artist = uid();
    const track = uid();
    const uts = '1700100000';

    const { put, calls } = makePutSpy();
    await runListensBackfill(fakeCtx(), {
      fetchPage: makeFetcher([fakeTrack(artist, track, uts)]),
      putItem: put,
      listensTable: 'Listens',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].item['trackName'], track);
    assert.equal(calls[0].item['artistName'], artist);
    assert.equal(calls[0].item['scrobbledAt'], 1700100000);
    assert.equal(calls[0].table, 'Listens');

    const key = makeScrobbleKey(makeTrackId(artist, track), 1700100000);
    assert.ok(isWorkItemDone(JOB, key, 3), 'scrobble should be marked done in shared ledger');
  });

  it('skips a scrobble already in the shared ledger (idempotent)', async () => {
    const artist = uid();
    const track = uid();
    const uts = '1700101000';
    const key = makeScrobbleKey(makeTrackId(artist, track), 1700101000);
    markWorkItem(JOB, key, 'success');

    const { put, calls } = makePutSpy();
    await runListensBackfill(fakeCtx(), {
      fetchPage: makeFetcher([fakeTrack(artist, track, uts)]),
      putItem: put,
      listensTable: 'Listens',
    });

    assert.equal(calls.length, 0, 'already-synced scrobble must not be written again');
  });

  it('filters out now-playing tracks (no date)', async () => {
    const artist = uid();
    const track = uid();

    const { put, calls } = makePutSpy();
    await runListensBackfill(fakeCtx(), {
      fetchPage: makeFetcher([fakeTrack(artist, track, '', true)]),
      putItem: put,
      listensTable: 'Listens',
    });

    assert.equal(calls.length, 0, 'now-playing track must not be written');
  });

  it('filters out tracks with uts=0', async () => {
    const artist = uid();
    const track = uid();

    const { put, calls } = makePutSpy();
    await runListensBackfill(fakeCtx(), {
      fetchPage: makeFetcher([fakeTrack(artist, track, '0')]),
      putItem: put,
      listensTable: 'Listens',
    });

    assert.equal(calls.length, 0, 'track with uts=0 must be filtered');
  });

  it('walks multiple pages and syncs all scrobbles', async () => {
    const page1 = [fakeTrack(uid(), uid(), '1700102000'), fakeTrack(uid(), uid(), '1700102001')];
    const page2 = [fakeTrack(uid(), uid(), '1700102002')];
    const page3 = [fakeTrack(uid(), uid(), '1700102003'), fakeTrack(uid(), uid(), '1700102004')];

    const { put, calls } = makePutSpy();
    await runListensBackfill(fakeCtx(), {
      fetchPage: makeMultiPageFetcher([page1, page2, page3]),
      putItem: put,
      listensTable: 'Listens',
    });

    assert.equal(calls.length, 5, 'all scrobbles across all pages should be synced');
  });

  it('marks scrobble failed in ledger when putter throws, and throws at end', async () => {
    const artist = uid();
    const track = uid();
    const uts = '1700103000';
    const key = makeScrobbleKey(makeTrackId(artist, track), 1700103000);

    const failPut: DynamoPutter = async () => {
      throw new Error('DynamoDB unavailable');
    };

    await assert.rejects(
      () =>
        runListensBackfill(fakeCtx(), {
          fetchPage: makeFetcher([fakeTrack(artist, track, uts)]),
          putItem: failPut,
          listensTable: 'Listens',
        }),
      /failed during backfill/,
    );

    assert.ok(!isWorkItemDone(JOB, key, 3), 'failed scrobble must not be marked done');
  });

  it('skips already-done items from a prior partial run (re-run safety)', async () => {
    const existingArtist = uid();
    const existingTrack = uid();
    const existingUts = '1700104000';
    const existingKey = makeScrobbleKey(makeTrackId(existingArtist, existingTrack), 1700104000);
    markWorkItem(JOB, existingKey, 'success');

    const newArtist = uid();
    const newTrack = uid();
    const newUts = '1700104001';

    const { put, calls } = makePutSpy();
    await runListensBackfill(fakeCtx(), {
      fetchPage: makeFetcher([
        fakeTrack(existingArtist, existingTrack, existingUts),
        fakeTrack(newArtist, newTrack, newUts),
      ]),
      putItem: put,
      listensTable: 'Listens',
    });

    assert.equal(calls.length, 1, 'only the new scrobble should be written');
    assert.equal(calls[0].item['trackName'], newTrack);
  });

  it('uses LISTENS_TABLE env var when listensTable option is not provided', async () => {
    process.env.LISTENS_TABLE = 'MyCustomTable';
    const artist = uid();
    const track = uid();
    const uts = '1700105000';

    const { put, calls } = makePutSpy();
    try {
      await runListensBackfill(fakeCtx(), {
        fetchPage: makeFetcher([fakeTrack(artist, track, uts)]),
        putItem: put,
      });
    } finally {
      delete process.env.LISTENS_TABLE;
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].table, 'MyCustomTable');
  });
});
