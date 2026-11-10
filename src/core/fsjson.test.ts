import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDirs, readJsonFile, writeFileAtomic, writeJsonFile } from './fsjson.js';

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

test('readJsonFile names the file when it exists but does not parse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsjson-test-'));
  try {
    const file = join(dir, 'broken.json');
    writeFileSync(file, '{ "truncated": ');
    assert.throws(() => readJsonFile(file, null), (e: Error) => e.message.includes(file) && /not valid JSON/.test(e.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic replaces the target whole and leaves no temp file behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsjson-test-'));
  try {
    const file = join(dir, 'out.json');
    writeJsonFile(file, { v: 1 });
    writeJsonFile(file, { v: 2 });
    assert.deepEqual(readJsonFile(file, null), { v: 2 });
    assert.deepEqual(readdirSync(dir), ['out.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed atomic write leaves the previous file intact and cleans up its temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsjson-test-'));
  try {
    const file = join(dir, 'keep.json');
    writeJsonFile(file, { v: 'original' });
    // A directory at the target path makes the final rename fail.
    const blocked = join(dir, 'blocked');
    mkdirSync(join(blocked, 'child'), { recursive: true });
    assert.throws(() => writeFileAtomic(blocked, 'x'));
    assert.deepEqual(readJsonFile(file, null), { v: 'original' });
    assert.deepEqual(readdirSync(dir).sort(), ['blocked', 'keep.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
