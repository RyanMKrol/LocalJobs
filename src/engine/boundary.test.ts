// The engine is an isolated package in all but name: this test keeps it so.
//
// No file under `src/engine/` may import anything outside the engine except its
// persistence layer (`src/db/`) and process configuration (`src/config.ts`). In
// particular it must never import a workflow, a service, the job registry, the
// API or the notifier: the application reaches the engine through
// `configureEngine` (host.ts), never the other way round. That one-way rule is
// what lets the engine be exercised end to end with fixture stages and nothing
// else loaded, and what makes its guarantees reasoned about in one place.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const engineDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(engineDir, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? tsFiles(p) : e.name.endsWith('.ts') ? [p] : [];
  });
}

/** Every module specifier a file imports or re-exports from. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Where a relative import lands, as a path under src/ (e.g. "db/store.js"). */
const landing = (file: string, spec: string): string => relative(srcDir, resolve(dirname(file), spec));

const ALLOWED_OUTSIDE = [/^db\//, /^config\.js$/];

test('no engine file imports outside the engine, except src/db and src/config', () => {
  const violations: string[] = [];
  const self = fileURLToPath(import.meta.url); // its sample source below would trip the scan
  for (const file of tsFiles(engineDir).filter((f) => f !== self)) {
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue; // node: builtins and npm packages
      const to = landing(file, spec);
      if (to.startsWith('engine/')) continue;
      if (ALLOWED_OUTSIDE.some((re) => re.test(to))) continue;
      violations.push(`${relative(srcDir, file)} imports ${spec} (src/${to})`);
    }
  }
  assert.deepEqual(violations, [], `the engine must not depend on the application:\n${violations.join('\n')}`);
});

test('the checker itself recognises the import forms it needs to', () => {
  const src = `
    import a from './a.js';
    import type { B } from "../b.js";
    export { c } from '../../c.js';
    export * from './d.js';
    const e = await import('../e.js');
    import 'dotenv/config';
  `;
  assert.deepEqual(specifiers(src), ['./a.js', '../b.js', '../../c.js', './d.js', '../e.js', 'dotenv/config']);
});
