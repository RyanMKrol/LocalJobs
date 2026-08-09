// performVerifiedMove tests — in-memory fs, asserting the exact safety ordering.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeMemFs } from './memfs.js';
import { MoveError, performVerifiedMove, PARTIAL_SUFFIX, type MoveStep } from './move.js';

const FROM = '/vol/Movies/Rel/old.mkv';
const TO = '/vol/Movies/New Folder/new.mkv';
const PARTIAL = `${TO}${PARTIAL_SUFFIX}`;

test('verified move: copy → verify → finalize → delete-source, hooks flushed before each effect', async () => {
  const fs = makeMemFs({ [FROM]: 'MOVIE-BYTES', '/vol/Movies/marker': 'x' });
  const seq: string[] = [];
  const hooks = {
    async before(step: MoveStep) {
      seq.push(`before:${step}`);
    },
    async after(step: MoveStep) {
      seq.push(`after:${step}`);
    },
  };
  // Interleave the fs oplog into the same sequence via a proxy-ish trick: record marks around ops.
  const origCopy = fs.copyStreamHashed.bind(fs);
  fs.copyStreamHashed = async (s, d) => {
    seq.push('fs:copy');
    return origCopy(s, d);
  };
  const origRename = fs.rename.bind(fs);
  fs.rename = async (a, b) => {
    seq.push('fs:finalize-rename');
    return origRename(a, b);
  };
  const origUnlink = fs.unlink.bind(fs);
  fs.unlink = async (p) => {
    seq.push(`fs:unlink:${p === FROM ? 'source' : 'other'}`);
    return origUnlink(p);
  };

  const result = await performVerifiedMove(fs, { from: FROM, to: TO, expectedBytes: 'MOVIE-BYTES'.length }, hooks);
  assert.equal(fs.files.get(TO), 'MOVIE-BYTES', 'bytes arrived at the target');
  assert.equal(fs.files.has(FROM), false, 'source deleted only at the very end');
  assert.equal(fs.files.has(PARTIAL), false, 'no partial left behind');
  assert.ok(result.sha256.length === 64 && result.bytes === 'MOVIE-BYTES'.length);

  assert.deepEqual(seq, [
    'before:copy',
    'fs:copy',
    'after:copy',
    'before:verify',
    'after:verify',
    'before:finalize',
    'fs:finalize-rename',
    'after:finalize',
    'before:delete-source',
    'fs:unlink:source',
    'after:delete-source',
  ], 'every journal hook fires BEFORE its filesystem effect; delete-source is strictly last');
});

test('verified move: checksum mismatch deletes the BAD COPY, never the source', async () => {
  const fs = makeMemFs({ [FROM]: 'MOVIE-BYTES' }, { corruptCopies: true });
  await assert.rejects(
    performVerifiedMove(fs, { from: FROM, to: TO }),
    (err: unknown) => err instanceof MoveError && err.step === 'verify',
    'fails at the verify step',
  );
  assert.equal(fs.files.get(FROM), 'MOVIE-BYTES', 'source untouched');
  assert.equal(fs.files.has(PARTIAL), false, 'corrupt partial cleaned up');
  assert.equal(fs.files.has(TO), false, 'nothing ever landed under the final name');
});

test('verified move: preflight gates — missing source, size drift, occupied target, stale partial', async () => {
  await assert.rejects(
    performVerifiedMove(makeMemFs({}), { from: FROM, to: TO }),
    (e: unknown) => e instanceof MoveError && e.step === 'preflight' && /source missing/.test(e.message),
  );
  await assert.rejects(
    performVerifiedMove(makeMemFs({ [FROM]: 'XX' }), { from: FROM, to: TO, expectedBytes: 999 }),
    (e: unknown) => e instanceof MoveError && /size/.test(e.message),
    'size drift since verify is a hard stop',
  );
  await assert.rejects(
    performVerifiedMove(makeMemFs({ [FROM]: 'XX', [TO]: 'OCCUPIED' }), { from: FROM, to: TO }),
    (e: unknown) => e instanceof MoveError && /never overwritten/.test(e.message),
  );
  await assert.rejects(
    performVerifiedMove(makeMemFs({ [FROM]: 'XX', [PARTIAL]: 'DEBRIS' }), { from: FROM, to: TO }),
    (e: unknown) => e instanceof MoveError && /stale partial/.test(e.message),
  );
});

test('verified move: caseOnly swaps the last two steps (delete-source before finalize)', async () => {
  // On a case-insensitive fs the memfs can't truly model aliasing, but the
  // ORDER is what matters: the verified partial must exist when the source is
  // deleted, and finalize runs last.
  const from = '/vol/Movies/M/movie.mkv';
  const to = '/vol/Movies/M/Movie.mkv';
  const fs = makeMemFs({ [from]: 'BYTES', '/vol/Movies/M/keep': 'x' });
  const steps: string[] = [];
  await performVerifiedMove(
    fs,
    { from, to, caseOnly: true },
    {
      async before(step) {
        steps.push(step);
      },
    },
  );
  assert.deepEqual(steps, ['copy', 'verify', 'delete-source', 'finalize']);
  assert.equal(fs.files.get(to), 'BYTES');
  assert.equal(fs.files.has(`${to}${PARTIAL_SUFFIX}`), false);
});
