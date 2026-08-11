// apply.ts tests — in-memory disk seam, real journals in temp dirs, injected quota/Plex fakes.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { JobContext } from '../../../core/types.js';
import { getWorkItem } from '../../../db/store.js';
import { analyzeJournal, findLatestJournal, JournalWriter, readJournal } from '../journal.js';
import { makeMemFs, type MemFsOptions } from '../memfs.js';
import type { DiscoverDetail, PathMapPair, VerifyDetail } from '../types.js';
import { runApply, type ApplyOverrides } from './apply.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

const MAP: PathMapPair[] = [
  { plex: '/volume1/Share', local: '/Volumes/Share' },
  { plex: '/volume2/Share2', local: '/Volumes/Share2' },
];
const NOW = new Date('2026-08-09T05:00:00.000Z');
const MOUNT = { '/Volumes/Share/Movies/.marker': 'x' };
const MOUNT2 = { '/Volumes/Share2/Movies/.marker': 'x' };

let keyCounter = 0;

function candidate(
  over: Partial<VerifyDetail> = {},
  kind: 'movie' | 'episode' = 'movie',
  opts: { crossShare?: boolean } = {},
) {
  const n = ++keyCounter;
  const from = over.from ?? `/volume1/Share/Movies/Rel${n}/old${n}.mkv`;
  const targetShare = opts.crossShare ? '/volume2/Share2' : '/volume1/Share';
  const to = over.to ?? `${targetShare}/Movies/Movie ${n} (2016) {tmdb-${n}}/Movie ${n} (2016) {tmdb-${n}}.mkv`;
  const itemKey = `m${n}::part${n}`;
  const verify: VerifyDetail = {
    name: `Movie ${n}`,
    eligible: true,
    from,
    to,
    localFrom: from.replace('/volume1/Share', '/Volumes/Share'),
    localTo: to.replace('/volume1/Share', '/Volumes/Share').replace('/volume2/Share2', '/Volumes/Share2'),
    bytes: 11,
    sidecars: [],
    leftBehind: [],
    ...over,
  };
  const discover = { itemKey, detail: { kind } as DiscoverDetail };
  return { itemKey, verify, discover, from, to };
}

interface Env {
  overrides: ApplyOverrides;
  journalDir: string;
  reportDir: string;
  refreshes: [string | number, string | undefined][];
  usage: { count: number };
  butlerCalls: { count: number };
}

function makeEnv(
  fs: ReturnType<typeof makeMemFs>,
  rows: { itemKey: string; verify: VerifyDetail; discover: { itemKey: string; detail: DiscoverDetail } }[],
  over: Partial<ApplyOverrides> = {},
): Env {
  const journalDir = mkdtempSync(join(tmpdir(), 'plex-rename-journal-'));
  const reportDir = mkdtempSync(join(tmpdir(), 'plex-rename-report-'));
  const refreshes: [string | number, string | undefined][] = [];
  const usage = { count: 0 };
  const butlerCalls = { count: 0 };
  return {
    journalDir,
    reportDir,
    refreshes,
    usage,
    butlerCalls,
    overrides: {
      fs,
      readVerifyRows: () => rows.map((r) => ({ itemKey: r.itemKey, detail: r.verify })),
      readDiscoverRows: () => rows.map((r) => r.discover),
      pathMap: MAP,
      applyEnabled: true,
      maxPerDay: 30,
      minAgeDays: 7,
      journalDir,
      reportDir,
      triggerBackup: async () => {
        butlerCalls.count++;
        return { ok: true };
      },
      refreshSection: async (section, path) => {
        refreshes.push([section, path]);
      },
      cap: () => ({ allowed: true, reason: '', today: 0, month: 0, dayLeft: 30, monthLeft: 900 }),
      record: () => {
        usage.count++;
      },
      now: () => NOW,
      ...over,
    },
  };
}

test('apply happy path (cross-share): verified copy + sidecar + journal + ledger + report + refresh + quota tick', async () => {
  const c = candidate(
    {
      sidecars: [
        {
          from: '/volume1/Share/Movies/RelX/oldX.en.srt',
          to: '/volume1/Share/Movies/Target/Target.en.srt',
          role: 'sidecar',
        },
      ],
      plexmatch: undefined,
    },
    'movie',
    { crossShare: true },
  );
  c.verify.sidecars = [
    { from: c.from.replace('.mkv', '.en.srt'), to: c.to.replace('.mkv', '.en.srt'), role: 'sidecar' },
  ];
  const fs = makeMemFs({
    ...MOUNT,
    ...MOUNT2,
    [c.verify.localFrom!]: 'MOVIE-BYTES',
    [c.verify.localFrom!.replace('.mkv', '.en.srt')]: 'SUBTITLE',
  });
  const env = makeEnv(fs, [c]);
  await runApply(fakeCtx(), env.overrides);

  assert.equal(fs.files.get(c.verify.localTo!), 'MOVIE-BYTES', 'media at target');
  assert.equal(fs.files.get(c.verify.localTo!.replace('.mkv', '.en.srt')), 'SUBTITLE', 'sidecar in lockstep');
  assert.equal(fs.files.has(c.verify.localFrom!), false, 'original gone (only after verify)');

  const ledger = getWorkItem('plex-rename-apply', c.itemKey);
  assert.equal(ledger?.status, 'success');
  const detail = JSON.parse(ledger!.detail!);
  assert.equal(detail.to, c.to);
  assert.ok(detail.sha256.length === 64, 'verified hash recorded');

  const journalPath = findLatestJournal(env.journalDir)!;
  const analysis = analyzeJournal(readJournal(journalPath));
  assert.equal(analysis.hasRunEnd, true);
  assert.equal(analysis.items[0].outcome, 'complete');

  assert.equal(env.usage.count, 1, 'one quota tick per media file (sidecars uncounted)');
  assert.equal(env.butlerCalls.count, 1, 'Butler once per run');
  assert.ok(env.refreshes.length >= 1, 'targeted Plex refresh issued');
  assert.ok(readdirSync(env.reportDir).some((f) => f.startsWith('rename-report-')), 'report written');
});

test('same-share move: atomic rename — no copy, no partial, no hash, space checks skipped', async () => {
  const c = candidate(); // default candidate is same-share
  const fs = makeMemFs(
    { ...MOUNT, [c.verify.localFrom!]: 'BYTES-11!!!' },
    // A nearly-full volume: a copy would trip the 92% overburden guard, but a
    // rename consumes no space and must proceed regardless.
    { freeBytes: 500_000_000, totalBytes: 30_000_000_000 },
  );
  const env = makeEnv(fs, [c], { maxVolumeUtilizationPct: 92 });
  await runApply(fakeCtx(), env.overrides);

  const ledger = getWorkItem('plex-rename-apply', c.itemKey);
  assert.equal(ledger?.status, 'success', 'renamed despite the full volume — no bytes copied');
  assert.equal(JSON.parse(ledger!.detail!).sha256, '', 'no hash recorded — the bytes were never rewritten');
  assert.equal(fs.files.get(c.verify.localTo!), 'BYTES-11!!!');
  assert.equal(fs.files.has(c.verify.localFrom!), false);
  assert.ok(!fs.oplog.some((o) => o.startsWith('copy:')), 'no copy op at all');
  assert.ok(fs.oplog.some((o) => o.startsWith(`rename:${c.verify.localFrom}`)), 'a single atomic rename');

  const analysis = analyzeJournal(readJournal(findLatestJournal(env.journalDir)!));
  assert.equal(analysis.items[0].outcome, 'complete', 'journal completion detection handles the rename strategy');
});

test('emptied nested release wrappers are removed up the ancestor chain, stopping at the library root', async () => {
  // The Mr Robot husk shape: TV/Wrapper S01-S04/Season S02/file.mkv — moving
  // the only file out must remove Season S02 AND the outer wrapper, but never
  // the TV library root itself.
  const from = '/volume1/Share/TV/Wrapper S01-S04 REMUX [RiCK]/Season S02/old.mkv';
  const c = candidate({ from });
  c.verify.localFrom = from.replace('/volume1/Share', '/Volumes/Share');
  c.discover.detail = { kind: 'episode', rootPath: '/volume1/Share/TV' } as DiscoverDetail;
  const fs = makeMemFs({
    '/Volumes/Share/TV/.marker': 'x', // keeps the TV root non-empty + mount healthy
    ...MOUNT,
    [c.verify.localFrom!]: 'BYTES-11!!!',
  });
  const env = makeEnv(fs, [c]);
  await runApply(fakeCtx(), env.overrides);

  assert.equal(getWorkItem('plex-rename-apply', c.itemKey)?.status, 'success');
  const rmdirs = fs.oplog.filter((o) => o.startsWith('rmdir-if-empty:'));
  assert.ok(rmdirs.includes('rmdir-if-empty:/Volumes/Share/TV/Wrapper S01-S04 REMUX [RiCK]/Season S02'), 'immediate parent removed');
  assert.ok(rmdirs.includes('rmdir-if-empty:/Volumes/Share/TV/Wrapper S01-S04 REMUX [RiCK]'), 'empty OUTER wrapper removed too');
  assert.ok(!rmdirs.includes('rmdir-if-empty:/Volumes/Share/TV'), 'the library root is NEVER touched');
  const st = await fs.stat('/Volumes/Share/TV/Wrapper S01-S04 REMUX [RiCK]');
  assert.equal(st, null, 'the husk is gone from disk');
});

test('rehearsal mode (apply disabled): report only — no journal, no marks, no mutations, no Butler', async () => {
  const c = candidate();
  const fs = makeMemFs({ ...MOUNT, [c.verify.localFrom!]: 'MOVIE-BYTES' });
  const env = makeEnv(fs, [c], { applyEnabled: false });
  const before = new Map(fs.files);
  await runApply(fakeCtx(), env.overrides);

  assert.deepEqual(fs.files, before, 'nothing on disk changed');
  assert.equal(getWorkItem('plex-rename-apply', c.itemKey), undefined, 'nothing marked');
  assert.equal(findLatestJournal(env.journalDir), null, 'NO journal — a journal always means real intent');
  assert.equal(env.butlerCalls.count, 0);
  assert.equal(env.usage.count, 0);
  assert.ok(readdirSync(env.reportDir).some((f) => f.startsWith('rename-report-')), 'REPORT-ONLY report written');
});

test('mount absent: zero mutations, zero marks, run succeeds (routine skip)', async () => {
  const c = candidate();
  const fs = makeMemFs({ '/SomewhereElse/x': 'y' }); // the share simply is not there
  const env = makeEnv(fs, [c]);
  await runApply(fakeCtx(), env.overrides); // must not throw
  assert.equal(getWorkItem('plex-rename-apply', c.itemKey), undefined);
  assert.equal(findLatestJournal(env.journalDir), null);
  assert.equal(env.butlerCalls.count, 0);
});

test('daily quota: batch capped to the remaining budget; exhausted quota stops gracefully', async () => {
  const c1 = candidate();
  const c2 = candidate();
  const c3 = candidate();
  const files: Record<string, string> = { ...MOUNT };
  for (const c of [c1, c2, c3]) files[c.verify.localFrom!] = 'BYTES-11!!!';
  const fs = makeMemFs(files);
  const env = makeEnv(fs, [c1, c2, c3], {
    cap: () => ({ allowed: true, reason: '', today: 28, month: 100, dayLeft: 2, monthLeft: 800 }),
  });
  await runApply(fakeCtx(), env.overrides);
  const appliedCount = [c1, c2, c3].filter((c) => getWorkItem('plex-rename-apply', c.itemKey)?.status === 'success').length;
  assert.equal(appliedCount, 2, 'only the remaining daily budget was spent');
  assert.equal(env.usage.count, 2);

  const c4 = candidate();
  const fs2 = makeMemFs({ ...MOUNT, [c4.verify.localFrom!]: 'BYTES-11!!!' });
  const env2 = makeEnv(fs2, [c4], {
    cap: () => ({ allowed: false, reason: 'daily cap reached (30/30)', today: 30, month: 100, dayLeft: 0, monthLeft: 800 }),
  });
  await runApply(fakeCtx(), env2.overrides);
  assert.equal(getWorkItem('plex-rename-apply', c4.itemKey), undefined, 'nothing applied on an exhausted quota');
  assert.equal(env2.butlerCalls.count, 0);
});

test('per-run batch cap: each trigger applies at most maxPerRun, daily quota still the ceiling', async () => {
  const cs = [candidate(), candidate(), candidate()];
  const files: Record<string, string> = { ...MOUNT };
  for (const c of cs) files[c.verify.localFrom!] = 'BYTES-11!!!';
  const fs = makeMemFs(files);
  const env = makeEnv(fs, cs, {
    maxPerRun: 2,
    cap: () => ({ allowed: true, reason: '', today: 0, month: 0, dayLeft: 30, monthLeft: 900 }),
  });
  await runApply(fakeCtx(), env.overrides);
  const applied = cs.filter((c) => getWorkItem('plex-rename-apply', c.itemKey)?.status === 'success').length;
  assert.equal(applied, 2, 'the per-run cap bounds the batch');

  // The daily quota still wins when smaller than the per-run cap.
  const c4 = candidate();
  const fs2 = makeMemFs({ ...MOUNT, [c4.verify.localFrom!]: 'BYTES-11!!!' });
  const env2 = makeEnv(fs2, [c4], {
    maxPerRun: 1000,
    cap: () => ({ allowed: false, reason: 'daily cap reached', today: 30, month: 100, dayLeft: 0, monthLeft: 800 }),
  });
  await runApply(fakeCtx(), env2.overrides);
  assert.equal(getWorkItem('plex-rename-apply', c4.itemKey), undefined, 'exhausted daily quota still halts');
});

test('moment-of-truth re-checks soft-skip (never fail) on drift: size change, target appeared', async () => {
  const cSize = candidate();
  const cTarget = candidate();
  const fs = makeMemFs({
    ...MOUNT,
    [cSize.verify.localFrom!]: 'WRONG-SIZE-NOW', // ≠ verified bytes (11)
    [cTarget.verify.localFrom!]: 'BYTES-11!!!',
    [cTarget.verify.localTo!]: 'OCCUPIED',
  });
  const env = makeEnv(fs, [cSize, cTarget]);
  await runApply(fakeCtx(), env.overrides); // soft-skips must not throw
  assert.equal(getWorkItem('plex-rename-apply', cSize.itemKey)?.status, 'skipped');
  assert.equal(getWorkItem('plex-rename-apply', cTarget.itemKey)?.status, 'skipped');
  assert.equal(fs.files.get(cTarget.verify.localTo!), 'OCCUPIED', 'occupied target untouched');
});

test('volume-overburden guard: a move that would push the target volume past the cap soft-skips', async () => {
  // Under the cap: volume 60% used with plenty of free space → the move proceeds.
  const cUnder = candidate({}, 'movie', { crossShare: true });
  const fsUnder = makeMemFs(
    { ...MOUNT, ...MOUNT2, [cUnder.verify.localFrom!]: 'BYTES-11!!!' },
    { freeBytes: 4_000_000_000, totalBytes: 10_000_000_000 },
  );
  const envUnder = makeEnv(fsUnder, [cUnder], { maxVolumeUtilizationPct: 92 });
  await runApply(fakeCtx(), envUnder.overrides);
  assert.equal(getWorkItem('plex-rename-apply', cUnder.itemKey)?.status, 'success', 'under the cap the move proceeds');

  // Over the cap: volume already 93.3% used (free 2GB of 30GB, still above the
  // absolute margin) → the move halts as a soft skip and nothing is touched.
  const cBlocked = candidate({}, 'movie', { crossShare: true });
  const fsBlocked = makeMemFs(
    { ...MOUNT, ...MOUNT2, [cBlocked.verify.localFrom!]: 'BYTES-11!!!' },
    { freeBytes: 2_000_000_000, totalBytes: 30_000_000_000 },
  );
  const envBlocked = makeEnv(fsBlocked, [cBlocked], { maxVolumeUtilizationPct: 92 });
  await runApply(fakeCtx(), envBlocked.overrides);
  const row = getWorkItem('plex-rename-apply', cBlocked.itemKey);
  assert.equal(row?.status, 'skipped', 'over the cap the move halts as a soft skip');
  assert.match(JSON.parse(row!.detail!).reason, /utilization/);
  assert.equal(fsBlocked.files.get(cBlocked.verify.localFrom!), 'BYTES-11!!!', 'nothing moved');
});

test('checksum mismatch (cross-share copy): item fails, original untouched, run throws', async () => {
  const c = candidate({}, 'movie', { crossShare: true });
  const fs = makeMemFs({ ...MOUNT, ...MOUNT2, [c.verify.localFrom!]: 'BYTES-11!!!' }, { corruptCopies: true } as MemFsOptions);
  const env = makeEnv(fs, [c]);
  await assert.rejects(runApply(fakeCtx(), env.overrides), /1 item\(s\) failed/);
  assert.equal(fs.files.get(c.verify.localFrom!), 'BYTES-11!!!', 'original untouched');
  assert.equal(fs.files.has(c.verify.localTo!), false);
  assert.equal(getWorkItem('plex-rename-apply', c.itemKey)?.status, 'failed');
  const analysis = analyzeJournal(readJournal(findLatestJournal(env.journalDir)!));
  assert.equal(analysis.items[0].outcome, 'aborted', 'journal records the abort');
});

test('once-ever: an applied item is never re-touched by a second run', async () => {
  const c = candidate();
  const fs = makeMemFs({ ...MOUNT, [c.verify.localFrom!]: 'BYTES-11!!!' });
  const env = makeEnv(fs, [c]);
  await runApply(fakeCtx(), env.overrides);
  assert.equal(env.usage.count, 1);

  // Second run: same verify rows still say eligible — the apply ledger must protect it.
  fs.files.set(c.verify.localFrom!, 'BYTES-11!!!'); // even if a file reappears at the old path
  await runApply(fakeCtx(), env.overrides);
  assert.equal(env.usage.count, 1, 'no second application, ever');
});

test('crash reconciliation: target-only rolls forward; both-equal deletes source; both-differ fails loud', async () => {
  const cFwd = candidate();
  const cDup = candidate();
  const cBad = candidate();
  const journalDir = mkdtempSync(join(tmpdir(), 'plex-rename-journal-'));

  // Hand-author the "previous run's" journal: three planned items, none terminal.
  const w = new JournalWriter(journalDir, new Date('2026-08-08T05:00:00Z'));
  const planItem = (c: ReturnType<typeof candidate>, opIdxDone: string[]) => {
    w.append({ kind: 'item-planned', at: 'x', itemKey: c.itemKey, ratingKey: 'r', partId: 1, title: c.verify.name, from: c.from, to: c.to, ops: [
      { op: 'mkdir', path: c.verify.localTo!.slice(0, c.verify.localTo!.lastIndexOf('/')) },
      { op: 'move', from: c.verify.localFrom!, to: c.verify.localTo!, partial: `${c.verify.localTo}.plexrename-partial`, role: 'media', bytes: 11 },
      { op: 'rmdir-if-empty', path: c.verify.localFrom!.slice(0, c.verify.localFrom!.lastIndexOf('/')) },
    ] });
    w.append({ kind: 'op-done', at: 'x', itemKey: c.itemKey, opIndex: 0 });
    for (const step of opIdxDone) w.append({ kind: 'op-done', at: 'x', itemKey: c.itemKey, opIndex: 1, step: step as never });
  };
  planItem(cFwd, ['copy', 'verify', 'finalize']); // crashed between finalize and delete... but source already gone
  planItem(cDup, ['copy', 'verify', 'finalize']); // crashed with BOTH present, identical
  planItem(cBad, ['copy', 'verify', 'finalize']); // crashed with BOTH present, DIVERGENT
  w.close();

  const fs = makeMemFs({
    ...MOUNT,
    [cFwd.verify.localTo!]: 'BYTES-11!!!', // source gone, target present → roll forward
    [cDup.verify.localFrom!]: 'BYTES-11!!!',
    [cDup.verify.localTo!]: 'BYTES-11!!!', // identical duplicate → delete source
    [cBad.verify.localFrom!]: 'BYTES-11!!!',
    [cBad.verify.localTo!]: 'DIVERGENT!!', // divergent → fail loud
  });
  const env = makeEnv(fs, [], { journalDir }); // no NEW candidates — reconciliation only
  await assert.rejects(runApply(fakeCtx(), env.overrides), /1 item\(s\) failed/);

  assert.equal(getWorkItem('plex-rename-apply', cFwd.itemKey)?.status, 'success', 'rolled forward to completion');
  assert.equal(getWorkItem('plex-rename-apply', cDup.itemKey)?.status, 'success', 'verified duplicate resolved');
  assert.equal(fs.files.has(cDup.verify.localFrom!), false, 'duplicate source deleted only after hash equality');
  assert.equal(getWorkItem('plex-rename-apply', cBad.itemKey)?.status, 'failed', 'divergence fails loud');
  assert.equal(fs.files.get(cBad.verify.localFrom!), 'BYTES-11!!!', 'divergent source untouched');
  assert.equal(fs.files.get(cBad.verify.localTo!), 'DIVERGENT!!', 'divergent target untouched');
  assert.equal(env.usage.count, 2, 'reconciled completions tick the quota');
});

test('full-section refresh fallback past the changed-dir cap', async () => {
  const cands = Array.from({ length: 16 }, () => candidate());
  const files: Record<string, string> = { ...MOUNT };
  for (const c of cands) files[c.verify.localFrom!] = 'BYTES-11!!!';
  const fs = makeMemFs(files);
  const env = makeEnv(fs, cands);
  await runApply(fakeCtx(), env.overrides);
  // 16 items × 2 dirs each = 32 distinct dirs > 30 → exactly the two full-section refreshes.
  assert.equal(env.refreshes.length, 2, 'fell back to full-section refreshes');
  assert.ok(env.refreshes.every(([, path]) => path === undefined));
});

test('journal file existence always means real intent (none for a no-op run)', async () => {
  const env = makeEnv(makeMemFs({ ...MOUNT }), []);
  await runApply(fakeCtx(), env.overrides);
  assert.equal(findLatestJournal(env.journalDir), null);
  assert.equal(env.butlerCalls.count, 0, 'no Butler for a run with nothing to do');
  assert.equal(existsSync(env.journalDir), true);
});
