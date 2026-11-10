// The missing-movies artifact checks, and that the three stages bind as the manifest says.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindWorkflowPorts, validateWorkflowContracts } from '../../engine/ports.js';
import type { JobDefinition } from '../../engine/index.js';
import type { FranchiseGapsFile, MovieSnapshotFile } from '../movies/types.js';
import { franchiseGaps, gapsDigest, plexMovieSnapshot } from './contracts.js';
import workflow from './missing-movies.workflow.js';
import snapshot from './stages/snapshot.job.js';
import gaps from './stages/franchise-gaps.job.js';
import notify from './stages/notify.job.js';

const movie = (over: Record<string, unknown>) => ({ title: 'A Film', year: 2001, tmdbId: 1, ratingKey: 'r1', ...over });
const snap = (movies: unknown[]) => ({ generatedAt: 'now', section: '4', movies }) as unknown as MovieSnapshotFile;

test('snapshot: needs a movies array, and at least one TMDB id once it has movies', () => {
  assert.equal(plexMovieSnapshot.check(snap([movie({})])).ok, true);
  assert.equal(plexMovieSnapshot.check(snap([])).ok, true, 'an empty library is not drift');
  assert.equal(plexMovieSnapshot.check(snap([movie({ tmdbId: null })])).ok, false, 'movies but no TMDB id at all: Plex stopped sending GUIDs');
  assert.equal(plexMovieSnapshot.check({} as MovieSnapshotFile).ok, false);
  assert.equal(plexMovieSnapshot.summary!(snap([movie({}), movie({ tmdbId: null, ratingKey: 'r2' })])), '2 movie(s), 1 with a TMDB id');
});

test('gaps: may be empty, but every gap needs a collection name and a TMDB id', () => {
  const file = (g: unknown[]) => ({ generatedAt: 'now', collectionsChecked: 3, gaps: g }) as unknown as FranchiseGapsFile;
  assert.equal(franchiseGaps.check(file([])).ok, true);
  assert.equal(franchiseGaps.check(file([{ collectionId: 1, collectionName: 'Saw', tmdbId: 9, title: 'Saw X', year: 2023, tmdbRating: 7.3 }])).ok, true);
  assert.equal(franchiseGaps.check(file([{ collectionName: '', tmdbId: 9, title: 'x' }])).ok, false);
  assert.equal(franchiseGaps.check({} as FranchiseGapsFile).ok, false);
  assert.equal(gapsDigest.summary!({ announced: 2, alreadyAnnounced: 5, ignored: 1, titles: [] }), '2 announced, 5 already announced, 1 dismissed');
});

test('the stages bind in a line: snapshot to the gap check, gaps to the notify stage', () => {
  const jobs = new Map<string, JobDefinition>([snapshot, gaps, notify].map((j) => [j.name, j]));
  const getJob = (name: string) => jobs.get(name);
  assert.deepEqual(validateWorkflowContracts(workflow, getJob), []);
  assert.deepEqual(
    bindWorkflowPorts(workflow, getJob).bindings.map((b) => `${b.producer} -> ${b.consumer}.${b.port}`),
    ['plex-movie-snapshot -> franchise-gaps.snapshot', 'franchise-gaps -> movie-gaps-notify.gaps'],
  );
});
