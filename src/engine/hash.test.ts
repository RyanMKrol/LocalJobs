// The directory fingerprint, and a directory artifact that shares its directory.
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dirStats } from './hash.js';
import { acceptAny, dirArtifact } from './ports.js';

const dir = () => mkdtempSync(join(tmpdir(), 'lj-hash-'));

test('the fingerprint changes when a file is added, resized or rewritten', () => {
  const d = dir();
  writeFileSync(join(d, 'a.md'), 'one');
  const first = dirStats(d);
  assert.equal(first.files, 1);
  writeFileSync(join(d, 'b.md'), 'two');
  assert.notEqual(dirStats(d).sha256, first.sha256, 'a new file');
  writeFileSync(join(d, 'a.md'), 'one, longer');
  assert.equal(dirStats(d).bytes, 'one, longer'.length + 3);
});

test('a filter limits the fingerprint to the artifact\'s own files: a neighbour being rewritten does not change it', () => {
  const d = dir();
  writeFileSync(join(d, 'report-1.md'), '# one');
  writeFileSync(join(d, 'data.json'), '{}');
  const own = (name: string) => name.endsWith('.md');
  const before = dirStats(d, own);
  assert.equal(before.files, 1, 'the data file is not counted');

  // Another stage rewrites the data file, later.
  writeFileSync(join(d, 'data.json'), '{"changed":true}');
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(d, 'data.json'), later, later);
  const after = dirStats(d, own);
  assert.equal(after.sha256, before.sha256, 'unchanged: nothing of this artifact was touched');
  assert.equal(after.mtimeMs, before.mtimeMs, 'and it was not "written" either');
  assert.notEqual(dirStats(d).sha256, dirStats(d, own).sha256, 'without the filter the neighbour is part of the fingerprint');

  writeFileSync(join(d, 'report-2.md'), '# two');
  assert.notEqual(dirStats(d, own).sha256, before.sha256, 'a new report does change it');
});

test('a directory artifact with `files` lists only its own files', () => {
  const d = dir();
  writeFileSync(join(d, 'report-1.md'), '# one');
  writeFileSync(join(d, 'data.json'), '{}');
  const reports = dirArtifact({ key: 'h-reports', description: 'Reports.', check: acceptAny, files: (n) => n.endsWith('.md') });
  assert.deepEqual(reports.read(d).files, ['report-1.md']);
  const everything = dirArtifact({ key: 'h-all', description: 'All.', check: acceptAny });
  assert.deepEqual(everything.read(d).files, ['data.json', 'report-1.md']);
});
