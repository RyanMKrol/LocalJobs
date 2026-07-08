// listening-digest tests — hermetic: no live Last.fm API calls.
// Uses stub fetchers + a scratch DB (npm test sets LOCALJOBS_DB) + a tmp outDir.
// Covers: pure helpers (toArray, monthKey/Label, filterRealAlbums, render), and
// the end-to-end run (writes markdown + ledger, missing env vars throw, idempotent
// re-run within the same month overwrites rather than duplicates).
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isWorkItemDone, workflowTerminalItems } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import {
  runListeningDigest,
  toArray,
  monthKey,
  monthLabel,
  filterRealAlbums,
  renderDigestMarkdown,
  type TopAlbumsFetcher,
  type TopTracksFetcher,
} from './listening-digest.js';
import type { LastFmTopAlbum, LastFmTopTrack } from '../types.js';

function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

function album(name: string, artist: string, playcount: number): LastFmTopAlbum {
  return { name, artist: { name: artist }, playcount: String(playcount), url: '', image: [] };
}

function track(name: string, artist: string, albumName: string, playcount: number): LastFmTopTrack {
  return {
    name,
    artist: { name: artist },
    album: { '#text': albumName },
    playcount: String(playcount),
    url: '',
  };
}

function albumsFetcher(albums: LastFmTopAlbum[]): TopAlbumsFetcher {
  return async (_period: string) => ({ topalbums: { album: albums } });
}

function tracksFetcher(tracks: LastFmTopTrack[]): TopTracksFetcher {
  return async (_period: string) => ({ toptracks: { track: tracks } });
}

/** Returns different albums/tracks depending on the requested period, for testing both passes. */
function periodAwareAlbumsFetcher(byPeriod: Record<string, LastFmTopAlbum[]>): TopAlbumsFetcher {
  return async (period: string) => ({ topalbums: { album: byPeriod[period] ?? [] } });
}

function periodAwareTracksFetcher(byPeriod: Record<string, LastFmTopTrack[]>): TopTracksFetcher {
  return async (period: string) => ({ toptracks: { track: byPeriod[period] ?? [] } });
}

const JOB = 'lastfm-digest';

describe('toArray', () => {
  it('wraps a bare object in a 1-item array', () => {
    assert.deepEqual(toArray({ a: 1 } as unknown as { a: number }), [{ a: 1 }]);
  });
  it('passes an array through unchanged', () => {
    assert.deepEqual(toArray([1, 2, 3]), [1, 2, 3]);
  });
  it('returns [] for undefined', () => {
    assert.deepEqual(toArray(undefined), []);
  });
});

describe('monthKey / monthLabel', () => {
  it('formats a zero-padded year-month key in UTC', () => {
    assert.equal(monthKey(new Date('2026-07-15T00:00:00Z')), '2026-07');
    assert.equal(monthKey(new Date('2026-01-01T00:00:00Z')), '2026-01');
  });
  it('formats a human-readable month label', () => {
    assert.equal(monthLabel(new Date('2026-07-15T00:00:00Z')), 'July 2026');
  });
});

describe('filterRealAlbums', () => {
  it('drops an album where one track dominates the plays', () => {
    const albums = [album('Greatest Hits', 'Artist A', 100)];
    const tracks = [track('One Big Song', 'Artist A', 'Greatest Hits', 90)];
    const kept = filterRealAlbums(albums, tracks, 0.7);
    assert.deepEqual(kept, []);
  });

  it('keeps an album where plays are spread across tracks', () => {
    const albums = [album('OK Computer', 'Radiohead', 100)];
    const tracks = [
      track('Airbag', 'Radiohead', 'OK Computer', 20),
      track('Paranoid Android', 'Radiohead', 'OK Computer', 20),
    ];
    const kept = filterRealAlbums(albums, tracks, 0.7);
    assert.equal(kept.length, 1);
  });

  it('keeps an album with no matching track data', () => {
    const albums = [album('Unknown Pleasures', 'Joy Division', 50)];
    const kept = filterRealAlbums(albums, [], 0.7);
    assert.equal(kept.length, 1);
  });
});

describe('renderDigestMarkdown', () => {
  it('renders a heading, albums table, and tracks table', () => {
    const md = renderDigestMarkdown({
      username: 'testuser',
      monthLabel: 'July 2026',
      generatedAtIso: '2026-07-15T00:00:00.000Z',
      period: '1month',
      albums: [album('OK Computer', 'Radiohead', 42)],
      tracks: [track('Airbag', 'Radiohead', 'OK Computer', 10)],
    });
    assert.match(md, /# Listening Digest — July 2026/);
    assert.match(md, /testuser/);
    assert.match(md, /## Top Albums/);
    assert.match(md, /OK Computer \| Radiohead \| 42/);
    assert.match(md, /## Top Tracks/);
    assert.match(md, /Airbag \| Radiohead \| OK Computer \| 10/);
  });

  it('renders a placeholder when there is no data', () => {
    const md = renderDigestMarkdown({
      username: 'testuser',
      monthLabel: 'July 2026',
      generatedAtIso: '2026-07-15T00:00:00.000Z',
      period: '1month',
      albums: [],
      tracks: [],
    });
    assert.match(md, /No album plays in this period/);
    assert.match(md, /No track plays in this period/);
  });
});

describe('runListeningDigest — environment guards', () => {
  it('throws if LAST_FM_API_KEY missing', async () => {
    const saved = process.env.LAST_FM_API_KEY;
    delete process.env.LAST_FM_API_KEY;
    process.env.LAST_FM_USERNAME = 'testuser';
    try {
      await assert.rejects(
        () =>
          runListeningDigest(fakeCtx(), {
            fetchTopAlbums: albumsFetcher([]),
            fetchTopTracks: tracksFetcher([]),
          }),
        /LAST_FM_API_KEY/,
      );
    } finally {
      if (saved !== undefined) process.env.LAST_FM_API_KEY = saved;
    }
  });

  it('throws if LAST_FM_USERNAME missing', async () => {
    process.env.LAST_FM_API_KEY = 'test-key';
    const saved = process.env.LAST_FM_USERNAME;
    delete process.env.LAST_FM_USERNAME;
    try {
      await assert.rejects(
        () =>
          runListeningDigest(fakeCtx(), {
            fetchTopAlbums: albumsFetcher([]),
            fetchTopTracks: tracksFetcher([]),
          }),
        /LAST_FM_USERNAME/,
      );
    } finally {
      if (saved !== undefined) process.env.LAST_FM_USERNAME = saved;
    }
  });
});

describe('runListeningDigest — normal behaviour', () => {
  let outDir: string;

  beforeEach(() => {
    process.env.LAST_FM_API_KEY = 'test-key';
    process.env.LAST_FM_USERNAME = 'testuser';
    outDir = mkdtempSync(join(tmpdir(), 'listening-digest-test-'));
  });

  it('writes a markdown digest and marks the month done in the ledger', async () => {
    const now = new Date('2026-07-15T00:00:00Z');
    await runListeningDigest(fakeCtx(), {
      fetchTopAlbums: albumsFetcher([album('OK Computer', 'Radiohead', 42)]),
      fetchTopTracks: tracksFetcher([track('Airbag', 'Radiohead', 'OK Computer', 10)]),
      now,
      outDir,
    });

    const mdPath = join(outDir, 'listening-digest-2026-07.md');
    assert.ok(existsSync(mdPath), 'markdown file should be written');
    const content = readFileSync(mdPath, 'utf8');
    assert.match(content, /OK Computer/);
    assert.match(content, /Airbag/);

    assert.ok(isWorkItemDone(JOB, '2026-07', 3), 'month should be marked done in the ledger');

    // Regression guard for the wrong-JOB_NAME bug (T346): the workflow detail
    // page's unified Output section queries the terminal job's ledger by its
    // REAL registered job name ('lastfm-digest'), not the workflow name — so
    // the digest must surface there after a run.
    const outputItems = workflowTerminalItems(['lastfm-digest']);
    assert.ok(
      outputItems.some((item) => item.jobName === 'lastfm-digest' && item.itemKey === '2026-07'),
      'digest item should surface in workflowTerminalItems under the real job name',
    );
  });

  it('re-running the same month overwrites the file rather than erroring', async () => {
    const now = new Date('2026-08-01T00:00:00Z');
    await runListeningDigest(fakeCtx(), {
      fetchTopAlbums: albumsFetcher([album('First Run Album', 'Artist', 5)]),
      fetchTopTracks: tracksFetcher([]),
      now,
      outDir,
    });
    await runListeningDigest(fakeCtx(), {
      fetchTopAlbums: albumsFetcher([album('Second Run Album', 'Artist', 9)]),
      fetchTopTracks: tracksFetcher([]),
      now,
      outDir,
    });

    const mdPath = join(outDir, 'listening-digest-2026-08.md');
    const content = readFileSync(mdPath, 'utf8');
    assert.match(content, /Second Run Album/);
    assert.doesNotMatch(content, /First Run Album/);
  });

  it('filters single-track-dominated albums out of the written digest', async () => {
    const now = new Date('2026-09-01T00:00:00Z');
    await runListeningDigest(fakeCtx(), {
      fetchTopAlbums: albumsFetcher([album('Dominated Album', 'Artist', 100)]),
      fetchTopTracks: tracksFetcher([track('One Song', 'Artist', 'Dominated Album', 95)]),
      now,
      outDir,
    });

    const content = readFileSync(join(outDir, 'listening-digest-2026-09.md'), 'utf8');
    assert.match(content, /No album plays in this period/);
    assert.doesNotMatch(content, /\| Dominated Album \| Artist \| 100 \|/);
  });

  it('writes both the 1-month and trailing 3-month digests, each with the right period data', async () => {
    const now = new Date('2026-11-01T00:00:00Z');
    await runListeningDigest(fakeCtx(), {
      fetchTopAlbums: periodAwareAlbumsFetcher({
        '1month': [album('One Month Album', 'Artist', 10)],
        '3month': [album('Three Month Album', 'Artist', 30)],
      }),
      fetchTopTracks: periodAwareTracksFetcher({
        '1month': [track('One Month Track', 'Artist', 'One Month Album', 10)],
        '3month': [track('Three Month Track', 'Artist', 'Three Month Album', 30)],
      }),
      now,
      outDir,
    });

    const monthlyPath = join(outDir, 'listening-digest-2026-11.md');
    const trailingPath = join(outDir, 'listening-digest-2026-11-3month.md');
    assert.ok(existsSync(monthlyPath), '1-month markdown file should be written');
    assert.ok(existsSync(trailingPath), 'trailing 3-month markdown file should be written');

    const monthlyContent = readFileSync(monthlyPath, 'utf8');
    assert.match(monthlyContent, /One Month Album/);
    assert.doesNotMatch(monthlyContent, /Three Month Album/);
    assert.match(monthlyContent, /# Listening Digest — November 2026/);

    const trailingContent = readFileSync(trailingPath, 'utf8');
    assert.match(trailingContent, /Three Month Album/);
    assert.doesNotMatch(trailingContent, /One Month Album/);
    assert.match(trailingContent, /# Listening Digest — November 2026 \(Trailing 3 Months\)/);

    assert.ok(isWorkItemDone(JOB, '2026-11', 3), '1-month ledger key should be marked done');
    assert.ok(isWorkItemDone(JOB, '2026-11-3month', 3), '3-month ledger key should be marked done');

    const outputItems = workflowTerminalItems(['lastfm-digest']);
    assert.ok(
      outputItems.some((item) => item.jobName === 'lastfm-digest' && item.itemKey === '2026-11'),
      '1-month digest item should surface in workflowTerminalItems',
    );
    assert.ok(
      outputItems.some((item) => item.jobName === 'lastfm-digest' && item.itemKey === '2026-11-3month'),
      'trailing 3-month digest item should surface in workflowTerminalItems',
    );
  });

  it('re-running the same month overwrites both files rather than duplicating', async () => {
    const now = new Date('2026-12-01T00:00:00Z');
    await runListeningDigest(fakeCtx(), {
      fetchTopAlbums: periodAwareAlbumsFetcher({
        '1month': [album('First Run Monthly', 'Artist', 5)],
        '3month': [album('First Run Trailing', 'Artist', 15)],
      }),
      fetchTopTracks: periodAwareTracksFetcher({}),
      now,
      outDir,
    });
    await runListeningDigest(fakeCtx(), {
      fetchTopAlbums: periodAwareAlbumsFetcher({
        '1month': [album('Second Run Monthly', 'Artist', 9)],
        '3month': [album('Second Run Trailing', 'Artist', 27)],
      }),
      fetchTopTracks: periodAwareTracksFetcher({}),
      now,
      outDir,
    });

    const monthlyContent = readFileSync(join(outDir, 'listening-digest-2026-12.md'), 'utf8');
    assert.match(monthlyContent, /Second Run Monthly/);
    assert.doesNotMatch(monthlyContent, /First Run Monthly/);

    const trailingContent = readFileSync(join(outDir, 'listening-digest-2026-12-3month.md'), 'utf8');
    assert.match(trailingContent, /Second Run Trailing/);
    assert.doesNotMatch(trailingContent, /First Run Trailing/);

    const outputItems = workflowTerminalItems(['lastfm-digest']);
    assert.equal(
      outputItems.filter((item) => item.itemKey === '2026-12' || item.itemKey === '2026-12-3month').length,
      2,
      'a same-month re-run must not duplicate ledger rows for either period',
    );
  });

  it('handles Last.fm returning a bare object instead of an array', async () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const fetchTopAlbums: TopAlbumsFetcher = async () => ({
      topalbums: { album: album('Solo Album', 'Artist', 3) },
    });
    const fetchTopTracks: TopTracksFetcher = async () => ({
      toptracks: { track: track('Solo Track', 'Artist', 'Solo Album', 3) },
    });

    await runListeningDigest(fakeCtx(), { fetchTopAlbums, fetchTopTracks, now, outDir });

    const content = readFileSync(join(outDir, 'listening-digest-2026-10.md'), 'utf8');
    assert.match(content, /Solo Album/);
    assert.match(content, /Solo Track/);
  });
});
