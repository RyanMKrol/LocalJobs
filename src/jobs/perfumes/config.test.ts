// Regression guard: the perfumes config must stay self-contained — the build
// template is resolved RELATIVE to this job dir (no absolute machine path, no
// external repo), and the in-project template file must exist + be template-shaped.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { perfumesConfig } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const expected = resolve(here, 'profile.template.md');

// Default resolution points at the in-project template, not an external repo.
assert.equal(perfumesConfig.templatePath, expected, 'templatePath should resolve to the in-project profile.template.md');
assert.ok(isAbsolute(perfumesConfig.templatePath), 'templatePath should be a resolved absolute path');
assert.ok(!perfumesConfig.templatePath.includes('perfume-markdown'), 'templatePath must not reference the external perfume-markdown repo');

// The template file the build stage loads actually exists and is template-shaped.
assert.ok(existsSync(perfumesConfig.templatePath), 'in-project template file should exist');
const tpl = readFileSync(perfumesConfig.templatePath, 'utf8');
assert.ok(tpl.startsWith('---'), 'template should start with YAML frontmatter');
assert.ok(tpl.includes('## Sources'), 'template should contain the Sources section the build stage validates');

console.log('  ✓ perfumes template is self-contained (in-project, no external path)');
