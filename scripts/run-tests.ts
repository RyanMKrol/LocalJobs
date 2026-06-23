// Tiny test runner: finds and runs every `*.test.ts` under src/. Each test file
// self-asserts (throwing or setting process.exitCode on failure). Run via `npm test`,
// which points LOCALJOBS_DB at a scratch DB so DB-touching tests don't hit the real one.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Defence-in-depth: mark this as a test process BEFORE any test file (and thus the
// DB/config) is dynamically imported below, so config.ts's guard refuses the
// production DB even if this runner is invoked without `LOCALJOBS_DB` set.
process.env.LOCALJOBS_TEST = '1';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.test.ts') || e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

const files = walk('src').sort();
console.log(`Running ${files.length} test file(s)…\n`);
for (const f of files) {
  console.log(`\x1b[1m── ${f} ──\x1b[0m`);
  try {
    await import(pathToFileURL(f).href);
  } catch (e) {
    console.error(`  ✗ test file threw: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
  console.log('');
}
console.log(process.exitCode ? '\x1b[31m✗ TESTS FAILED\x1b[0m' : '\x1b[32m✓ all tests passed\x1b[0m');
