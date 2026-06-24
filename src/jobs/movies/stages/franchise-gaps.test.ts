// franchise-gaps stage test — hermetic: synthetic snapshot file + injected TMDB
// fetchers (NO live Plex/TMDB, scratch DB). Covers: collection fetches are DEDUPED
// (a collection with several owned members is fetched ONCE), released-not-owned
// detection, and unreleased-part exclusion end-to-end through the stage.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobContext } from '../../../core/types.js';
import { runFranchiseGaps } from './franchise-gaps.js';
import type {
  FranchiseGapsFile,
  MovieSnapshotFile,
  TmdbCollectionDetail,
  TmdbMovieDetail,
} from '../types.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

const NOW = new Date('2026-06-24T00:00:00Z');
const dir = mkdtempSync(join(tmpdir(), 'movies-gaps-'));
const snapshotFile = join(dir, 'snapshot.json');
const gapsFile = join(dir, 'gaps.json');

// Snapshot: 3 owned Saw films (1,2,3) + 1 owned standalone film (500, no collection).
const snapshot: MovieSnapshotFile = {
  generatedAt: NOW.toISOString(),
  section: '4',
  movies: [
    { title: 'Saw', year: 2004, tmdbId: 1, ratingKey: 'a', genres: [], directors: [], countries: [], audienceRating: null, rating: null },
    { title: 'Saw II', year: 2005, tmdbId: 2, ratingKey: 'b', genres: [], directors: [], countries: [], audienceRating: null, rating: null },
    { title: 'Saw III', year: 2006, tmdbId: 3, ratingKey: 'c', genres: [], directors: [], countries: [], audienceRating: null, rating: null },
    { title: 'Standalone', year: 2015, tmdbId: 500, ratingKey: 'd', genres: [], directors: [], countries: [], audienceRating: null, rating: null },
  ],
};
writeFileSync(snapshotFile, JSON.stringify(snapshot));

// /movie/{id}: parts 1–3 belong to the Saw collection (656); 500 belongs to none.
const movieFetches: number[] = [];
const fetchMovie = async (id: number): Promise<TmdbMovieDetail> => {
  movieFetches.push(id);
  if (id === 500) return { belongs_to_collection: null };
  return { belongs_to_collection: { id: 656, name: 'Saw Collection' } };
};

// /collection/{id}: the Saw franchise. Owner has 1,2,3; missing 4 (released) and
// 5 (unreleased — must be excluded).
const collectionFetches: number[] = [];
const fetchCollection = async (id: number): Promise<TmdbCollectionDetail> => {
  collectionFetches.push(id);
  return {
    id,
    name: 'Saw Collection',
    parts: [
      { id: 1, title: 'Saw', release_date: '2004-10-29', vote_average: 7.4 },
      { id: 2, title: 'Saw II', release_date: '2005-10-28', vote_average: 6.4 },
      { id: 3, title: 'Saw III', release_date: '2006-10-27', vote_average: 6.2 },
      { id: 4, title: 'Saw IV', release_date: '2007-10-26', vote_average: 5.8 },
      { id: 5, title: 'Saw XI', release_date: '2027-09-24', vote_average: 0 },
    ],
  };
};

await runFranchiseGaps(fakeCtx(), { now: NOW, snapshotFile, gapsFile, fetchMovie, fetchCollection });

// Collection 656 was reached via 3 owned members but fetched EXACTLY ONCE (dedup).
assert.deepEqual(collectionFetches, [656], 'the collection is fetched once despite 3 owned members');
assert.equal(movieFetches.length, 4, 'one /movie call per owned tmdbId (incl. the standalone)');

const out = JSON.parse(readFileSync(gapsFile, 'utf8')) as FranchiseGapsFile;
assert.equal(out.collectionsChecked, 1);
assert.equal(out.gaps.length, 1, 'exactly one gap — Saw IV (Saw XI is unreleased)');
assert.equal(out.gaps[0].tmdbId, 4);
assert.equal(out.gaps[0].title, 'Saw IV');
assert.equal(out.gaps[0].collectionName, 'Saw Collection');
// collectionExamples: the earliest owned Saw film (Saw, 2004) is the anchor.
assert.ok(out.collectionExamples, 'collectionExamples is present');
assert.ok('Saw Collection' in (out.collectionExamples ?? {}), 'Saw Collection has an owned example');
assert.equal(out.collectionExamples!['Saw Collection'].title, 'Saw');
assert.equal(out.collectionExamples!['Saw Collection'].year, 2004);
console.log('  ✓ franchise-gaps dedupes collection fetches and detects released-not-owned');

console.log('  ✓ franchise-gaps stage tests passed');
