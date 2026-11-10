// Stage 1 tests: hermetic (scratch DB only, no live Plex). `runSnapshot`'s Plex read
// resolves the host over the network, so only its guards are exercised here: the
// item key, and that a 0-movie read fails loud instead of writing an empty snapshot.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobContext } from '../../../core/types.js';
import { syncService } from '../../../db/store.js';
import { registerService } from '../../../core/services.js';
import { missingMoviesConfig } from '../config.js';
import { runSnapshot, snapshotItemKey } from './snapshot.js';
import type { PlexMovie } from '../../movies/types.js';

// Redirect this workflow's output paths to a throwaway temp dir BEFORE any stage code
// runs, so a `runSnapshot` call can never overwrite the owner's real (gitignored)
// src/workflows/missing-movies/data/out with test fixtures. Today the only runSnapshot
// call here throws before writing (0-movie guard), but this makes the guarantee
// unconditional and matches missing-tv-seasons' snapshot/season-check tests.
const testOut = mkdtempSync(join(tmpdir(), 'missing-movies-snapshot-test-'));
missingMoviesConfig.outDir = testOut;
missingMoviesConfig.snapshotOut = join(testOut, 'snapshot.json');
missingMoviesConfig.gapsOut = join(testOut, 'franchise-gaps.json');

// `callService('plex', ...)` only enforces quota if 'plex' is registered in the
// in-process service registry — normally done by loading the daemon's registry,
// which this standalone test never does. Register it here so the wrap passes through.
registerService({ name: 'plex' });
syncService({ name: 'plex' });

function movie(overrides: Partial<PlexMovie> = {}): PlexMovie {
  return {
    title: 'Some Movie',
    year: 2020,
    tmdbId: 615,
    ratingKey: 'r1',
    genres: [],
    directors: [],
    countries: [],
    audienceRating: null,
    rating: null,
    ...overrides,
  };
}

// ── snapshotItemKey: tmdbId preferred, ratingKey fallback ──
assert.equal(snapshotItemKey(movie({ tmdbId: 615, ratingKey: 'r1' })), '615', 'prefers the tmdbId when present');
assert.equal(snapshotItemKey(movie({ tmdbId: null, ratingKey: 'noguid' })), 'noguid', 'falls back to ratingKey with no tmdbId');
console.log('  ✓ snapshotItemKey prefers tmdbId, falls back to ratingKey');

// ── Fail loud on a 0-movie read (never clobber good output with an empty snapshot) ──
{
  const ctx: JobContext = { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
  await assert.rejects(
    runSnapshot(ctx, { fetchMeta: async () => [] }),
    /returned 0 movies/,
    'runSnapshot throws on a 0-movie Plex read instead of writing an empty snapshot',
  );
  console.log('  ✓ plex-movie-snapshot fails loud on a 0-movie read (no empty-snapshot clobber)');
}

console.log('  ✓ plex-movie-snapshot tests passed');
