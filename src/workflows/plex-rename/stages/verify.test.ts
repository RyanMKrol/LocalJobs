// verify.ts tests — an in-memory fs seam, injected plan/discover rows, scratch-DB ledger.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JobContext } from '../../../core/types.js';
import { getWorkItem } from '../../../db/store.js';
import type { ReadFsSeam } from '../lib.js';
import type { DiscoverDetail, PathMapPair, PlanDetail, VerifyDetail } from '../types.js';
import { runVerify } from './verify.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

const MAP: PathMapPair[] = [{ plex: '/volume1/Share', local: '/Volumes/Share' }];
const NOW = 1_800_000_000_000;
const OLD_MTIME = NOW - 30 * 86_400_000; // 30 days old — safely past the 7-day window
const FRESH_MTIME = NOW - 2 * 86_400_000; // 2 days old — inside the window

interface FakeFile {
  size: number;
  mtimeMs?: number;
  content?: string;
}

/** In-memory fs: files keyed by exact path; directories inferred from file paths. */
function memFs(files: Record<string, FakeFile>): ReadFsSeam {
  const isDir = (p: string) => Object.keys(files).some((f) => f.startsWith(`${p}/`));
  return {
    async stat(path) {
      const f = files[path];
      if (f) return { isFile: true, isDirectory: false, size: f.size, mtimeMs: f.mtimeMs ?? OLD_MTIME };
      if (isDir(path)) return { isFile: false, isDirectory: true, size: 0, mtimeMs: OLD_MTIME };
      return null;
    },
    async readdir(path) {
      if (!isDir(path)) return null;
      const names = new Set<string>();
      const out: { name: string; isDir: boolean }[] = [];
      for (const f of Object.keys(files)) {
        if (!f.startsWith(`${path}/`)) continue;
        const rest = f.slice(path.length + 1);
        const first = rest.split('/')[0];
        if (names.has(first)) continue;
        names.add(first);
        out.push({ name: first, isDir: rest.includes('/') });
      }
      return out;
    },
    async readFile(path) {
      return files[path]?.content ?? null;
    },
  };
}

function movieRows(over: { from?: string; to?: string; partSize?: number } = {}) {
  const from = over.from ?? '/volume1/Share/Movies/Rel/A.Movie.2016.mkv';
  const to = over.to ?? '/volume1/Share/Movies/A Movie (2016) {tmdb-555}/A Movie (2016) {tmdb-555}.mkv';
  const discover: { itemKey: string; detail: DiscoverDetail } = {
    itemKey: 'm1::part1',
    detail: {
      name: 'A Movie (2016)',
      kind: 'movie',
      file: from,
      partId: 1,
      partSize: over.partSize ?? 1000,
      mediaCount: 1,
      partCount: 1,
      partIndex: 0,
      rootPath: '/volume1/Share/Movies',
      movie: { ratingKey: 'm1', title: 'A Movie', year: 2016, tmdbId: 555 },
    },
  };
  const plan: { itemKey: string; detail: PlanDetail } = {
    itemKey: 'm1::part1',
    detail: {
      name: 'A Movie (2016)',
      decision: 'rename',
      from,
      to,
      rootPath: '/volume1/Share/Movies',
      ops: [
        { op: 'mkdir', path: '/volume1/Share/Movies/A Movie (2016) {tmdb-555}' },
        { op: 'move', from, to, role: 'media' },
      ],
    },
  };
  return { discover: [discover], plan: [plan] };
}

async function verdict(
  files: Record<string, FakeFile>,
  rows: ReturnType<typeof movieRows>,
  extra: { pathMap?: PathMapPair[] } = {},
): Promise<VerifyDetail> {
  await runVerify(fakeCtx(), {
    fs: memFs(files),
    readPlanRows: () => rows.plan,
    readDiscoverRows: () => rows.discover,
    pathMap: extra.pathMap ?? MAP,
    minAgeDays: 7,
    now: () => NOW,
  });
  const row = getWorkItem('plex-rename-verify', 'm1::part1');
  assert.ok(row, 'expected a verify row');
  return JSON.parse(row!.detail!) as VerifyDetail;
}

const HEALTHY_MOUNT = { '/Volumes/Share/Movies/marker.txt': { size: 1 } }; // makes /Volumes/Share non-empty

test('verify: happy path is eligible with mapped paths, verified size, sidecars from the real listing', async () => {
  const rows = movieRows();
  const d = await verdict(
    {
      ...HEALTHY_MOUNT,
      '/Volumes/Share/Movies/Rel/A.Movie.2016.mkv': { size: 1000, mtimeMs: OLD_MTIME },
      '/Volumes/Share/Movies/Rel/A.Movie.2016.en.srt': { size: 5 },
      '/Volumes/Share/Movies/Rel/RARBG.txt': { size: 5 },
    },
    rows,
  );
  assert.equal(d.eligible, true);
  assert.equal(d.localFrom, '/Volumes/Share/Movies/Rel/A.Movie.2016.mkv');
  assert.equal(d.localTo, '/Volumes/Share/Movies/A Movie (2016) {tmdb-555}/A Movie (2016) {tmdb-555}.mkv');
  assert.equal(d.bytes, 1000);
  assert.deepEqual(d.sidecars, [
    {
      from: '/volume1/Share/Movies/Rel/A.Movie.2016.en.srt',
      to: '/volume1/Share/Movies/A Movie (2016) {tmdb-555}/A Movie (2016) {tmdb-555}.en.srt',
      role: 'sidecar',
    },
  ]);
  assert.deepEqual(d.leftBehind, ['/volume1/Share/Movies/Rel/RARBG.txt']);
});

test('verify: every ineligibility reason fires precisely', async () => {
  const rows = movieRows();

  // Empty path map → unmapped-path.
  assert.equal((await verdict({}, rows, { pathMap: [] })).reason, 'unmapped-path');

  // No files under the local root at all → the mount is missing/unhealthy, NOT "file missing".
  assert.equal((await verdict({}, rows)).reason, 'mount-missing');

  // Mount healthy but the source file itself is absent → file-missing (the alarming one).
  assert.equal((await verdict({ ...HEALTHY_MOUNT }, rows)).reason, 'file-missing');

  // Size drifted from Plex's recorded Part.size.
  assert.equal(
    (await verdict({ ...HEALTHY_MOUNT, '/Volumes/Share/Movies/Rel/A.Movie.2016.mkv': { size: 999 } }, rows)).reason,
    'size-mismatch',
  );

  // Modified within the still-downloading window.
  assert.equal(
    (await verdict({ ...HEALTHY_MOUNT, '/Volumes/Share/Movies/Rel/A.Movie.2016.mkv': { size: 1000, mtimeMs: FRESH_MTIME } }, rows))
      .reason,
    'too-recent',
  );

  // Target already exists → never overwritten.
  assert.equal(
    (
      await verdict(
        {
          ...HEALTHY_MOUNT,
          '/Volumes/Share/Movies/Rel/A.Movie.2016.mkv': { size: 1000 },
          '/Volumes/Share/Movies/A Movie (2016) {tmdb-555}/A Movie (2016) {tmdb-555}.mkv': { size: 7 },
        },
        rows,
      )
    ).reason,
    'target-exists',
  );

  // Sidecar target collision → the whole item is ineligible (all-or-nothing).
  assert.equal(
    (
      await verdict(
        {
          ...HEALTHY_MOUNT,
          '/Volumes/Share/Movies/Rel/A.Movie.2016.mkv': { size: 1000 },
          '/Volumes/Share/Movies/Rel/A.Movie.2016.en.srt': { size: 5 },
          '/Volumes/Share/Movies/A Movie (2016) {tmdb-555}/A Movie (2016) {tmdb-555}.en.srt': { size: 5 },
        },
        rows,
      )
    ).reason,
    'sidecar-collision',
  );

  // Cross-share targets can never happen by construction, but the guard is defensive.
  const crossRows = movieRows({ to: '/volume2/Other/Movies/A Movie (2016) {tmdb-555}/m.mkv' });
  assert.equal(
    (
      await verdict({ ...HEALTHY_MOUNT, '/Volumes/Share/Movies/Rel/A.Movie.2016.mkv': { size: 1000 } }, crossRows, {
        pathMap: [...MAP, { plex: '/volume2/Other', local: '/Volumes/Other' }],
      })
    ).reason,
    // volume2 has no files in the fake fs → its mount is unhealthy; cross-share fires first though.
    'cross-share',
  );
});

test('verify: case-only rename stays eligible with the target "existing"', async () => {
  const from = '/volume1/Share/Movies/A Movie (2016) {tmdb-555}/a movie (2016) {tmdb-555}.mkv';
  const to = '/volume1/Share/Movies/A Movie (2016) {tmdb-555}/A Movie (2016) {tmdb-555}.mkv';
  const rows = movieRows({ from, to });
  const d = await verdict({ ...HEALTHY_MOUNT, '/Volumes/Share/Movies/A Movie (2016) {tmdb-555}/a movie (2016) {tmdb-555}.mkv': { size: 1000 } }, rows);
  assert.equal(d.eligible, true);
  assert.equal(d.caseOnly, true);
});

function episodeRows(over: { plexmatchContent?: string } = {}) {
  const from = '/volume1/Share/TV/[Rel] Show - 05/[Rel] Show - 05.mkv';
  const showDir = '/volume1/Share/TV/A Show (2019) {tvdb-4242}';
  const to = `${showDir}/Season 01/A Show (2019) - s01e05 - Ep.mkv`;
  const discover: { itemKey: string; detail: DiscoverDetail } = {
    itemKey: 'e1::part1',
    detail: {
      name: 'A Show — s01e05',
      kind: 'episode',
      file: from,
      partId: 1,
      partSize: 2000,
      mediaCount: 1,
      partCount: 1,
      partIndex: 0,
      rootPath: '/volume1/Share/TV',
      show: { ratingKey: 's1', title: 'A Show', year: 2019, tvdbId: 4242 },
      episodes: [{ ratingKey: 'e1', season: 1, episode: 5, title: 'Ep' }],
    },
  };
  const content = over.plexmatchContent ?? 'title: A Show\nyear: 2019\ntvdbid: 4242\n';
  const plan: { itemKey: string; detail: PlanDetail } = {
    itemKey: 'e1::part1',
    detail: {
      name: 'A Show — s01e05',
      decision: 'rename',
      from,
      to,
      rootPath: '/volume1/Share/TV',
      ops: [
        { op: 'mkdir', path: `${showDir}/Season 01` },
        { op: 'write-plexmatch', dir: showDir, content },
        { op: 'move', from, to, role: 'media' },
      ],
    },
  };
  return { discover: [discover], plan: [plan], showDir, content };
}

async function episodeVerdict(files: Record<string, FakeFile>, rows: ReturnType<typeof episodeRows>): Promise<VerifyDetail> {
  await runVerify(fakeCtx(), {
    fs: memFs(files),
    readPlanRows: () => rows.plan,
    readDiscoverRows: () => rows.discover,
    pathMap: MAP,
    minAgeDays: 7,
    now: () => NOW,
  });
  return JSON.parse(getWorkItem('plex-rename-verify', 'e1::part1')!.detail!) as VerifyDetail;
}

test('verify: .plexmatch safety — source tree blocks, matching target content skips the write, divergent blocks', async () => {
  const rows = episodeRows();
  const media = { '/Volumes/Share/TV/[Rel] Show - 05/[Rel] Show - 05.mkv': { size: 2000 } };

  // Clean: no .plexmatch anywhere → eligible, with the write op carried.
  let d = await episodeVerdict({ ...media }, rows);
  assert.equal(d.eligible, true);
  assert.deepEqual(d.plexmatch, { dir: rows.showDir, content: rows.content });

  // A .plexmatch in the SOURCE tree (may pin current filenames) → ineligible.
  d = await episodeVerdict({ ...media, '/Volumes/Share/TV/[Rel] Show - 05/.plexmatch': { size: 10, content: 'ep: 5: x.mkv\n' } }, rows);
  assert.equal(d.eligible, false);
  assert.equal(d.reason, 'existing-plexmatch');

  // Target show dir already has EXACTLY our content (earlier batch) → eligible, write op dropped.
  d = await episodeVerdict(
    { ...media, '/Volumes/Share/TV/A Show (2019) {tvdb-4242}/.plexmatch': { size: 10, content: rows.content } },
    rows,
  );
  assert.equal(d.eligible, true);
  assert.equal(d.plexmatch, undefined, 'no rewrite of an identical .plexmatch');

  // Target show dir has DIFFERENT content (hand-tuned) → never clobbered.
  d = await episodeVerdict(
    { ...media, '/Volumes/Share/TV/A Show (2019) {tvdb-4242}/.plexmatch': { size: 10, content: 'title: Other\n' } },
    rows,
  );
  assert.equal(d.eligible, false);
  assert.equal(d.reason, 'existing-plexmatch');
});
