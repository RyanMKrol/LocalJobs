// Tests for the stored-path helpers (T447 + the fromStoredPath inverse).
// Pure path math — no DB needed. Self-asserting: throws on failure.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromStoredPath, toStoredPath } from './lib.js';

const workflowsRoot = realpathSync(fileURLToPath(new URL('../../workflows', import.meta.url)));

// In-root absolute path -> root-relative POSIX form, and back to the same absolute.
const abs = resolve(workflowsRoot, 'places', 'data', 'out', 'markdown', 'akoko.md');
const stored = toStoredPath(abs);
assert.equal(stored, 'places/data/out/markdown/akoko.md');
assert.equal(fromStoredPath(stored), abs);

// Round-trip holds even when the stored form contains POSIX slashes on any platform.
assert.equal(fromStoredPath(toStoredPath(abs)), abs);

// Absolute path OUTSIDE the workflows root: toStoredPath leaves it alone
// (defensive), and fromStoredPath passes it through unchanged.
const outside = resolve(sep, 'somewhere', 'else', 'vault', 'note.md');
assert.equal(toStoredPath(outside), outside);
assert.equal(fromStoredPath(outside), outside);

// A non-absolute input to toStoredPath is returned unchanged too.
assert.equal(toStoredPath('already/relative.md'), 'already/relative.md');

console.log('lib.test.ts: ok');
