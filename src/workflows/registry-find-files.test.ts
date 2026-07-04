// Hermetic regression test for the `data/` exclusion in `findFiles` (registry.ts).
// Uses a synthetic temp directory tree, never the real (transient, gitignored)
// `src/workflows/**/data/` contents — a workflow's generated output (e.g.
// projects-sync's repo clones) must never be mistaken for live job/workflow code.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFiles } from './registry.js';

const root = mkdtempSync(join(tmpdir(), 'registry-find-files-'));
try {
  // A real job file, directly under the scanned root.
  mkdirSync(join(root, 'stocks-sync'), { recursive: true });
  writeFileSync(join(root, 'stocks-sync', 'real.job.ts'), '// real');

  // A shadow copy nested inside a `data/` folder — mirrors a workflow's own
  // generated output containing a stray job-shaped file (e.g. a cloned repo).
  mkdirSync(join(root, 'stocks-sync', 'data', 'repos', 'Cloned', 'stocks-sync'), { recursive: true });
  writeFileSync(
    join(root, 'stocks-sync', 'data', 'repos', 'Cloned', 'stocks-sync', 'shadow.job.ts'),
    '// shadow — must never be discovered',
  );

  const found = findFiles(root, (f) => f.endsWith('.job.ts'));
  assert.equal(found.length, 1, 'only the real job file should be discovered, never one under data/');
  assert.ok(found[0].endsWith('real.job.ts'), 'the discovered file should be the real one');
  assert.ok(!found[0].includes(`${join('data', 'repos')}`), 'no file under data/ should ever be discovered');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('  ✓ findFiles never descends into a data/ directory');
