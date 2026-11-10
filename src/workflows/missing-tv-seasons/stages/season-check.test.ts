// season-check tests — hermetic: stub global.fetch (tmdbGet calls it directly, no
// injectable client), write the snapshot to the real (gitignored) config path since
// runSeasonCheck has no path-override option. Covers: a genuine per-show TMDB failure
// makes the run throw (T418) while still persisting what succeeded; all-success /
// unverifiable-only / quota-only companion cases all resolve normally (no throw).
//
// `../../../core/plex-client.js` reads TMDB_API_TOKEN into a module-level const at
// import time. In the full `npm test` run, an earlier-sorted file
// (`src/core/plex-client.test.ts`) imports that module FIRST with no token set,
// freezing the const empty for the rest of the process — no amount of
// `process.env.TMDB_API_TOKEN = …` in THIS file's body can undo that once-per-process
// freeze. So the actual assertions run in a freshly-spawned child process (this same
// file, re-invoked with a SEASON_CHECK_TEST_CHILD marker) where TMDB_API_TOKEN is set
// on `env` before the process — and therefore the module — exists at all. Still fully
// hermetic: the child stubs `global.fetch` itself; no live TMDB/Plex call is ever made.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

if (!process.env.SEASON_CHECK_TEST_CHILD) {
  execFileSync(process.execPath, ['--import', 'tsx', import.meta.filename], {
    stdio: 'inherit',
    env: { ...process.env, SEASON_CHECK_TEST_CHILD: '1', TMDB_API_TOKEN: 'test-token' },
  });
} else {
  await runChildAssertions();
}

async function runChildAssertions(): Promise<void> {
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { syncService, updateServiceLimits } = await import('../../../db/store.js');
  const { registerService } = await import('../../../core/services.js');
  const { plexConfig } = await import('../config.js');
  const { ensureDirs } = await import('../lib.js');
  const { runSeasonCheck } = await import('./season-check.js');

  // Redirect this workflow's output paths to a throwaway temp dir BEFORE any stage
  // code runs. `runSeasonCheck`/`writeSnapshot` write plexConfig.snapshotOut /
  // plexConfig.missingOut, which by default resolve to the REAL (gitignored)
  // src/workflows/missing-tv-seasons/data/out — so running the suite locally would
  // otherwise overwrite the owner's live Plex snapshot + missing-seasons output with
  // these test fixtures. The scratch-DB guard protects the DB the same way; this
  // does it for the on-disk artifacts. (plexConfig is a module-singleton mutated per
  // test process — each test file runs in its own process, so this can't leak.)
  const testOut = mkdtempSync(join(tmpdir(), 'missing-tv-season-check-test-'));
  plexConfig.outDir = testOut;
  plexConfig.snapshotOut = join(testOut, 'snapshot.json');
  plexConfig.missingOut = join(testOut, 'missing-seasons.json');
  plexConfig.reportDir = join(testOut, 'reports');

  // `callService('tmdb', ...)` only enforces quota if 'tmdb' is registered in the
  // in-process service registry — normally done by loading the daemon's registry,
  // which this standalone test never does. Register it here (unlimited by default)
  // so Case 4 below can force a real quota via `updateServiceLimits`.
  registerService({ name: 'tmdb' });
  syncService({ name: 'tmdb' });
  type JobContext = import('../../../core/types.js').JobContext;
  type MissingSeasonsFile = import('../types.js').MissingSeasonsFile;
  type PlexShow = import('../types.js').PlexShow;
  type SnapshotFile = import('../types.js').SnapshotFile;

  function fakeCtx(): JobContext {
    return {
      log() {},
      progress() {},
      selectedRoots: () => null,
      rootAllowed: () => true,
    };
  }

  function show(overrides: Partial<PlexShow> = {}): PlexShow {
    return {
      title: 'Some Show',
      year: 2020,
      tmdbId: 1,
      ratingKey: 'r1',
      highestOwnedSeason: 1,
      ...overrides,
    };
  }

  function writeSnapshot(shows: PlexShow[]) {
    ensureDirs();
    const file: SnapshotFile = { generatedAt: new Date().toISOString(), section: '5', shows };
    writeFileSync(plexConfig.snapshotOut, JSON.stringify(file));
  }

  function readMissing(): MissingSeasonsFile {
    return JSON.parse(readFileSync(plexConfig.missingOut, 'utf8')) as MissingSeasonsFile;
  }

  /** A minimal `/tv/{id}` response with no seasons beyond what's owned (no complete-missing). */
  function seriesDetailJson(status = 'Ended') {
    return { status, seasons: [] };
  }

  // ── Case 1: one show's TMDB call fails (non-quota), another succeeds → run THROWS,
  // but the successful show's result is still persisted. ──
  {
    const FAIL_ID = 9001;
    const OK_ID = 9002;
    writeSnapshot([
      show({ title: 'Fails', tmdbId: FAIL_ID, ratingKey: 'f' }),
      show({ title: 'Succeeds', tmdbId: OK_ID, ratingKey: 'o' }),
    ]);

    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      if (String(url).includes(`/tv/${FAIL_ID}`)) {
        return { ok: false, status: 500 } as Response;
      }
      return { ok: true, json: async () => seriesDetailJson() } as Response;
    }) as typeof fetch;

    let threw: unknown;
    try {
      await runSeasonCheck(fakeCtx());
    } catch (err) {
      threw = err;
    } finally {
      global.fetch = originalFetch;
    }

    assert.ok(threw instanceof Error, 'run rejects when a genuine per-show TMDB failure occurred');
    assert.match((threw as Error).message, /1 show\(s\) failed this run.*1 TMDB errors/);

    // Even though the run failed, the successful show's check was still persisted.
    const missing = readMissing();
    assert.equal(missing.unverifiable.length, 0);

    assert.deepEqual(missing.errors?.map((e) => e.title), ['Fails'], 'the errored show is named in the output, so a failed run still says which');

    console.log('  ✓ one bad show + one good show: run throws, what was found is still written, the bad show is named');
  }

  // ── Case 2: all shows succeed → resolves normally. ──
  {
    writeSnapshot([show({ title: 'A', tmdbId: 9101, ratingKey: 'a' }), show({ title: 'B', tmdbId: 9102, ratingKey: 'b' })]);
    const originalFetch = global.fetch;
    global.fetch = (async () => ({ ok: true, json: async () => seriesDetailJson() } as Response)) as typeof fetch;
    try {
      await runSeasonCheck(fakeCtx());
    } finally {
      global.fetch = originalFetch;
    }

    assert.deepEqual(readMissing().errors, [], 'no errors recorded');

    console.log('  ✓ all-success case resolves without throwing');
  }

  // ── Case 3: an unverifiable show (no tmdbId) alongside a successful one → THROWS (unverifiable blocks the run). ──
  {
    writeSnapshot([show({ title: 'No Tmdb', tmdbId: null, ratingKey: 'n' }), show({ title: 'Good', tmdbId: 9201, ratingKey: 'g' })]);
    const originalFetch = global.fetch;
    global.fetch = (async () => ({ ok: true, json: async () => seriesDetailJson() } as Response)) as typeof fetch;
    let threw: unknown;
    try {
      await runSeasonCheck(fakeCtx());
    } catch (err) {
      threw = err;
    } finally {
      global.fetch = originalFetch;
    }
    assert.ok(threw instanceof Error, 'unverifiable show blocks the run');
    assert.match((threw as Error).message, /1 show\(s\) failed this run.*1 unverifiable/);
    const missing = readMissing();
    assert.equal(missing.unverifiable.length, 1, 'the unverifiable show is recorded in the output');

    console.log('  ✓ unverifiable show blocks the run with clear messaging and is listed in the output');
  }

  // ── Case 4: the FIRST tmdb call hits the service's daily quota → soft-stop (break),
  // zero genuine failures → resolves normally. ──
  {
    writeSnapshot([show({ title: 'Quota Hit', tmdbId: 9301, ratingKey: 'q' })]);
    // Force QuotaExceededError on the very first `tmdb` service call via a zero daily
    // cap override (a plain `syncService` daily cap alone would NOT be enforced here —
    // `effectiveLimits` only honours the DB value once `limits_overridden` is set).
    updateServiceLimits('tmdb', { rate_per_minute: null, daily_cap: 0, monthly_cap: null, timeout_ms: null });
    const originalFetch = global.fetch;
    global.fetch = (async () => ({ ok: true, json: async () => seriesDetailJson() } as Response)) as typeof fetch;
    try {
      await runSeasonCheck(fakeCtx());
    } finally {
      global.fetch = originalFetch;
      // Restore the tmdb service to unlimited so it doesn't leak into other tests/processes.
      updateServiceLimits('tmdb', { rate_per_minute: null, daily_cap: null, monthly_cap: null, timeout_ms: null });
    }

    assert.deepEqual(readMissing().errors, [], 'a quota stop is not an error: the show is simply left for the next run');

    console.log('  ✓ quota-only case (soft-stop) resolves without throwing');
  }

  console.log('  ✓ season-check failure-tally tests passed');
}
