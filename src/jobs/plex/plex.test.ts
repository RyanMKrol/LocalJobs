// Pure-logic tests for the Plex new-seasons audit — NO live Plex/TMDB. Synthetic
// fixtures exercise: GUID extraction, highest-owned-season (exclude season 0),
// highest-aired (exclude future/season-0), the complete-season filter (a season
// whose last episode airs in the future is excluded; a fully-aired one included),
// and that ENDED shows are NOT skipped.
import assert from 'node:assert/strict';
import { buildShowSnapshots, extractTmdbId, highestOwnedSeasonMap } from './plex.js';
import {
  candidateSeasons,
  completeMissingSeasons,
  evaluateShow,
  highestAiredSeason,
  isSeasonComplete,
} from './tmdb.js';
import { formatSeasonRanges } from './lib.js';
import type {
  PlexEpisodeMeta,
  PlexShow,
  PlexShowMeta,
  TmdbEpisode,
  TmdbSeasonSummary,
  TmdbSeriesDetail,
} from './types.js';

const NOW = new Date('2026-06-24T00:00:00Z');

// ── GUID extraction (always by tmdb:// GUID, never guessed) ──
assert.equal(extractTmdbId([{ id: 'imdb://tt0149460' }, { id: 'tmdb://615' }, { id: 'tvdb://73871' }]), 615);
assert.equal(extractTmdbId([{ id: 'tmdb://9999' }]), 9999);
assert.equal(extractTmdbId([{ id: 'imdb://tt1234567' }]), null, 'no tmdb GUID → null (unverifiable, never guessed)');
assert.equal(extractTmdbId(undefined), null);
assert.equal(extractTmdbId([]), null);
console.log('  ✓ extractTmdbId matches only tmdb:// GUIDs');

// ── highest owned regular season from flat episodes (exclude season 0 specials) ──
const eps: PlexEpisodeMeta[] = [
  { grandparentRatingKey: 'futurama', parentIndex: 1 },
  { grandparentRatingKey: 'futurama', parentIndex: 7 },
  { grandparentRatingKey: 'futurama', parentIndex: 0 }, // specials — must be ignored
  { grandparentRatingKey: 'futurama', parentIndex: 3 },
  { grandparentRatingKey: 'specials-only', parentIndex: 0 },
];
const owned = highestOwnedSeasonMap(eps);
assert.equal(owned.get('futurama'), 7, 'highest owned regular season is 7 (S0 excluded)');
assert.equal(owned.get('specials-only'), undefined, 'a show with only S0 has no regular season');
console.log('  ✓ highestOwnedSeasonMap excludes season 0');

// ── buildShowSnapshots joins shows + episodes ──
const showsMeta: PlexShowMeta[] = [
  { title: 'Futurama', year: 1999, ratingKey: 'futurama', Guid: [{ id: 'tmdb://615' }] },
  { title: 'No GUID Show', ratingKey: 'noguid', Guid: [{ id: 'imdb://tt1' }] },
];
const snaps = buildShowSnapshots(showsMeta, eps);
const fut = snaps.find((s) => s.ratingKey === 'futurama')!;
assert.equal(fut.tmdbId, 615);
assert.equal(fut.highestOwnedSeason, 7);
const noguid = snaps.find((s) => s.ratingKey === 'noguid')!;
assert.equal(noguid.tmdbId, null, 'GUID-less show → tmdbId null (flagged unverifiable downstream)');
assert.equal(noguid.highestOwnedSeason, 0, 'no episodes → highestOwnedSeason 0');
console.log('  ✓ buildShowSnapshots joins shows with owned-season + GUID');

// ── highest AIRED regular season (exclude future + season 0) ──
const seasons: TmdbSeasonSummary[] = [
  { season_number: 0, air_date: '1999-01-01' }, // specials — excluded
  { season_number: 1, air_date: '1999-03-28' },
  { season_number: 7, air_date: '2012-06-20' },
  { season_number: 10, air_date: '2025-09-09' }, // aired (≤ now)
  { season_number: 11, air_date: '2027-01-01' }, // future — excluded
  { season_number: 12, air_date: null }, // dateless — excluded
];
assert.equal(highestAiredSeason(seasons, NOW), 10, 'highest aired is 10 (S11 future, S12 dateless, S0 excluded)');
console.log('  ✓ highestAiredSeason excludes future + dateless + season 0');

// ── candidateSeasons: owned+1..aired ──
assert.deepEqual(candidateSeasons(7, 10), [8, 9, 10]);
assert.deepEqual(candidateSeasons(10, 10), [], 'nothing missing when owned == aired');
assert.deepEqual(candidateSeasons(12, 10), [], 'owned beyond aired → none');
console.log('  ✓ candidateSeasons spans owned+1..aired');

// ── complete-season filter: fully aired in, still-airing out ──
const fullyAired: TmdbEpisode[] = [
  { air_date: '2025-09-01', episode_number: 1 },
  { air_date: '2025-09-08', episode_number: 2 },
];
const midAiring: TmdbEpisode[] = [
  { air_date: '2025-09-01', episode_number: 1 },
  { air_date: '2027-09-08', episode_number: 2 }, // future last episode → still airing
];
const undated: TmdbEpisode[] = [
  { air_date: '2025-09-01', episode_number: 1 },
  { air_date: null, episode_number: 2 }, // an episode not yet scheduled
];
assert.equal(isSeasonComplete(fullyAired, NOW), true, 'every episode aired → complete');
assert.equal(isSeasonComplete(midAiring, NOW), false, 'a future last episode → NOT complete');
assert.equal(isSeasonComplete(undated, NOW), false, 'an undated episode → NOT complete');
assert.equal(isSeasonComplete([], NOW), false, 'empty episode list → NOT complete');
console.log('  ✓ isSeasonComplete excludes still-airing / undated seasons');

// ── end-to-end season math: own S1–7, aired S1–10, S8/9 complete, S10 still airing ──
const seasonEpisodes = new Map<number, TmdbEpisode[]>([
  [8, fullyAired],
  [9, fullyAired],
  [10, midAiring], // released but mid-airing → excluded
]);
const missing = completeMissingSeasons(7, seasons, seasonEpisodes, NOW);
assert.deepEqual(missing, [8, 9], 'S8,S9 complete; S10 mid-airing excluded');
console.log('  ✓ completeMissingSeasons keeps only fully-aired missing seasons');

// ── evaluateShow: ENDED show is NOT skipped (revivals happen) ──
const endedShow: PlexShow & { tmdbId: number } = {
  title: 'Futurama', year: 1999, tmdbId: 615, ratingKey: 'futurama', highestOwnedSeason: 7,
};
const endedDetail: TmdbSeriesDetail = { status: 'Ended', seasons };
const evalEnded = evaluateShow(endedShow, endedDetail, seasonEpisodes, NOW);
assert.ok(evalEnded, 'an Ended show with complete missing seasons is STILL actionable');
assert.equal(evalEnded!.tmdbStatus, 'Ended');
assert.deepEqual(evalEnded!.completeMissingSeasons, [8, 9]);
assert.equal(evalEnded!.highestAiredSeason, 10);
console.log('  ✓ evaluateShow does NOT skip Ended/Canceled shows');

// ── evaluateShow: nothing missing → null ──
const upToDate: PlexShow & { tmdbId: number } = { ...endedShow, highestOwnedSeason: 10 };
assert.equal(evaluateShow(upToDate, endedDetail, new Map(), NOW), null, 'owned == aired → not actionable');
console.log('  ✓ evaluateShow returns null when nothing complete is missing');

// ── season-range formatting for the digest ──
assert.equal(formatSeasonRanges([8, 9, 10]), 'S8–S10');
assert.equal(formatSeasonRanges([4]), 'S4');
assert.equal(formatSeasonRanges([4, 6]), 'S4, S6');
assert.equal(formatSeasonRanges([4, 5, 7]), 'S4–S5, S7');
assert.equal(formatSeasonRanges([10, 8, 9]), 'S8–S10', 'unsorted input is sorted');
console.log('  ✓ formatSeasonRanges compacts contiguous seasons');

console.log('  ✓ plex pure-logic tests passed');
