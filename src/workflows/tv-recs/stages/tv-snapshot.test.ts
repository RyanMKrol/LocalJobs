// Pure TV-show snapshot + taste-profile tests — synthetic Plex fixtures, no live
// Plex, no live TMDB, scratch DB only. Mirrors movies.test.ts in structure.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { JobContext } from '../../../core/types.js';
import { callService, registerService } from '../../../core/services.js';
import { workItemCounts } from '../../../db/store.js';
import { outputLocation } from '../../../engine/ports.js';
import { tvRecsConfig } from '../config.js';
import { tvArtifacts } from '../contracts.js';
import { runTvSnapshot } from './tv-snapshot.js';
import job from './tv-snapshot.job.js';
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

describe('tv-snapshot — its outputs are the two files; it writes nothing to the ledger', () => {
  const runShows: PlexShowMeta[] = [
    { title: 'The Sopranos', year: 1999, ratingKey: 'r-701', childCount: 6, Guid: [{ id: 'tmdb://1398' }], Genre: [{ tag: 'Drama' }] },
    { title: 'Fargo', year: 2014, ratingKey: 'r-702', childCount: 5, Guid: [{ id: 'tmdb://60622' }], Genre: [{ tag: 'Crime' }] },
    { title: 'Unmatched Show', year: 2020, ratingKey: 'r-703', childCount: 1, Genre: [{ tag: 'Drama' }] },
  ];

  it('the stage declares both files as outputs, at the paths the run writes', () => {
    assert.deepEqual(Object.keys(job.outputs ?? {}), ['snapshot', 'taste']);
    assert.equal(job.outputs!.snapshot.artifact.key, 'tv-snapshot');
    assert.equal(job.outputs!.taste.artifact.key, 'tv-taste-profile');
    assert.equal(outputLocation(job.name, job.outputs!.snapshot), tvRecsConfig.snapshotOut);
    assert.equal(outputLocation(job.name, job.outputs!.taste), tvRecsConfig.tasteOut);
  });

  it('what a run writes passes both artifact checks, and the snapshot lists every show for the run page', async () => {
    await runTvSnapshot(fakeCtx(), { fetchMeta: async () => runShows, now: new Date('2026-07-14T09:00:00Z') });
    const { snapshot, taste } = tvArtifacts;
    const value = snapshot.read(tvRecsConfig.snapshotOut);
    assert.equal(snapshot.check(value).ok, true);
    assert.equal(snapshot.summary!(value), '3 shows, 2 with a TMDB id');
    assert.deepEqual(snapshot.items!(value), [
      { id: '1398', title: 'The Sopranos (1999)', fields: [{ label: 'TMDB', value: '1398' }] },
      { id: '60622', title: 'Fargo (2014)', fields: [{ label: 'TMDB', value: '60622' }] },
      { id: 'r-703', title: 'Unmatched Show (2020)', fields: [] },
    ]);
    assert.equal(taste.check(taste.read(tvRecsConfig.tasteOut)).ok, true);
  });

  it('records no ledger rows: nothing is written just to be visible', async () => {
    await runTvSnapshot(fakeCtx(), { fetchMeta: async () => runShows });
    assert.deepEqual(workItemCounts('tv-snapshot'), {});
  });

  it('a snapshot in which no show carries a TMDB id fails its check (the GUIDs stopped coming through)', () => {
    const r = tvArtifacts.snapshot.check({ shows: [{ title: 'A', tmdbId: null }, { title: 'B', tmdbId: null }] });
    assert.equal(r.ok, false);
    assert.match((r.violations ?? []).join(' '), /0\/2 with a TMDB id/);
    assert.equal(tvArtifacts.snapshot.check({ shows: [] }).ok, true, 'an empty library is acceptable');
    assert.equal(tvArtifacts.snapshot.check({}).ok, false, 'a file with no shows list is not a snapshot');
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
