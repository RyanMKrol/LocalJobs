// Pure TV-show snapshot + taste-profile tests — synthetic Plex fixtures, no live
// Plex, no live TMDB, scratch DB only. Mirrors movies.test.ts in structure.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { JobContext } from '../../../core/types.js';
import { callService, registerService } from '../../../core/services.js';
import { getWorkItem, workItemCounts } from '../../../db/store.js';
import { recordSnapshotLedger, runTvSnapshot, snapshotItemKey, TV_SNAPSHOT_JOB } from './tv-snapshot.js';
import {
  buildOwnedSet,
  buildShowSnapshots,
  buildTvTasteProfile,
  decadeOf,
  extractTmdbId,
} from '../tv-shows.js';
import type { PlexShowMeta } from '../types.js';

// ── extractTmdbId (reused from plex/plex.ts) ──
assert.equal(extractTmdbId([{ id: 'imdb://tt1' }, { id: 'tmdb://1396' }]), 1396);
assert.equal(extractTmdbId([{ id: 'imdb://tt1' }]), null, 'no tmdb GUID → null');
assert.equal(extractTmdbId(undefined), null);
console.log('  ✓ extractTmdbId pulls the tmdb:// id (or null)');

// ── buildShowSnapshots: title/year/tmdbId + taste metadata ──
const meta: PlexShowMeta[] = [
  {
    title: 'Breaking Bad',
    year: 2008,
    ratingKey: '101',
    audienceRating: 9.5,
    rating: 9.5,
    childCount: 5,
    studio: 'AMC',
    Guid: [{ id: 'tmdb://1396' }],
    Genre: [{ tag: 'Drama' }, { tag: 'Crime' }],
    Role: [{ tag: 'Bryan Cranston' }, { tag: 'Aaron Paul' }],
    Country: [{ tag: 'United States' }],
  },
  {
    title: 'No GUID Show',
    year: 2015,
    ratingKey: '102',
    Guid: [{ id: 'imdb://tt9999' }],
    Genre: [{ tag: 'Comedy' }],
  },
  {
    title: 'No Year Show',
    ratingKey: '103',
    Guid: [{ id: 'tmdb://9999' }],
  },
];
const shows = buildShowSnapshots(meta);
assert.equal(shows.length, 3);
assert.equal(shows[0].title, 'Breaking Bad');
assert.equal(shows[0].tmdbId, 1396);
assert.equal(shows[0].year, 2008);
assert.deepEqual(shows[0].genres, ['Drama', 'Crime']);
assert.deepEqual(shows[0].roles, ['Bryan Cranston', 'Aaron Paul']);
assert.deepEqual(shows[0].countries, ['United States']);
assert.equal(shows[0].studio, 'AMC');
assert.equal(shows[0].audienceRating, 9.5);
assert.equal(shows[0].seasonCount, 5);
assert.equal(shows[1].tmdbId, null, 'no tmdb:// GUID → tmdbId null');
assert.equal(shows[2].year, null, 'missing year → null');
assert.equal(shows[2].studio, null, 'missing studio → null');
console.log('  ✓ buildShowSnapshots captures tmdbId + taste metadata');

// ── buildOwnedSet: only GUID-matched shows ──
const owned = buildOwnedSet(shows);
assert.ok(owned.has(1396));
assert.ok(owned.has(9999));
assert.equal(owned.size, 2, 'two shows have tmdb GUIDs');
assert.ok(!owned.has(0), 'the GUID-less show is not in the owned set');
console.log('  ✓ buildOwnedSet = the GUID-matched tmdbIds');

// ── decadeOf ──
assert.equal(decadeOf(2008), '2000s');
assert.equal(decadeOf(1994), '1990s');
assert.equal(decadeOf(1970), '1970s');
assert.equal(decadeOf(null), 'Unknown');
console.log('  ✓ decadeOf');

// ── buildTvTasteProfile: per-genre / per-decade counts ──
const profile = buildTvTasteProfile(shows);
assert.equal(profile.totalShows, 3);
assert.equal(profile.withTmdbId, 2);
assert.equal(profile.genres['Drama'], 1);
assert.equal(profile.genres['Crime'], 1);
assert.equal(profile.genres['Comedy'], 1);
assert.equal(profile.roles['Bryan Cranston'], 1);
assert.equal(profile.roles['Aaron Paul'], 1);
assert.equal(profile.decades['2000s'], 1, 'Breaking Bad (2008) → 2000s');
assert.equal(profile.decades['2010s'], 1, 'No GUID Show (2015) → 2010s');
assert.equal(profile.decades['Unknown'], 1, 'the year-less show → Unknown');
assert.equal(profile.countries['United States'], 1);
console.log('  ✓ buildTvTasteProfile rolls up genres/roles/decades/countries');

// ── Edge: empty input ──
const emptyProfile = buildTvTasteProfile([]);
assert.equal(emptyProfile.totalShows, 0);
assert.equal(emptyProfile.withTmdbId, 0);
assert.deepEqual(emptyProfile.genres, {});
console.log('  ✓ buildTvTasteProfile handles empty library');

// ── Multiple shows, same genre ──
const duplicateGenreMeta: PlexShowMeta[] = [
  { title: 'Show A', ratingKey: '1', Guid: [{ id: 'tmdb://1' }], Genre: [{ tag: 'Drama' }] },
  { title: 'Show B', ratingKey: '2', Guid: [{ id: 'tmdb://2' }], Genre: [{ tag: 'Drama' }, { tag: 'Thriller' }] },
];
const dupShows = buildShowSnapshots(duplicateGenreMeta);
const dupProfile = buildTvTasteProfile(dupShows);
assert.equal(dupProfile.genres['Drama'], 2, 'two shows tagged Drama → count 2');
assert.equal(dupProfile.genres['Thriller'], 1);
console.log('  ✓ genre tallies accumulate correctly across shows');

console.log('  ✓ tv-snapshot pure-helper tests passed');

// ── callService('plex', ...) wrapper — pass-through when service unregistered ──
{
  let fnCalled = false;
  const result = await callService('plex', async () => {
    fnCalled = true;
    return { data: 'test' };
  });
  assert.ok(fnCalled, 'callService passes through when plex service is unregistered in tests');
  assert.equal(result.data, 'test', 'result is returned unchanged');
  console.log('  ✓ callService(\'plex\', ...) pass-through wrapper works (unregistered service in test)');
}

console.log('  ✓ tv-snapshot callService tests passed');

// ── Combined per-run visibility ledger row (T571) ──
function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

const LEDGER_SHOWS: PlexShowMeta[] = [
  { title: 'The Wire', year: 2002, ratingKey: '1', childCount: 5, Guid: [{ id: 'tmdb://1438' }], Genre: [{ tag: 'Crime' }] },
  { title: 'Breaking Bad', year: 2008, ratingKey: '2', childCount: 5, Guid: [{ id: 'tmdb://1396' }], Genre: [{ tag: 'Drama' }] },
  { title: 'No GUID Show', year: 2015, ratingKey: '3', childCount: 2, Genre: [{ tag: 'Comedy' }] },
];

describe('tv-snapshot — per-show visibility ledger rows (T605)', () => {
  it('snapshotItemKey prefers tmdbId, falls back to ratingKey', () => {
    assert.equal(snapshotItemKey({ tmdbId: 1438, ratingKey: '1' }), '1438');
    assert.equal(snapshotItemKey({ tmdbId: null, ratingKey: 'noguid' }), 'noguid');
  });

  it('records one success row per show, keyed + detailed correctly', async () => {
    recordSnapshotLedger([
      { title: 'The Wire', year: 2002, tmdbId: 1438, ratingKey: '1', genres: ['Crime'], roles: [], countries: [], studio: null, audienceRating: null, rating: null, seasonCount: null },
      { title: 'No GUID Show', year: 2015, tmdbId: null, ratingKey: '3', genres: ['Comedy'], roles: [], countries: [], studio: null, audienceRating: null, rating: null, seasonCount: null },
    ]);

    const row1 = getWorkItem(TV_SNAPSHOT_JOB, '1438');
    assert.ok(row1, 'a row is recorded for the GUID-matched show');
    assert.equal(row1!.status, 'success');
    assert.deepEqual(JSON.parse(row1!.detail!), { name: 'The Wire', tmdbId: 1438, year: 2002 });

    const row2 = getWorkItem(TV_SNAPSHOT_JOB, '3');
    assert.ok(row2, 'a row is recorded for the GUID-less show too, keyed by ratingKey');
    assert.equal(row2!.status, 'success');
    assert.deepEqual(JSON.parse(row2!.detail!), { name: 'No GUID Show', tmdbId: null, year: 2015 });
  });

  it('runTvSnapshot records one row per show matching the fetched count', async () => {
    const runShows: PlexShowMeta[] = [
      { title: 'The Sopranos', year: 1999, ratingKey: 'r-701', childCount: 6, Guid: [{ id: 'tmdb://1398' }], Genre: [{ tag: 'Drama' }] },
      { title: 'Fargo', year: 2014, ratingKey: 'r-702', childCount: 5, Guid: [{ id: 'tmdb://60622' }], Genre: [{ tag: 'Crime' }] },
      { title: 'Unmatched Show', year: 2020, ratingKey: 'r-703', childCount: 1, Genre: [{ tag: 'Drama' }] },
    ];
    const now = new Date('2026-07-14T09:00:00Z');
    await runTvSnapshot(fakeCtx(), { fetchMeta: async () => runShows, now });

    let matched = 0;
    for (const s of runShows) {
      const key = s.Guid?.[0]?.id?.startsWith('tmdb://') ? s.Guid[0].id.replace('tmdb://', '') : String(s.ratingKey);
      const row = getWorkItem(TV_SNAPSHOT_JOB, key);
      assert.ok(row, `a row exists for show "${s.title}" keyed "${key}"`);
      assert.equal(row!.status, 'success');
      matched += 1;
    }
    assert.equal(matched, runShows.length, 'a ledger row was recorded for every fetched show');
  });

  it('upserts the same rows on a re-run (no duplicate rows per show)', async () => {
    const runShows: PlexShowMeta[] = [
      { title: 'Deadwood', year: 2004, ratingKey: 'r-801', childCount: 3, Guid: [{ id: 'tmdb://4564' }], Genre: [{ tag: 'Western' }] },
    ];
    const now = new Date('2026-07-14T18:00:00Z');
    await runTvSnapshot(fakeCtx(), { fetchMeta: async () => runShows, now });
    const afterFirst = workItemCounts(TV_SNAPSHOT_JOB).success;
    await runTvSnapshot(fakeCtx(), { fetchMeta: async () => runShows, now });
    const afterSecond = workItemCounts(TV_SNAPSHOT_JOB).success;
    assert.equal(afterSecond, afterFirst, 're-running with the same shows does not grow the ledger row count');
  });
});

describe('tv-snapshot — Plex reads are cacheKey-deduped (T477)', () => {
  it('a second run within the TTL does not re-invoke the underlying Plex GET', async () => {
    registerService({ name: 'plex', category: 'api' });

    const callsByPath = new Map<string, number>();
    const plexFetch = async <T,>(path: string): Promise<T> => {
      callsByPath.set(path, (callsByPath.get(path) ?? 0) + 1);
      return { MediaContainer: { Metadata: LEDGER_SHOWS } } as T;
    };

    await runTvSnapshot(fakeCtx(), { plexFetch, now: new Date('2026-07-14T09:00:00Z') });
    await runTvSnapshot(fakeCtx(), { plexFetch, now: new Date('2026-07-14T10:00:00Z') });

    assert.equal(callsByPath.size, 1, 'exactly one distinct Plex path was requested');
    for (const [path, count] of callsByPath) {
      assert.equal(count, 1, `path "${path}" should be fetched only once across two runs within the cache TTL`);
    }
  });
});
