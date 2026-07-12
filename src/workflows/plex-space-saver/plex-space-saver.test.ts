// Pure-logic tests for the Plex space-saver size breakdown — NO live Plex. Synthetic
// fixtures exercise: per-part byte summation, human-readable formatting, one-row-per-movie,
// one-row-per-show (summed across every episode/season), and biggest-first sorting.
import assert from 'node:assert/strict';
import { checkDrop, buildBreakdown, buildMovieRows, buildShowRows, formatBytes, itemBytes } from './lib.js';
import { SHRINK_ALERT_JOB, weekKey } from './stages/scan.js';
import { isWorkItemDone, markWorkItem } from '../../db/store.js';
import type { PlexEpisodeMeta, PlexMovieMeta, PlexShowMeta, SizeBaselineFile } from './types.js';

// ── itemBytes sums every Media[].Part[].size ──
assert.equal(itemBytes({ Media: [{ Part: [{ size: 100 }, { size: 50 }] }, { Part: [{ size: 25 }] }] }), 175);
assert.equal(itemBytes({}), 0, 'no Media → 0 bytes');
assert.equal(itemBytes({ Media: [{ Part: [{}] }] }), 0, 'a part with no size contributes 0');
console.log('  ✓ itemBytes sums all parts across all media');

// ── formatBytes ──
assert.equal(formatBytes(0), '0 B');
assert.equal(formatBytes(500), '500 B');
assert.equal(formatBytes(1536), '1.5 KB');
assert.equal(formatBytes(1024 ** 3 * 12.3), '12.3 GB');
console.log('  ✓ formatBytes renders human-readable sizes');

// ── buildMovieRows: one row per movie ──
const movies: PlexMovieMeta[] = [
  { title: 'Big Movie', year: 2020, ratingKey: 'm1', Media: [{ Part: [{ size: 1024 ** 3 * 10 }] }] },
  { title: 'Small Movie', year: 2021, ratingKey: 'm2', Media: [{ Part: [{ size: 1024 ** 3 * 2 }] }] },
];
const movieRows = buildMovieRows(movies);
assert.equal(movieRows.length, 2);
assert.equal(movieRows.find((r) => r.ratingKey === 'm1')!.type, 'movie');
assert.equal(movieRows.find((r) => r.ratingKey === 'm1')!.bytes, 1024 ** 3 * 10);
console.log('  ✓ buildMovieRows: one row per movie');

// ── buildShowRows: one row per show, summing episodes across ALL seasons ──
const shows: PlexShowMeta[] = [
  { title: 'Big Show', year: 2010, ratingKey: 's1' },
  { title: 'No Episodes Show', year: 2015, ratingKey: 's2' },
];
const episodes: PlexEpisodeMeta[] = [
  { grandparentRatingKey: 's1', Media: [{ Part: [{ size: 1024 ** 3 * 1 }] }] }, // S1E1
  { grandparentRatingKey: 's1', Media: [{ Part: [{ size: 1024 ** 3 * 1 }] }] }, // S1E2
  { grandparentRatingKey: 's1', Media: [{ Part: [{ size: 1024 ** 3 * 2 }] }] }, // S2E1 — different season, still summed
];
const showRows = buildShowRows(shows, episodes);
const s1 = showRows.find((r) => r.ratingKey === 's1')!;
assert.equal(s1.type, 'show');
assert.equal(s1.bytes, 1024 ** 3 * 4, 'sums episodes across every season');
const s2 = showRows.find((r) => r.ratingKey === 's2')!;
assert.equal(s2.bytes, 0, 'a show with no episodes gets 0 bytes, not dropped');
console.log('  ✓ buildShowRows: one row per show, summed across all seasons');

// ── buildBreakdown: combines + sorts biggest-first ──
const now = new Date('2026-07-03T00:00:00Z');
const breakdown = buildBreakdown(movieRows, showRows, '4', '5', now);
assert.equal(breakdown.movieCount, 2);
assert.equal(breakdown.showCount, 2);
assert.equal(breakdown.items.length, 4);
assert.equal(breakdown.items[0].ratingKey, 'm1', 'biggest item (10 GB movie) sorts first');
assert.ok(breakdown.items.every((item, i) => i === 0 || item.bytes <= breakdown.items[i - 1].bytes), 'strictly biggest-first');
assert.equal(breakdown.totalBytes, 1024 ** 3 * (10 + 2 + 4 + 0));
console.log('  ✓ buildBreakdown combines movie+show rows, sorted biggest-first');

// ── weekKey — ISO week, matches stock-digest's convention ──
assert.equal(weekKey(new Date('2026-07-03T00:00:00Z')), '2026-W27');
console.log('  ✓ weekKey computes the ISO-8601 week key');

// ── checkDrop: shrink-guard threshold logic (T519, absolute GB, not percentage) ──
const GB = 1024 ** 3;
const priorBaseline: SizeBaselineFile = { totalBytes: 1000 * GB, at: '2026-07-05T06:00:00.000Z' };

// prior 1000 GB / current 800 GB (a 200 GB drop) → exceeds a 1 GB threshold
const bigDrop = checkDrop(priorBaseline, 800 * GB, 1);
assert.equal(bigDrop.hasPrior, true);
assert.equal(bigDrop.dropBytes, 200 * GB);
assert.equal(bigDrop.exceeds, true, 'a 200 GB drop exceeds a 1 GB threshold');

// prior 1000 GB / current 999.5 GB (a 0.5 GB drop) → under a 1 GB threshold
const smallDrop = checkDrop(priorBaseline, 999.5 * GB, 1);
assert.equal(smallDrop.exceeds, false, 'a 0.5 GB drop does not exceed a 1 GB threshold');

// current >= prior (stable or growing) → never exceeds
const stable = checkDrop(priorBaseline, 1000 * GB, 1);
assert.equal(stable.dropBytes, 0);
assert.equal(stable.exceeds, false, 'a stable library never exceeds');
const growing = checkDrop(priorBaseline, 1200 * GB, 1);
assert.ok(growing.dropBytes < 0);
assert.equal(growing.exceeds, false, 'a growing library never exceeds');

// no prior baseline (first run) → never exceeds, hasPrior is false
const firstRun = checkDrop(null, 800 * GB, 1);
assert.equal(firstRun.hasPrior, false);
assert.equal(firstRun.exceeds, false, 'first run (no baseline) never alerts');
console.log('  ✓ checkDrop: absolute-GB shrink threshold logic');

// ── shrink-guard notify-once ledger: same already-alerted baseline is not re-sent ──
{
  let pushCalls = 0;
  const fakePush = async () => {
    pushCalls += 1;
    return { ok: true };
  };

  const alertKey = priorBaseline.at;
  // Simulate scan.ts's decision: drop exceeds threshold, ledger not yet marked → alert + mark.
  assert.equal(isWorkItemDone(SHRINK_ALERT_JOB, alertKey, 1), false, 'not yet alerted for this baseline');
  const drop1 = checkDrop(priorBaseline, 800 * GB, 1);
  assert.equal(drop1.exceeds, true);
  if (drop1.exceeds && !isWorkItemDone(SHRINK_ALERT_JOB, alertKey, 1)) {
    await fakePush();
    markWorkItem(SHRINK_ALERT_JOB, alertKey, 'success', { detail: { name: `Shrink alert — ${alertKey}` } });
  }
  assert.equal(pushCalls, 1, 'first run against this baseline sends exactly one alert');

  // A second run against the SAME already-alerted baseline must not re-send.
  assert.equal(isWorkItemDone(SHRINK_ALERT_JOB, alertKey, 1), true, 'ledger now marks this baseline as alerted');
  const drop2 = checkDrop(priorBaseline, 800 * GB, 1);
  assert.equal(drop2.exceeds, true);
  if (drop2.exceeds && !isWorkItemDone(SHRINK_ALERT_JOB, alertKey, 1)) {
    await fakePush();
  }
  assert.equal(pushCalls, 1, 'notify-once guard: re-run against the same baseline does not re-send');
  console.log('  ✓ shrink-guard notify-once ledger suppresses a re-send for the same baseline');
}

console.log('  ✓ plex-space-saver pure-logic tests passed');
