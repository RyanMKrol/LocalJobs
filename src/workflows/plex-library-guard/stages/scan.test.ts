// Behavioural tests for the guard scan: NO live Plex, NO real pushes. An
// injected plexFetch serves synthetic section listings and an injected push
// captures alerts. The data dir + DB are auto-redirected to scratch under test
// (resolveWorkflowDataDir / the test DB guard). The tests assert the core
// write-ordering invariant: the baseline snapshot is only overwritten after
// the alert path settles.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { existsSync, rmSync } from 'node:fs';
import type { JobContext, LogLevel } from '../../../core/types.js';
import { registerService } from '../../../core/services.js';
import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import { dayKey } from '../../../core/dates.js';
import { plexLibraryGuardConfig } from '../config.js';
import { readSnapshot } from '../lib.js';
import type { GuardEpisodeMeta, GuardMovieMeta, GuardReportFile } from '../types.js';
import { runScan, ALERT_JOB, JOB_NAME } from './scan.js';
import { readJsonFile } from '../../../core/fsjson.js';

const GB = 1024 ** 3;

function fakeCtx(): JobContext & { logs: Array<{ message: string; level?: LogLevel }> } {
  const logs: Array<{ message: string; level?: LogLevel }> = [];
  return {
    logs,
    log(message: string, level?: LogLevel) {
      logs.push({ message, level });
    },
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

function movie(n: number, sizeGb = 1): GuardMovieMeta {
  return { title: `Movie ${n}`, year: 2020, ratingKey: `m${n}`, Media: [{ Part: [{ id: 100 + n, file: `/movies/m${n}.mkv`, size: sizeGb * GB }] }] };
}
function episode(n: number, sizeGb = 1): GuardEpisodeMeta {
  return { title: `Ep ${n}`, grandparentTitle: 'Show', parentIndex: 1, index: n, ratingKey: `e${n}`, Media: [{ Part: [{ id: 200 + n, file: `/tv/e${n}.mkv`, size: sizeGb * GB }] }] };
}

/** plexFetch serving the given fixtures, counting invocations per path. */
function fakePlex(movies: GuardMovieMeta[], episodes: GuardEpisodeMeta[]) {
  const callsByPath = new Map<string, number>();
  const fetch = async <T,>(path: string): Promise<T> => {
    callsByPath.set(path, (callsByPath.get(path) ?? 0) + 1);
    const items = path.includes('type=4') ? episodes : movies;
    return { MediaContainer: { Metadata: items } } as T;
  };
  return { fetch, callsByPath };
}

/** A push recorder; set `ok = false` to simulate ntfy failure. */
function fakePush(ok = true) {
  const calls: Array<{ title: string; body: string; opts: Record<string, unknown> }> = [];
  const push = async (title: string, body: string, opts: Record<string, unknown> = {}) => {
    calls.push({ title, body, opts });
    return ok ? { ok: true as const } : { ok: false as const, error: 'ntfy down' };
  };
  return { push, calls };
}

registerService({ name: 'plex', category: 'api' });

describe('runScan (plex-library-guard)', () => {
  beforeEach(() => {
    rmSync(plexLibraryGuardConfig.snapshotOut, { force: true });
    rmSync(plexLibraryGuardConfig.reportOut, { force: true });
  });

  it('first run seeds the baseline, sends no push, records the day ledger row', async () => {
    const { fetch } = fakePlex([movie(1), movie(2)], [episode(1)]);
    const { push, calls } = fakePush();
    const now = new Date('2026-08-01T10:30:00Z');

    await runScan(fakeCtx(), { now, plexFetch: fetch, push });

    assert.equal(calls.length, 0, 'seeding run never alerts');
    const snap = readSnapshot(plexLibraryGuardConfig.snapshotOut);
    assert.ok(snap, 'baseline written');
    assert.equal(snap.fileCount, 3);
    const report = readJsonFile<GuardReportFile | null>(plexLibraryGuardConfig.reportOut, null);
    assert.ok(report);
    assert.equal(report.firstRun, true);
    assert.equal(report.alerted, false);
    assert.equal(isWorkItemDone(JOB_NAME, dayKey(now), 1), true, 'one ledger row per day');
  });

  it('an unchanged library sends no push and advances the baseline', async () => {
    const { fetch } = fakePlex([movie(1)], [episode(1)]);
    const { push, calls } = fakePush();

    await runScan(fakeCtx(), { now: new Date('2026-08-02T10:30:00Z'), plexFetch: fetch, push });
    await runScan(fakeCtx(), { now: new Date('2026-08-03T10:30:00Z'), plexFetch: fetch, push });

    assert.equal(calls.length, 0);
    const snap = readSnapshot(plexLibraryGuardConfig.snapshotOut);
    assert.equal(snap?.generatedAt, '2026-08-03T10:30:00.000Z', 'baseline advanced to the second run');
  });

  it('a deleted file sends ONE urgent push naming it, marks the alert ledger, and overwrites the baseline', async () => {
    const before = fakePlex([movie(1), movie(2)], [episode(1)]);
    const { push, calls } = fakePush();
    const seedNow = new Date('2026-08-04T10:30:00Z');
    await runScan(fakeCtx(), { now: seedNow, plexFetch: before.fetch, push });

    const after = fakePlex([movie(1)], [episode(1)]); // movie 2 deleted
    await runScan(fakeCtx(), { now: new Date('2026-08-05T10:30:00Z'), plexFetch: after.fetch, push });

    assert.equal(calls.length, 1, 'exactly one combined alert');
    assert.match(calls[0].title, /1 file\(s\) missing/);
    assert.ok(calls[0].body.includes('Movie 2 (2020)'), 'push names the missing title');
    assert.equal(calls[0].opts.priority, 'urgent');
    assert.equal(isWorkItemDone(ALERT_JOB, seedNow.toISOString(), 1), true, 'alert ledger keyed by the previous baseline');
    const snap = readSnapshot(plexLibraryGuardConfig.snapshotOut);
    assert.equal(snap?.fileCount, 2, 'baseline overwritten after the successful alert');
  });

  it('a failed push throws AND leaves the baseline untouched, so the retry re-alerts', async () => {
    const before = fakePlex([movie(1), movie(2)], [episode(1)]);
    const okPush = fakePush();
    const seedNow = new Date('2026-08-06T10:30:00Z');
    await runScan(fakeCtx(), { now: seedNow, plexFetch: before.fetch, push: okPush.push });

    const after = fakePlex([movie(1)], [episode(1)]);
    const badPush = fakePush(false);
    await assert.rejects(
      () => runScan(fakeCtx(), { now: new Date('2026-08-07T10:30:00Z'), plexFetch: after.fetch, push: badPush.push }),
      /Guard alert push failed/,
    );

    assert.equal(badPush.calls.length, 1, 'the push was attempted');
    const snap = readSnapshot(plexLibraryGuardConfig.snapshotOut);
    assert.equal(snap?.generatedAt, seedNow.toISOString(), 'baseline NOT overwritten on push failure');
    assert.equal(isWorkItemDone(ALERT_JOB, seedNow.toISOString(), 1), false, 'alert not marked sent');
  });

  it('an already-alerted baseline is not re-pushed, but the baseline still advances', async () => {
    const before = fakePlex([movie(1), movie(2)], [episode(1)]);
    const { push, calls } = fakePush();
    const seedNow = new Date('2026-08-08T10:30:00Z');
    await runScan(fakeCtx(), { now: seedNow, plexFetch: before.fetch, push });
    markWorkItem(ALERT_JOB, seedNow.toISOString(), 'success', { detail: { name: 'pre-marked (simulates a crash after push)' } });

    const after = fakePlex([movie(1)], [episode(1)]);
    const runNow = new Date('2026-08-09T10:30:00Z');
    await runScan(fakeCtx(), { now: runNow, plexFetch: after.fetch, push });

    assert.equal(calls.length, 0, 'no duplicate push for the same baseline');
    const snap = readSnapshot(plexLibraryGuardConfig.snapshotOut);
    assert.equal(snap?.generatedAt, runNow.toISOString(), 'baseline still advances');
  });

  it('an empty movie read throws before writing anything', async () => {
    const { fetch } = fakePlex([], [episode(1)]);
    const { push, calls } = fakePush();

    await assert.rejects(() => runScan(fakeCtx(), { now: new Date('2026-08-10T10:30:00Z'), plexFetch: fetch, push }), /Empty Plex read/);

    assert.equal(calls.length, 0);
    assert.equal(existsSync(plexLibraryGuardConfig.snapshotOut), false, 'no snapshot written');
    assert.equal(existsSync(plexLibraryGuardConfig.reportOut), false, 'no report written');
  });

  it('a suspected partial read (>50% missing) still alerts but preserves the baseline and fails the run', async () => {
    const movies = Array.from({ length: 11 }, (_, i) => movie(i + 1));
    const before = fakePlex(movies, [episode(1)]); // 12 files
    const { push, calls } = fakePush();
    const seedNow = new Date('2026-08-11T10:30:00Z');
    await runScan(fakeCtx(), { now: seedNow, plexFetch: before.fetch, push });

    const after = fakePlex([movie(1), movie(2)], [episode(1)]); // 9/12 missing = 75%
    await assert.rejects(
      () => runScan(fakeCtx(), { now: new Date('2026-08-12T10:30:00Z'), plexFetch: after.fetch, push }),
      /Suspected partial Plex read/,
    );

    assert.equal(calls.length, 1, 'the alert still fires: mass deletion is the disaster case');
    const snap = readSnapshot(plexLibraryGuardConfig.snapshotOut);
    assert.equal(snap?.generatedAt, seedNow.toISOString(), 'baseline preserved for the next run to re-diff');
    const report = readJsonFile<GuardReportFile | null>(plexLibraryGuardConfig.reportOut, null);
    assert.equal(report?.suspectPartialRead, true);
  });

  it('reads are LIVE: two runs both hit Plex (cache opt-out, inverse of the space-saver cache test)', async () => {
    const { fetch, callsByPath } = fakePlex([movie(1)], [episode(1)]);
    const { push } = fakePush();

    await runScan(fakeCtx(), { now: new Date('2026-08-13T09:00:00Z'), plexFetch: fetch, push });
    await runScan(fakeCtx(), { now: new Date('2026-08-13T10:00:00Z'), plexFetch: fetch, push });

    assert.equal(callsByPath.size, 2, 'two distinct Plex paths (movies + episodes)');
    for (const [path, count] of callsByPath) {
      assert.equal(count, 2, `path "${path}" is fetched on BOTH runs — the guard never reads the response cache`);
    }
  });
});
