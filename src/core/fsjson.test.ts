import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDirs, readJsonFile, writeJsonFile } from './fsjson.js';

test('readJsonFile returns the fallback when the file is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsjson-test-'));
  try {
    const missing = join(dir, 'nope.json');
    assert.deepEqual(readJsonFile(missing, { ok: true }), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJsonFile / readJsonFile round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsjson-test-'));
  try {
    const file = join(dir, 'data.json');
    const data = { a: 1, b: ['x', 'y'], c: { nested: true } };
    writeJsonFile(file, data);
    assert.deepEqual(readJsonFile(file, null), data);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureDirs creates every directory passed, including nested paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsjson-test-'));
  try {
    const a = join(dir, 'a');
    const b = join(dir, 'nested', 'b');
    ensureDirs(a, b);
    // A subsequent read/write round-trip inside each dir confirms it really exists.
    writeJsonFile(join(a, 'f.json'), { in: 'a' });
    writeJsonFile(join(b, 'f.json'), { in: 'b' });
    assert.deepEqual(readJsonFile(join(a, 'f.json'), null), { in: 'a' });
    assert.deepEqual(readJsonFile(join(b, 'f.json'), null), { in: 'b' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
