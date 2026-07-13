// Tiny test runner: finds and runs every `*.test.ts` under src/ and scripts/. Each
// test file self-asserts (throwing or setting process.exitCode on failure). Run
// via `npm test`, which relies on config.ts's isTestEnv/resolveDbPath guard to give
// each process its own per-PID scratch DB (never the real one).
//
// Each test file runs in its OWN child process (`tsx <file>`), not a dynamic
// `import()` in this process. This matters for two reasons:
//   1. node:test's pass/fail reporting (the TAP summary + its `process.exitCode`
//      side effect) happens on that process's OWN exit, asynchronously — NOT as
//      part of the promise returned by `await test(...)` inside the file. A
//      same-process dynamic import can finish importing (and this runner can move
//      on / print its verdict) before node:test's own exit-time bookkeeping has
//      actually landed, so a failing file's exit status can be missed. Isolating
//      each file in its own process makes that file's real `child.exitCode` the
//      single source of truth — read only after the child has genuinely exited.
//   2. A hanging test can be killed outright (SIGKILL) after its own timeout
//      without taking the rest of the suite down with it.
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..');
const tsxBin = resolve(root, 'node_modules', '.bin', 'tsx');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // Never descend into a `data/` folder — job-local output (e.g. projects-sync's
      // repo clones under data/repos/) can itself contain `*.test.ts`-shaped files
      // that must never be mistaken for this repo's own tests.
      if (e.name === 'data') continue;
      out.push(...walk(p));
    } else if (e.name.endsWith('.test.ts') || e.name.endsWith('.test.js')) {
      out.push(p);
    }
  }
  return out;
}

// Per-file wall-clock timeout so a genuinely hanging test fails fast instead of
// riding out the 6h Actions kill. Env-overridable for a slow file if ever needed.
const FILE_TIMEOUT_MS = Number(process.env.LOCALJOBS_TEST_TIMEOUT_MS) || 60_000;

interface FileResult {
  file: string;
  ok: boolean;
  timedOut: boolean;
}

function runFile(file: string): Promise<FileResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(tsxBin, [file], {
      stdio: 'inherit',
      env: { ...process.env, LOCALJOBS_TEST: '1' },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, FILE_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ file, ok: !timedOut && code === 0, timedOut });
    });
  });
}

const files = [...walk(join(root, 'src')), ...walk(join(root, 'scripts'))].sort();
console.log(`Running ${files.length} test file(s)…\n`);

let failed = false;
for (const f of files) {
  console.log(`\x1b[1m── ${f} ──\x1b[0m`);
  const result = await runFile(f);
  if (result.timedOut) {
    console.error(`  ✗ test file timed out after ${FILE_TIMEOUT_MS}ms — killed`);
    failed = true;
  } else if (!result.ok) {
    console.error(`  ✗ test file failed`);
    failed = true;
  }
  console.log('');
}

// Printed — and the process force-exited — only AFTER every child has genuinely
// exited, so this is always the true, final verdict rather than one printed
// while a file's own async reporting was still in flight.
console.log(failed ? '\x1b[31m✗ TESTS FAILED\x1b[0m' : '\x1b[32m✓ all tests passed\x1b[0m');
process.exit(failed ? 1 : 0);
