// The poster restore: how a saved title is found again, and what a dry run and a
// real run do. Every call to Plex and the archive is a fake.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha1 } from '../src/workflows/plex-posters/lib.js';
import type { PosterItem, PosterItemWithImage, SnapshotManifest } from '../src/workflows/plex-posters/types.js';
import { buildIndex, findTarget, restorePosters, type PosterCandidate, type RestoreDeps } from './plex-posters-restore.js';

const movie = (key: string, title: string, over: Partial<PosterItem> = {}): PosterItem => ({
  type: 'movie', ratingKey: key, guid: `plex://movie/${title}`, sectionId: '4', sectionTitle: 'Films', title, year: '1999', thumb: `/library/metadata/${key}/thumb/1`, ...over,
});
const saved = (item: PosterItem, bytes: string | null): PosterItemWithImage => ({
  ...item, image: bytes === null ? null : { sha1: sha1(Buffer.from(bytes)), file: `images/${sha1(Buffer.from(bytes))}.jpg`, bytes: bytes.length, contentType: 'image/jpeg' },
});
const snapshot = (items: PosterItemWithImage[]): SnapshotManifest => ({
  version: 1, createdAt: '2026-11-08T04:00:00.000Z', server: { machineIdentifier: 'MID' }, filters: null,
  counts: { items: items.length, downloaded: 0, reused: 0, noPoster: 0, failed: 0 }, errors: [], items,
});

/** A fake library: each title's current poster bytes, and its list of poster candidates. */
function fakePlex(current: PosterItem[], showing: Record<string, string>, machineId = 'MID') {
  const candidates: Record<string, PosterCandidate[]> = {};
  const calls: string[] = [];
  const archive: Record<string, string> = {};
  const deps: RestoreDeps = {
    machineIdentifier: async () => machineId,
    listCurrent: async () => current,
    posters: async (key) => candidates[key] ?? [],
    download: async (thumb) => Buffer.from(showing[thumb] ?? ''),
    readImage: (file) => (file in archive ? Buffer.from(archive[file]) : null),
    select: async (key, posterKey) => {
      calls.push(`select ${key} ${posterKey}`);
      for (const c of candidates[key] ?? []) c.selected = c.ratingKey === posterKey;
    },
    upload: async (key, body) => {
      calls.push(`upload ${key} ${body.toString()}`);
      for (const c of candidates[key] ?? []) c.selected = false;
      (candidates[key] ??= []).push({ ratingKey: `upload://posters/${sha1(body)}`, selected: true });
    },
    lock: async (item) => { calls.push(`lock ${item.ratingKey}`); },
  };
  return { deps, calls, candidates, archive };
}
const quiet = { log: () => {} };

test('findTarget: by ratingKey on the same server, else guid, else show and season, else name; never a guess between two', () => {
  const heat = movie('1', 'Heat');
  const index = buildIndex([heat, movie('2', 'Ronin'), movie('3', 'Twin', { guid: 'local://3' }), movie('4', 'Twin', { guid: 'local://4', sectionTitle: 'Other' })]);
  assert.equal(findTarget(heat, index, true)?.how, 'ratingKey');
  // Plex re-created the title under a new key: found by its guid.
  assert.deepEqual(findTarget({ ...heat, ratingKey: '999' }, index, true), { item: heat, how: 'guid' });
  // A different server never trusts a ratingKey.
  assert.equal(findTarget(heat, index, false)?.how, 'guid');
  // Two candidates with the same name: the one in the library the snapshot recorded.
  assert.equal(findTarget(movie('77', 'Twin', { guid: 'local://77' }), index, false)?.item.ratingKey, '3');
  // ...and no answer when that does not settle it.
  assert.equal(findTarget(movie('77', 'Twin', { guid: 'local://77', sectionTitle: 'Elsewhere' }), index, false), null);
  assert.equal(findTarget(movie('5', 'Nowhere'), index, true), null);

  const s2: PosterItem = { type: 'season', ratingKey: '50', guid: 'plex://season/a', sectionId: '5', sectionTitle: 'TV', title: 'Season 2', year: null, thumb: null, index: 2, show: { ratingKey: '40', guid: 'plex://show/s', title: 'Severance', year: '2022' } };
  const seasons = buildIndex([s2]);
  assert.equal(findTarget({ ...s2, ratingKey: '51', guid: 'plex://season/other' }, seasons, false)?.how, 'show+season');
});

test('a dry run says what it would restore and changes nothing', async () => {
  const heat = movie('1', 'Heat');
  const ronin = movie('2', 'Ronin', { thumb: '/library/metadata/2/thumb/9' });
  const plex = fakePlex([heat, ronin], { '/library/metadata/2/thumb/9': 'AGENT-DEFAULT' });
  const r = await restorePosters(snapshot([saved(heat, 'HEAT'), saved({ ...ronin, thumb: '/library/metadata/2/thumb/1' }, 'RONIN'), saved(movie('3', 'Gone'), 'GONE'), saved(movie('4', 'No art'), null)]), { apply: false, ...quiet }, plex.deps);
  assert.deepEqual(r.ok, ['Heat (1999)'], 'an unchanged poster path needs no check');
  assert.deepEqual(r.wouldRestore, ['Ronin (1999)']);
  assert.deepEqual(r.notFound, ['Gone (1999)']);
  assert.deepEqual(r.noBackup, ['No art (1999)']);
  assert.deepEqual(plex.calls, [], 'a dry run makes no change to Plex');
});

test('a changed path with the same bytes is already right (Plex bumps the path on any refresh)', async () => {
  const ronin = movie('2', 'Ronin', { thumb: '/library/metadata/2/thumb/9' });
  const plex = fakePlex([ronin], { '/library/metadata/2/thumb/9': 'RONIN' });
  const r = await restorePosters(snapshot([saved({ ...ronin, thumb: '/library/metadata/2/thumb/1' }, 'RONIN')]), { apply: true, ...quiet }, plex.deps);
  assert.deepEqual(r.ok, ['Ronin (1999)']);
  assert.deepEqual(plex.calls, []);
});

test('apply: uploads the image from the archive, makes sure it is selected, and locks it', async () => {
  const ronin = movie('2', 'Ronin', { thumb: '/library/metadata/2/thumb/9' });
  const plex = fakePlex([ronin], { '/library/metadata/2/thumb/9': 'AGENT-DEFAULT' });
  const item = saved({ ...ronin, thumb: '/library/metadata/2/thumb/1' }, 'RONIN');
  plex.archive[item.image!.file] = 'RONIN';
  const r = await restorePosters(snapshot([item]), { apply: true, ...quiet }, plex.deps);
  assert.deepEqual(r.restored, ['Ronin (1999)']);
  assert.deepEqual(plex.calls, ['upload 2 RONIN', 'lock 2']);
  assert.equal(plex.candidates['2'].find((c) => c.selected)?.ratingKey, `upload://posters/${item.image!.sha1}`);
});

test('apply: an image Plex still holds as an upload is selected, not sent again', async () => {
  const ronin = movie('2', 'Ronin', { thumb: '/library/metadata/2/thumb/9' });
  const plex = fakePlex([ronin], { '/library/metadata/2/thumb/9': 'AGENT-DEFAULT' });
  const item = saved({ ...ronin, thumb: '/library/metadata/2/thumb/1' }, 'RONIN');
  plex.candidates['2'] = [{ ratingKey: 'https://image.tmdb.org/x.jpg', selected: true }, { ratingKey: `upload://posters/${item.image!.sha1}`, selected: false }];
  const r = await restorePosters(snapshot([item]), { apply: true, lock: false, ...quiet }, plex.deps);
  assert.deepEqual(r.restored, ['Ronin (1999)']);
  assert.deepEqual(plex.calls, [`select 2 upload://posters/${item.image!.sha1}`]);
});

test('apply: an image missing from the archive is a failure for that title only', async () => {
  const ronin = movie('2', 'Ronin', { thumb: '/library/metadata/2/thumb/9' });
  const heat = movie('1', 'Heat', { thumb: '/library/metadata/1/thumb/9' });
  const plex = fakePlex([ronin, heat], { '/library/metadata/2/thumb/9': 'X', '/library/metadata/1/thumb/9': 'Y' });
  const good = saved({ ...heat, thumb: '/library/metadata/1/thumb/1' }, 'HEAT');
  plex.archive[good.image!.file] = 'HEAT';
  const r = await restorePosters(snapshot([saved({ ...ronin, thumb: '/library/metadata/2/thumb/1' }, 'RONIN'), good]), { apply: true, concurrency: 1, ...quiet }, plex.deps);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0], /Ronin \(1999\): image file missing from the archive/);
  assert.deepEqual(r.restored, ['Heat (1999)']);
});
