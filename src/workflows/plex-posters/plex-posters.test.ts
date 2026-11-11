// plex-poster-backup: the helpers and all four stages, with a fake Plex and a
// temp folder standing in for the archive. No network, no real archive.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { JobContext } from '../../engine/index.js';
import { getWorkItem } from '../../db/store.js';
import { plexPostersConfig } from './config.js';
import { backupReport, posterList, posterSet } from './contracts.js';
import { ARCHIVE_MARKER, assertArchiveReady, diffSnapshots, failureTolerance, identityKey, label, listArchiveImages, sha1, snapshotFileName, storeImage } from './lib.js';
import { ALERT_JOB, runAlert } from './stages/alert.js';
import { runFetch } from './stages/fetch.js';
import { runList, type PlexGetter } from './stages/list.js';
import { runRecord } from './stages/record.js';
import type { BackupReport, PosterItem, PosterItemWithImage, PosterList, SnapshotManifest } from './types.js';

const tmp = mkdtempSync(join(tmpdir(), 'lj-posters-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function ctx(): JobContext & { logs: string[] } {
  const logs: string[] = [];
  return { logs, log: (m) => { logs.push(m); }, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

/** A fresh, marked archive folder. */
function archive(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ARCHIVE_MARKER), 'archive\n');
  return dir;
}

const movie = (key: string, title: string, version = 1): PosterItem => ({
  type: 'movie', ratingKey: key, guid: `plex://movie/${key}`, sectionId: '4', sectionTitle: 'Films', title, year: '1999',
  thumb: `/library/metadata/${key}/thumb/${version}`,
});
const season = (key: string, n: number, showGuid = 'plex://show/s1'): PosterItem => ({
  type: 'season', ratingKey: key, guid: `plex://season/${key}`, sectionId: '5', sectionTitle: 'TV', title: `Season ${n}`, year: null,
  thumb: `/library/metadata/${key}/thumb/1`, index: n, show: { ratingKey: '900', guid: showGuid, title: 'Severance', year: '2022' },
});
const listOf = (items: PosterItem[]): PosterList => ({ generatedAt: '2026-11-08T04:00:00.000Z', server: { machineIdentifier: 'MID' }, sections: [{ id: '4', title: 'Films', type: 'movie' }], items });
/** A downloader that serves `bytes[thumb]` and counts calls. */
function downloader(bytes: Record<string, string>) {
  const calls: string[] = [];
  return {
    calls,
    download: async (thumb: string) => {
      calls.push(thumb);
      if (!(thumb in bytes)) throw new Error(`Plex HTTP 404 for ${thumb}`);
      return { buffer: Buffer.from(bytes[thumb]), contentType: 'image/jpeg' };
    },
  };
}

// ── helpers ──

test('label and identityKey: a season is named and matched through its show', () => {
  assert.equal(label(movie('1', 'Heat')), 'Heat (1999)');
  assert.equal(label(season('2', 2)), 'Severance (2022) / Season 2');
  // The same title under a new ratingKey (Plex re-created it) is still the same title.
  assert.equal(identityKey(movie('1', 'Heat')), identityKey({ ...movie('1', 'Heat'), ratingKey: '777' }));
  assert.equal(identityKey(season('2', 2)), identityKey({ ...season('99', 2), guid: 'plex://season/other' }));
  // An unmatched item has only its ratingKey to go on.
  assert.equal(identityKey({ ...movie('5', 'Home video'), guid: 'local://5' }), 'movie|key:5');
});

test('assertArchiveReady: refuses a folder with no marker and never creates the root', () => {
  assert.throws(() => assertArchiveReady(''), /PLEX_POSTER_ARCHIVE_DIR is not set/);
  // An empty folder is what a stale mount point looks like.
  const stale = join(tmp, 'stale-mountpoint');
  mkdirSync(stale);
  assert.throws(() => assertArchiveReady(stale), /was not found.*probably not mounted\. Nothing was written/);
  assert.deepEqual(readdirSync(stale), [], 'nothing was created inside it');
  const missing = join(tmp, 'does-not-exist');
  assert.throws(() => assertArchiveReady(missing), /was not found/);
  assert.equal(existsSync(missing), false, 'the root was not created');
  const ok = archive('ready');
  assertArchiveReady(ok);
  assert.ok(existsSync(join(ok, 'images')) && existsSync(join(ok, 'snapshots')));
});

test('storeImage: named by SHA-1, stored once, never left half-written under its real name', () => {
  const dir = archive('store');
  assertArchiveReady(dir);
  const a = storeImage(dir, Buffer.from('poster-a'), 'image/jpeg');
  assert.equal(a.sha1, sha1(Buffer.from('poster-a')));
  assert.equal(a.file, `images/${a.sha1}.jpg`);
  assert.equal(readFileSync(join(dir, a.file), 'utf8'), 'poster-a');
  const again = storeImage(dir, Buffer.from('poster-a'), 'image/jpeg');
  assert.deepEqual(again, a);
  assert.equal(storeImage(dir, Buffer.from('p'), 'image/png').file.endsWith('.png'), true);
  assert.deepEqual([...listArchiveImages(dir)].sort(), [a.file, `images/${sha1(Buffer.from('p'))}.png`].sort());
  assert.equal(readdirSync(join(dir, 'images')).some((f) => f.endsWith('.part')), false);
});

test('diffSnapshots: compares the bytes, not the path, and follows a title across a new ratingKey', () => {
  const img = (s: string) => ({ sha1: s, file: `images/${s}.jpg`, bytes: 1, contentType: 'image/jpeg' });
  const before: PosterItemWithImage[] = [
    { ...movie('1', 'Heat'), image: img('aaa') },
    { ...movie('2', 'Ronin'), image: img('bbb') },
    { ...movie('3', 'Gone'), image: img('ccc') },
    { ...season('10', 1), image: img('ddd') },
  ];
  const now: PosterItemWithImage[] = [
    { ...movie('1', 'Heat', 9), image: img('aaa') },             // path changed, same bytes: not a change
    { ...movie('2', 'Ronin'), ratingKey: '222', image: img('zzz') }, // re-created by Plex AND a new poster
    { ...season('10', 1), image: null },                          // lost its poster
    { ...movie('4', 'New'), image: img('eee') },
  ];
  const d = diffSnapshots(before, now);
  assert.equal(d.compared, 3);
  assert.deepEqual(d.changed.map((c) => `${c.label}:${c.from}->${c.to}`), ['Ronin (1999):bbb->zzz', 'Severance (2022) / Season 1:ddd->null']);
  assert.deepEqual(d.added, ['New (1999)']);
  assert.deepEqual(d.removed, ['Gone (1999)']);
});

test('failureTolerance and snapshotFileName', () => {
  assert.equal(failureTolerance(100), 10);
  assert.equal(failureTolerance(4500), 90);
  assert.equal(snapshotFileName('2026-11-05T00:37:19.157Z'), 'posters-2026-11-05T00-37-19-157Z.json');
});

// ── stage 1: list ──

test('list: every film and TV library, discovered from Plex; other kinds skipped; an empty read fails', async () => {
  const asked: string[] = [];
  const get: PlexGetter = async <T>(path: string): Promise<T> => {
    asked.push(path);
    const reply = (v: unknown) => v as T;
    if (path === '/identity') return reply({ MediaContainer: { machineIdentifier: 'MID' } });
    if (path === '/library/sections') return reply({ MediaContainer: { Directory: [{ key: '4', title: 'Films', type: 'movie' }, { key: '5', title: 'TV', type: 'show' }, { key: '7', title: 'Music', type: 'artist' }] } });
    if (path.startsWith('/library/sections/4/all?type=1')) return reply({ MediaContainer: { Metadata: [{ ratingKey: '1', guid: 'plex://movie/1', title: 'Heat', year: 1995, thumb: '/library/metadata/1/thumb/5' }, { ratingKey: '2', title: 'No art' }] } });
    if (path.startsWith('/library/sections/5/all?type=2')) return reply({ MediaContainer: { Metadata: [{ ratingKey: '900', guid: 'plex://show/s1', title: 'Severance', year: 2022, thumb: '/library/metadata/900/thumb/1' }] } });
    if (path.startsWith('/library/sections/5/all?type=3')) return reply({ MediaContainer: { Metadata: [{ ratingKey: '901', guid: 'plex://season/901', title: 'Season 2', index: 2, thumb: '/library/metadata/901/thumb/1', parentRatingKey: '900', parentGuid: 'plex://show/s1', parentTitle: 'Severance', parentYear: 2022 }] } });
    throw new Error(`unexpected ${path}`);
  };
  const c = ctx();
  const list = await runList(c, { get });
  assert.equal(list.server.machineIdentifier, 'MID');
  assert.deepEqual(list.sections.map((s) => s.title), ['Films', 'TV']);
  assert.deepEqual(list.items.map((i) => `${i.type}:${label(i)}:${i.thumb ?? 'none'}`), [
    'movie:Heat (1995):/library/metadata/1/thumb/5',
    'movie:No art:none',
    'show:Severance (2022):/library/metadata/900/thumb/1',
    'season:Severance (2022) / Season 2:/library/metadata/901/thumb/1',
  ]);
  assert.equal(list.items[0].year, '1995', 'a numeric year is kept as text, as the manifest format has it');
  assert.equal(asked.some((p) => p.includes('/sections/7/')), false, 'the music library was not read');
  assert.ok(c.logs.some((l) => /skipping "Music"/.test(l)));
  assert.equal(posterList.check(list).ok, true);

  const empty: PlexGetter = async <T>(path: string): Promise<T> => (path === '/identity' ? { MediaContainer: { machineIdentifier: 'MID' } } : path === '/library/sections' ? { MediaContainer: { Directory: [{ key: '4', title: 'Films', type: 'movie' }] } } : { MediaContainer: {} }) as T;
  await assert.rejects(() => runList(ctx(), { get: empty }), /listed no films, shows or seasons/);
});

// ── stage 2: fetch ──

test('fetch: downloads what is new, reuses what is archived, and stores each image once', async () => {
  const dir = archive('fetch');
  const indexFile = join(tmp, 'fetch-index.json');
  const items = [movie('1', 'Heat'), movie('2', 'Ronin'), movie('3', 'Twin poster'), { ...movie('4', 'No art'), thumb: null }];
  const first = downloader({ '/library/metadata/1/thumb/1': 'AAA', '/library/metadata/2/thumb/1': 'BBB', '/library/metadata/3/thumb/1': 'AAA' });
  const set = await runFetch(ctx(), listOf(items), { archiveDir: dir, indexFile, download: first.download, concurrency: 2 });
  assert.deepEqual(set.counts, { items: 4, downloaded: 3, reused: 0, noPoster: 1, failed: 0 });
  assert.equal(set.items[0].image?.sha1, sha1(Buffer.from('AAA')));
  assert.equal(set.items[2].image?.sha1, set.items[0].image?.sha1, 'two titles with the same picture share one image');
  assert.equal(set.items[3].image, null);
  assert.equal(listArchiveImages(dir).size, 2, 'the shared picture is stored once');
  assert.equal(posterSet.check(set).ok, true);

  // A week later: one poster has a new path and new bytes, the rest are untouched.
  const second = downloader({ '/library/metadata/2/thumb/2': 'CCC' });
  const next = await runFetch(ctx(), listOf([movie('1', 'Heat'), movie('2', 'Ronin', 2), movie('3', 'Twin poster'), { ...movie('4', 'No art'), thumb: null }]), { archiveDir: dir, indexFile, download: second.download });
  assert.deepEqual(second.calls, ['/library/metadata/2/thumb/2'], 'only the changed poster was downloaded');
  assert.deepEqual(next.counts, { items: 4, downloaded: 1, reused: 2, noPoster: 1, failed: 0 });
  assert.equal(listArchiveImages(dir).size, 3, 'the old image is kept: nothing is ever deleted');
});

test('fetch: with no local index it falls back to the archive\'s latest snapshot instead of downloading everything', async () => {
  const dir = archive('fetch-fallback');
  assertArchiveReady(dir);
  const image = storeImage(dir, Buffer.from('AAA'), 'image/jpeg');
  const latest: SnapshotManifest = { version: 1, createdAt: '2026-11-01T04:00:00.000Z', server: { machineIdentifier: 'MID' }, filters: null, counts: { items: 1, downloaded: 1, reused: 0, noPoster: 0, failed: 0 }, errors: [], items: [{ ...movie('1', 'Heat'), image }] };
  writeFileSync(join(dir, 'latest.json'), JSON.stringify(latest));
  const d = downloader({});
  const set = await runFetch(ctx(), listOf([movie('1', 'Heat')]), { archiveDir: dir, indexFile: join(tmp, 'never-written-before.json'), download: d.download });
  assert.deepEqual(d.calls, []);
  assert.equal(set.counts.reused, 1);
  assert.deepEqual(set.items[0].image, image);
});

test('fetch: a path seen before whose image has gone from the archive is downloaded again', async () => {
  const dir = archive('fetch-missing-image');
  const indexFile = join(tmp, 'missing-image-index.json');
  const d1 = downloader({ '/library/metadata/1/thumb/1': 'AAA' });
  const set = await runFetch(ctx(), listOf([movie('1', 'Heat')]), { archiveDir: dir, indexFile, download: d1.download });
  rmSync(join(dir, set.items[0].image!.file));
  const d2 = downloader({ '/library/metadata/1/thumb/1': 'AAA' });
  const again = await runFetch(ctx(), listOf([movie('1', 'Heat')]), { archiveDir: dir, indexFile, download: d2.download });
  assert.equal(d2.calls.length, 1);
  assert.equal(again.counts.downloaded, 1);
  assert.ok(existsSync(join(dir, again.items[0].image!.file)));
});

test('fetch: a failed download is recorded and the rest carry on; a retry downloads only what is still missing', async () => {
  const dir = archive('fetch-failure');
  const indexFile = join(tmp, 'failure-index.json');
  const items = [movie('1', 'Heat'), movie('2', 'Broken'), movie('3', 'Ronin')];
  const d1 = downloader({ '/library/metadata/1/thumb/1': 'AAA', '/library/metadata/3/thumb/1': 'CCC' });
  const c = ctx();
  const set = await runFetch(c, listOf(items), { archiveDir: dir, indexFile, download: d1.download });
  assert.deepEqual(set.counts, { items: 3, downloaded: 2, reused: 0, noPoster: 0, failed: 1 });
  assert.deepEqual(set.errors, [{ ratingKey: '2', label: 'Broken (1999)', error: 'Plex HTTP 404 for /library/metadata/2/thumb/1' }]);
  assert.equal(set.items[1].image, null);
  assert.equal(posterSet.check(set).ok, true, 'one failure in a small library is tolerated: the snapshot is still recorded');
  // The retry: the two good ones come from the saved index.
  const d2 = downloader({ '/library/metadata/2/thumb/1': 'BBB' });
  const retry = await runFetch(ctx(), listOf(items), { archiveDir: dir, indexFile, download: d2.download });
  assert.deepEqual(d2.calls, ['/library/metadata/2/thumb/1']);
  assert.deepEqual(retry.counts, { items: 3, downloaded: 1, reused: 2, noPoster: 0, failed: 0 });
});

test('fetch: too many failures make the output fail its own check (Plex was unwell, not one bad poster)', async () => {
  const dir = archive('fetch-many-failures');
  const items = Array.from({ length: 30 }, (_, i) => movie(String(i + 1), `Film ${i + 1}`));
  const set = await runFetch(ctx(), listOf(items), { archiveDir: dir, indexFile: join(tmp, 'many-index.json'), download: downloader({}).download });
  assert.equal(set.counts.failed, 30);
  const verdict = posterSet.check(set);
  assert.equal(verdict.ok, false);
  assert.match(verdict.violations?.join(' ') ?? '', /Few enough posters failed/);
});

test('fetch: an archive that is not there fails before anything is downloaded or written', async () => {
  const d = downloader({ '/library/metadata/1/thumb/1': 'AAA' });
  const stale = join(tmp, 'fetch-stale');
  mkdirSync(stale);
  await assert.rejects(() => runFetch(ctx(), listOf([movie('1', 'Heat')]), { archiveDir: stale, indexFile: join(tmp, 'stale-index.json'), download: d.download }), /probably not mounted/);
  assert.deepEqual(d.calls, []);
  assert.deepEqual(readdirSync(stale), []);
});

// ── stage 3: record ──

test('record: writes the dated snapshot and latest.json, then reports what changed since the last one', async () => {
  const dir = archive('record');
  const indexFile = join(tmp, 'record-index.json');
  const week1 = await runFetch(ctx(), listOf([movie('1', 'Heat'), movie('2', 'Ronin'), movie('3', 'Gone')]), { archiveDir: dir, indexFile, download: downloader({ '/library/metadata/1/thumb/1': 'AAA', '/library/metadata/2/thumb/1': 'BBB', '/library/metadata/3/thumb/1': 'CCC' }).download });
  const r1 = await runRecord(ctx(), week1, { archiveDir: dir, now: new Date('2026-11-01T04:00:00.000Z') });
  assert.equal(r1.previousSnapshot, null);
  assert.equal(r1.snapshotFile, 'snapshots/posters-2026-11-01T04-00-00-000Z.json');
  assert.deepEqual([r1.changed, r1.added, r1.removed, r1.changedPct], [0, 0, 0, 0]);
  assert.deepEqual(r1.images, { distinct: 3, bytes: 9 });
  const written = JSON.parse(readFileSync(join(dir, r1.snapshotFile), 'utf8')) as SnapshotManifest;
  assert.equal(written.version, 1);
  assert.equal(written.items.length, 3);
  assert.equal(readFileSync(join(dir, 'latest.json'), 'utf8'), readFileSync(join(dir, r1.snapshotFile), 'utf8'));
  assert.equal(backupReport.check(r1).ok, true);

  const week2 = await runFetch(ctx(), listOf([movie('1', 'Heat', 2), movie('2', 'Ronin', 2), movie('4', 'New')]), { archiveDir: dir, indexFile, download: downloader({ '/library/metadata/1/thumb/2': 'AAA', '/library/metadata/2/thumb/2': 'ZZZ', '/library/metadata/4/thumb/1': 'DDD' }).download });
  const c = ctx();
  const r2 = await runRecord(c, week2, { archiveDir: dir, now: new Date('2026-11-08T04:00:00.000Z') });
  assert.equal(r2.previousSnapshot, '2026-11-01T04:00:00.000Z');
  assert.deepEqual([r2.compared, r2.changed, r2.added, r2.removed], [2, 1, 1, 1]);
  assert.equal(r2.changedPct, 50);
  assert.deepEqual(r2.changes.map((x) => x.label), ['Ronin (1999)'], 'Heat got a new path but the same bytes, so it did not change');
  assert.deepEqual(r2.addedSample, ['New (1999)']);
  assert.deepEqual(r2.removedSample, ['Gone (1999)']);
  assert.deepEqual(readdirSync(join(dir, 'snapshots')).sort(), ['posters-2026-11-01T04-00-00-000Z.json', 'posters-2026-11-08T04-00-00-000Z.json']);
  assert.equal(listArchiveImages(dir).size, 5, 'every image from both weeks is still there');
});

test('record: refuses to write a snapshot that names an image the archive does not hold', async () => {
  const dir = archive('record-missing');
  const set = await runFetch(ctx(), listOf([movie('1', 'Heat')]), { archiveDir: dir, indexFile: join(tmp, 'rm-index.json'), download: downloader({ '/library/metadata/1/thumb/1': 'AAA' }).download });
  rmSync(join(dir, set.items[0].image!.file));
  await assert.rejects(() => runRecord(ctx(), set, { archiveDir: dir }), /not in the archive.*could not be restored/);
  assert.equal(existsSync(join(dir, 'latest.json')), false);
  assert.deepEqual(readdirSync(join(dir, 'snapshots')), []);
});

test('record: a poster that failed to download is reported as a failure, not as a poster that changed', async () => {
  const dir = archive('record-failed');
  const indexFile = join(tmp, 'rf-index.json');
  const both = { '/library/metadata/1/thumb/1': 'AAA', '/library/metadata/2/thumb/1': 'BBB' };
  await runRecord(ctx(), await runFetch(ctx(), listOf([movie('1', 'Heat'), movie('2', 'Ronin')]), { archiveDir: dir, indexFile, download: downloader(both).download }), { archiveDir: dir, now: new Date('2026-11-01T04:00:00.000Z') });
  // Next week Ronin has a new poster path that Plex cannot serve.
  const set = await runFetch(ctx(), listOf([movie('1', 'Heat'), movie('2', 'Ronin', 2)]), { archiveDir: dir, indexFile, download: downloader(both).download });
  const r = await runRecord(ctx(), set, { archiveDir: dir, now: new Date('2026-11-08T04:00:00.000Z') });
  assert.equal(r.changed, 0);
  assert.equal(r.removed, 0);
  assert.equal(r.compared, 1);
  assert.deepEqual(r.failures.map((f) => f.label), ['Ronin (1999)']);
});

// ── stage 4: alert ──

const report = (over: Partial<BackupReport>): BackupReport => ({
  createdAt: '2026-11-08T04:00:00.000Z', snapshotFile: 'snapshots/x.json', previousSnapshot: '2026-11-01T04:00:00.000Z',
  counts: { items: 1000, downloaded: 0, reused: 1000, noPoster: 0, failed: 0 }, images: { distinct: 900, bytes: 1 },
  compared: 1000, changed: 0, added: 0, removed: 0, changedPct: 0, changes: [], addedSample: [], removedSample: [], failures: [], ...over,
});
function pusher(ok = true) {
  const sent: { title: string; body: string; priority?: string }[] = [];
  return { sent, push: async (title: string, body: string, opts?: { priority?: string }) => { sent.push({ title, body, priority: opts?.priority }); return ok ? { ok: true } : { ok: false, error: 'ntfy down' }; } };
}
const limits = { thresholdPct: 20, minChanged: 25 };

test('alert: silent on a normal week and on the first snapshot', async () => {
  const p = pusher();
  const quiet = await runAlert(ctx(), report({ changed: 12, changedPct: 1.2 }), { ...limits, push: p.push });
  assert.equal(quiet.alerted, false);
  const first = await runAlert(ctx(), report({ previousSnapshot: null }), { ...limits, push: p.push });
  assert.equal(first.alerted, false);
  // A large share of a tiny library is not enough on its own.
  const tiny = await runAlert(ctx(), report({ compared: 10, changed: 5, changedPct: 50 }), { ...limits, push: p.push });
  assert.equal(tiny.alerted, false);
  assert.deepEqual(p.sent, []);
});

test('alert: one high-priority push when a large share changed, and never twice for the same snapshot', async () => {
  const p = pusher();
  const big = report({ createdAt: '2026-11-15T04:00:00.000Z', changed: 400, changedPct: 40, changes: [{ label: 'Heat (1995)', type: 'movie', ratingKey: '1', from: 'a', to: 'b', file: null }] });
  const d = await runAlert(ctx(), big, { ...limits, push: p.push });
  assert.equal(d.alerted, true);
  assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0].priority, 'high');
  assert.match(p.sent[0].body, /400 of 1000 posters \(40%\) changed since 2026-11-01/);
  assert.match(p.sent[0].body, /Heat \(1995\)/);
  assert.equal(getWorkItem(ALERT_JOB, '2026-11-15T04:00:00.000Z')?.status, 'success');
  // The stage is retried (or run again): no second push.
  const again = await runAlert(ctx(), big, { ...limits, push: p.push });
  assert.equal(again.alerted, true);
  assert.equal(p.sent.length, 1);
});

test('alert: a push that cannot be sent fails the stage and leaves it free to try again', async () => {
  const p = pusher(false);
  const big = report({ createdAt: '2026-11-22T04:00:00.000Z', changed: 400, changedPct: 40 });
  await assert.rejects(() => runAlert(ctx(), big, { ...limits, push: p.push }), /could not be sent: ntfy down/);
  assert.equal(getWorkItem(ALERT_JOB, '2026-11-22T04:00:00.000Z'), undefined);
});

// ── config ──

test('config: under test the archive folder is never taken from the environment', () => {
  const saved = process.env.PLEX_POSTER_ARCHIVE_DIR;
  process.env.PLEX_POSTER_ARCHIVE_DIR = '/Volumes/some-real-share/posters';
  try {
    assert.equal(plexPostersConfig.archiveDir(), '');
  } finally {
    if (saved === undefined) delete process.env.PLEX_POSTER_ARCHIVE_DIR;
    else process.env.PLEX_POSTER_ARCHIVE_DIR = saved;
  }
  assert.equal(plexPostersConfig.listOut.includes('/src/workflows/plex-posters/data/'), false, 'working files go to a scratch folder under test');
});
