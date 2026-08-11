// discover.ts tests — fake injected Plex fetchers only, never a real Plex server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JobContext } from '../../../core/types.js';
import { getWorkItem } from '../../../db/store.js';
import { plexRenameConfig } from '../config.js';
import type { DiscoverDetail, PlexMetadataItem, PlexSection } from '../types.js';
import { discoverInputKeys, fileKey, runDiscover } from './discover.js';

function fakeCtx(rootAllowed: (k: string) => boolean = () => true): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed };
}

const MOVIE_SECTION: PlexSection = {
  key: plexRenameConfig.movieSection,
  type: 'movie',
  title: 'Movies',
  Location: [{ id: 1, path: '/volume1/Share/Movies' }],
};
const TV_SECTION: PlexSection = {
  key: plexRenameConfig.tvSection,
  type: 'show',
  title: 'TV shows',
  Location: [{ id: 2, path: '/volume1/Share/TV' }],
};

function fakes(movieFile = '/volume1/Share/Movies/A.Movie.2016.mkv') {
  const movieDetail: PlexMetadataItem = {
    ratingKey: 'm1',
    title: 'A Movie',
    type: 'movie',
    year: 2016,
    editionTitle: "Director's Cut",
    Guid: [{ id: 'tmdb://555' }, { id: 'imdb://tt0000555' }],
    Media: [{ id: 1, Part: [{ id: 9001, file: movieFile, size: 1000 }] }],
  };
  const showDetail: PlexMetadataItem = {
    ratingKey: 's1',
    title: 'A Show',
    type: 'show',
    year: 2019,
    Guid: [{ id: 'tvdb://4242' }, { id: 'tmdb://777' }],
  };
  // e1 is a normal episode; e2a + e2b share ONE FILE — with DIFFERENT part ids,
  // the shape found live (Mr.Robot.S02E01E02): Plex does not reliably share a
  // part id across a double-episode file, so grouping keys on the file path.
  const episodes: PlexMetadataItem[] = [
    {
      ratingKey: 'e1',
      title: 'Episode One',
      type: 'episode',
      parentIndex: 1,
      index: 1,
      originallyAvailableAt: '2019-01-01',
      Media: [{ id: 2, Part: [{ id: 9101, file: '/volume1/Share/TV/A Show/s01e01.mkv', size: 2000 }] }],
    },
    {
      ratingKey: 'e2a',
      title: 'Episode Two',
      type: 'episode',
      parentIndex: 1,
      index: 2,
      Media: [{ id: 3, Part: [{ id: 9102, file: '/volume1/Share/TV/A Show/s01e02-03.mkv', size: 3000 }] }],
    },
    {
      ratingKey: 'e2b',
      title: 'Episode Three',
      type: 'episode',
      parentIndex: 1,
      index: 3,
      Media: [{ id: 4, Part: [{ id: 9103, file: '/volume1/Share/TV/A Show/s01e02-03.mkv', size: 3000 }] }],
    },
  ];

  // The new call shape: listings carry the FULL per-item payload (includeGuids=1),
  // and allLeaves carries each episode's Media/Part — no per-item detail fetches.
  return {
    fetchSections: async () => [MOVIE_SECTION, TV_SECTION],
    fetchSectionItems: async (_key: string, type: string) => (type === 'movie' ? [movieDetail] : [showDetail]),
    fetchAllLeaves: async () => episodes,
  };
}

test('runDiscover records rich per-file snapshots, grouping multi-episode files', async () => {
  await runDiscover(fakeCtx(), fakes());

  const movie = getWorkItem('plex-rename-discover', fileKey('m1', 9001));
  assert.equal(movie?.status, 'success');
  const movieDetail = JSON.parse(movie!.detail!) as DiscoverDetail;
  assert.equal(movieDetail.kind, 'movie');
  assert.equal(movieDetail.rootPath, '/volume1/Share/Movies', 'root comes from the section Location');
  assert.equal(movieDetail.movie?.tmdbId, 555);
  assert.equal(movieDetail.movie?.imdbId, 'tt0000555');
  assert.equal(movieDetail.movie?.editionTitle, "Director's Cut");
  assert.equal(movieDetail.partSize, 1000);

  const ep1 = getWorkItem('plex-rename-discover', fileKey('e1', 9101));
  const ep1Detail = JSON.parse(ep1!.detail!) as DiscoverDetail;
  assert.equal(ep1Detail.show?.tvdbId, 4242);
  assert.equal(ep1Detail.episodes?.length, 1);
  assert.equal(ep1Detail.episodes?.[0]?.airDate, '2019-01-01');

  // The multi-episode file is ONE row (keyed by the first leaf) carrying both episodes.
  const multi = getWorkItem('plex-rename-discover', fileKey('e2a', 9102));
  assert.equal(multi?.status, 'success');
  const multiDetail = JSON.parse(multi!.detail!) as DiscoverDetail;
  assert.equal(multiDetail.episodes?.length, 2, 'both leaves grouped onto the shared part');
  assert.deepEqual(multiDetail.episodes?.map((e) => e.episode), [2, 3]);
  assert.equal(getWorkItem('plex-rename-discover', fileKey('e2b', 9103)), undefined, 'no duplicate row under the second leaf\'s own part id');
});

test('runDiscover re-marks snapshots every run (a renamed file refreshes its recorded path)', async () => {
  await runDiscover(fakeCtx(), fakes('/volume1/Share/Movies/Old Name.mkv'));
  const before = JSON.parse(getWorkItem('plex-rename-discover', fileKey('m1', 9001))!.detail!) as DiscoverDetail;
  assert.equal(before.file, '/volume1/Share/Movies/Old Name.mkv');

  await runDiscover(fakeCtx(), fakes('/volume1/Share/Movies/A Movie (2016) {tmdb-555}/A Movie (2016) {tmdb-555}.mkv'));
  const after = JSON.parse(getWorkItem('plex-rename-discover', fileKey('m1', 9001))!.detail!) as DiscoverDetail;
  assert.equal(
    after.file,
    '/volume1/Share/Movies/A Movie (2016) {tmdb-555}/A Movie (2016) {tmdb-555}.mkv',
    'the snapshot follows the live library, unlike a once-ever ledger',
  );
});

test('discover prunes GHOST snapshot rows (keys the walk no longer produces) on unlimited runs only', async () => {
  // Seed a stale row shaped like the pre-grouping-fix double-episode ghosts:
  // a key the live walk will never emit again.
  const { markWorkItem } = await import('../../../db/store.js');
  markWorkItem('plex-rename-discover', 'ghost-rk::part999', 'success', { detail: { name: 'stale ungrouped twin' } });

  // A LIMITED run must NOT prune (only its selected roots get re-marked).
  const only = fileKey('e1', 9101);
  const limitedCtx: JobContext = { log() {}, progress() {}, selectedRoots: () => new Set([only]), rootAllowed: (k) => k === only };
  await runDiscover(limitedCtx, fakes());
  assert.ok(getWorkItem('plex-rename-discover', 'ghost-rk::part999'), 'limited runs never prune');

  // An UNLIMITED run prunes the ghost, keeps every live key.
  await runDiscover(fakeCtx(), fakes());
  assert.equal(getWorkItem('plex-rename-discover', 'ghost-rk::part999'), undefined, 'ghost pruned');
  assert.ok(getWorkItem('plex-rename-discover', fileKey('m1', 9001)), 'live keys kept');
});

test('discoverInputKeys walks live and respects rootAllowed at record time', async () => {
  const keys = await discoverInputKeys(fakes());
  assert.deepEqual(new Set(keys), new Set([fileKey('m1', 9001), fileKey('e1', 9101), fileKey('e2a', 9102)]));

  // A limited run only records the allowed root's rows.
  const only = fileKey('e1', 9101);
  await runDiscover(fakeCtx((k) => k === only), fakes('/volume1/Share/Movies/Limited.mkv'));
  const movie = JSON.parse(getWorkItem('plex-rename-discover', fileKey('m1', 9001))!.detail!) as DiscoverDetail;
  assert.notEqual(movie.file, '/volume1/Share/Movies/Limited.mkv', 'file outside the limit was not re-marked');
});
