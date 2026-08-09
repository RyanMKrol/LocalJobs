// plan.ts tests — injected discover rows, real naming engine, scratch-DB ledger.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JobContext } from '../../../core/types.js';
import { getWorkItem } from '../../../db/store.js';
import type { DiscoverDetail, PlanDetail } from '../types.js';
import { runPlan } from './plan.js';

function fakeCtx(rootAllowed: (k: string) => boolean = () => true): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed };
}

function movieRow(key: string, file: string, over: Partial<DiscoverDetail> = {}): { itemKey: string; detail: DiscoverDetail } {
  return {
    itemKey: key,
    detail: {
      name: 'A Movie (2016)',
      kind: 'movie',
      file,
      partId: 1,
      partSize: 5_000_000_000,
      mediaCount: 1,
      partCount: 1,
      partIndex: 0,
      rootPath: '/volume1/Share/Movies',
      movie: { ratingKey: 'm1', title: 'A Movie', year: 2016, tmdbId: 555 },
      ...over,
    },
  };
}

function planOf(key: string): PlanDetail {
  const row = getWorkItem('plex-rename-plan', key);
  assert.ok(row, `expected a plan row for ${key}`);
  return JSON.parse(row!.detail!) as PlanDetail;
}

test('runPlan records rename / already-canonical / skip decisions with from→to detail', async () => {
  const rows = [
    movieRow('m1::part1', '/volume1/Share/Movies/A.Movie.2016.mkv'),
    movieRow('m2::part2', '/volume1/Share/Movies/A Movie (2016) {tmdb-556}/A Movie (2016) {tmdb-556}.mkv', {
      movie: { ratingKey: 'm2', title: 'A Movie', year: 2016, tmdbId: 556 },
      partId: 2,
    }),
    movieRow('m3::part3', '/volume1/Share/Movies/NoIds.mkv', {
      movie: { ratingKey: 'm3', title: 'No Ids', year: 2001 },
      partId: 3,
    }),
  ];
  await runPlan(fakeCtx(), { readDiscoverRows: () => rows });

  const rename = planOf('m1::part1');
  assert.equal(rename.decision, 'rename');
  assert.equal(rename.from, '/volume1/Share/Movies/A.Movie.2016.mkv');
  assert.equal(rename.to, '/volume1/Share/Movies/A Movie (2016) {tmdb-555}/A Movie (2016) {tmdb-555}.mkv');
  assert.equal(rename.rootPath, '/volume1/Share/Movies');
  assert.ok(rename.ops?.some((o) => o.op === 'move'), 'engine ops carried in the detail');

  assert.equal(planOf('m2::part2').decision, 'already-canonical');

  const skip = planOf('m3::part3');
  assert.equal(skip.decision, 'skip');
  assert.equal(skip.reason, 'missing-id');
});

test('runPlan downgrades duplicate targets to collisions and recomputes on every run', async () => {
  // Two different movies computing the SAME canonical target.
  const dup = [
    movieRow('d1::part1', '/volume1/Share/Movies/CopyA/m.mkv', { partId: 1 }),
    movieRow('d2::part2', '/volume1/Share/Movies/CopyB/m.mkv', {
      movie: { ratingKey: 'm1b', title: 'A Movie', year: 2016, tmdbId: 555 },
      partId: 2,
    }),
  ];
  await runPlan(fakeCtx(), { readDiscoverRows: () => dup });
  assert.equal(planOf('d1::part1').reason, 'target-collision');
  assert.equal(planOf('d2::part2').reason, 'target-collision');

  // Next run one of them is gone — the survivor's decision RECOMPUTES to rename.
  await runPlan(fakeCtx(), { readDiscoverRows: () => [dup[0]] });
  assert.equal(planOf('d1::part1').decision, 'rename', 'plans are derived state, recomputed each run');
});
