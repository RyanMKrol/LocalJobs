// End-to-end tests for the vault-sync export stage: scratch DB (guarded by
// isTestEnv) + temp source/vault dirs. Self-asserting: throws on failure.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JobContext } from '../../../core/types.js';
import { db } from '../../../db/index.js';
import { getWorkItem, markWorkItem, syncJob } from '../../../db/store.js';
import { JOB_NAME, exportKeyFor, runVaultExport } from './export.js';

const ctx: JobContext = { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };

const srcDir = mkdtempSync(join(tmpdir(), 'vault-sync-src-'));
const vaultDir = mkdtempSync(join(tmpdir(), 'vault-sync-vault-'));

const SOURCES = ['enrich-with-llm', 'perfumes-build', 'plex-profiles-build', 'lastfm-digest', 'workouts-progress'] as const;
for (const name of SOURCES) syncJob({ name, run: async () => {} });
syncJob({ name: JOB_NAME, run: async () => {} });

function seedFile(rel: string, content: string): string {
  const abs = join(srcDir, rel);
  writeFileSync(abs, content);
  return abs;
}

/** Force a source row's updated_at to a distinct value (datetime('now') is second-granular). */
function bumpUpdatedAt(jobName: string, itemKey: string, ts: string): void {
  db.prepare('UPDATE work_items SET updated_at = ? WHERE job_name = ? AND item_key = ?').run(ts, jobName, itemKey);
}

// ── Seed the five sources (paths are OUTSIDE the workflows root, so they are
// stored absolute and pass through fromStoredPath unchanged — the same
// defensive behavior legacy absolute rows get). ──
const akoko = seedFile('akoko.md', '# Akoko\noriginal');
markWorkItem('enrich-with-llm', 'pid1', 'success', { detail: { name: 'Akoko', markdown: akoko }, workflowRunId: null });

const philosykos = seedFile('philosykos.md', '# Philosykos');
markWorkItem('perfumes-build', 'philosykos__diptyque__edp', 'success', {
  detail: { name: 'Philosykos — Diptyque', markdown: philosykos }, workflowRunId: null,
});

const twilight = seedFile('twilight.md', '---\ntitle: Twilight\nyear: 2008\n---\n# Twilight');
markWorkItem('plex-profiles-build', 'movie:10157', 'success', {
  detail: { name: 'Twilight', markdown: twilight, updatedAt: 1 }, workflowRunId: null,
});
const mrRobot = seedFile('mr-robot.md', '---\ntitle: Mr. Robot\nyear: 2015\n---\n# Mr. Robot');
markWorkItem('plex-profiles-build', 'show:10055', 'success', {
  detail: { name: 'Mr. Robot', markdown: mrRobot, updatedAt: 1 }, workflowRunId: null,
});

const listening = seedFile('listening-2026-07.md', '# Listening Digest — July 2026');
markWorkItem('lastfm-digest', '2026-07', 'success', {
  detail: { name: 'Listening digest — July 2026', markdown: listening }, workflowRunId: null,
});

// Workouts: ONE static slot. June's row was recorded when the file held June
// content, but the file has since been overwritten with July content — the
// June row must be closed out stale, never synced.
const workoutsSlot = seedFile('workouts-progress.md', '# July workout report');
markWorkItem('workouts-progress', '2026-06', 'success', {
  detail: { name: 'Workouts progress — 2026-06', markdown: workoutsSlot }, workflowRunId: null,
});
markWorkItem('workouts-progress', '2026-07', 'success', {
  detail: { name: 'Workouts progress — 2026-07', markdown: workoutsSlot }, workflowRunId: null,
});

// ── Run 1: initial full sync ──
const run1 = await runVaultExport(ctx, { vaultDir });
assert.equal(run1.synced, 6, 'six items copied (June workouts excluded)');
assert.equal(run1.failed, 0);
assert.equal(run1.skippedStale, 1, 'June workouts closed out as unrecoverable');

assert.equal(readFileSync(join(vaultDir, 'Places/Akoko.md'), 'utf8'), '# Akoko\noriginal');
assert.ok(existsSync(join(vaultDir, 'Perfumes/Philosykos — Diptyque (EDP).md')));
assert.ok(existsSync(join(vaultDir, 'Plex/Movies/Twilight (2008).md')));
assert.ok(existsSync(join(vaultDir, 'Plex/TV/Mr. Robot (2015).md')));
assert.ok(existsSync(join(vaultDir, 'Listening/July 2026.md')));
assert.equal(readFileSync(join(vaultDir, 'Workouts/July 2026.md'), 'utf8'), '# July workout report');
assert.ok(!existsSync(join(vaultDir, 'Workouts/June 2026.md')), 'stale June month never written');

const juneRow = getWorkItem(JOB_NAME, exportKeyFor('workouts-progress', '2026-06'));
assert.equal(juneRow?.status, 'success');
assert.match(JSON.parse(juneRow!.detail!).note, /unrecoverable/);
console.log('  ✓ initial sync copies all five sources with prettified names, closing out the stale workouts month');

// ── Run 2: nothing changed → nothing written ──
const run2 = await runVaultExport(ctx, { vaultDir });
assert.equal(run2.synced, 0);
assert.equal(run2.unchanged, 7, 'six synced items + the closed-out June row all unchanged');
console.log('  ✓ steady-state re-run writes nothing');

// ── Run 3: source updated (marker moved) → re-copied ──
writeFileSync(akoko, '# Akoko\nupdated');
bumpUpdatedAt('enrich-with-llm', 'pid1', '2030-01-01 00:00:00');
const run3 = await runVaultExport(ctx, { vaultDir });
assert.equal(run3.synced, 1);
assert.equal(readFileSync(join(vaultDir, 'Places/Akoko.md'), 'utf8'), '# Akoko\nupdated');
console.log('  ✓ a moved source marker re-copies just that item');

// ── Run 4: vault copy deleted by hand → restored ──
rmSync(join(vaultDir, 'Plex/TV/Mr. Robot (2015).md'));
const run4 = await runVaultExport(ctx, { vaultDir });
assert.equal(run4.synced, 1);
assert.ok(existsSync(join(vaultDir, 'Plex/TV/Mr. Robot (2015).md')));
console.log('  ✓ a hand-deleted vault copy is restored');

// ── Run 5: a new workouts month overwrites the slot; July\'s vault copy survives ──
writeFileSync(workoutsSlot, '# August workout report');
markWorkItem('workouts-progress', '2026-08', 'success', {
  detail: { name: 'Workouts progress — 2026-08', markdown: workoutsSlot }, workflowRunId: null,
});
const run5 = await runVaultExport(ctx, { vaultDir });
assert.equal(run5.synced, 1);
assert.equal(readFileSync(join(vaultDir, 'Workouts/August 2026.md'), 'utf8'), '# August workout report');
assert.equal(readFileSync(join(vaultDir, 'Workouts/July 2026.md'), 'utf8'), '# July workout report',
  'an already-synced older month is never clobbered by a later month');
console.log('  ✓ the workouts single-slot overwrite never rewrites an older month\'s vault copy');

// ── Run 6: name collision → stable key suffix ──
const dupA = seedFile('dup-a.md', 'first duplicate');
const dupB = seedFile('dup-b.md', 'second duplicate');
markWorkItem('enrich-with-llm', 'pidA', 'success', { detail: { name: 'Duplicate Cafe', markdown: dupA }, workflowRunId: null });
markWorkItem('enrich-with-llm', 'pidB', 'success', { detail: { name: 'Duplicate Cafe', markdown: dupB }, workflowRunId: null });
const run6 = await runVaultExport(ctx, { vaultDir });
assert.equal(run6.synced, 2);
assert.equal(readFileSync(join(vaultDir, 'Places/Duplicate Cafe.md'), 'utf8'), 'first duplicate');
assert.equal(readFileSync(join(vaultDir, 'Places/Duplicate Cafe (pidB).md'), 'utf8'), 'second duplicate');
console.log('  ✓ colliding pretty names get a stable key-suffixed sibling');

// ── Run 7: a missing source file fails its item AND the run, without blocking others ──
markWorkItem('enrich-with-llm', 'pidGone', 'success', {
  detail: { name: 'Vanished Place', markdown: join(srcDir, 'does-not-exist.md') }, workflowRunId: null,
});
const dupC = seedFile('dup-c.md', 'third ok item');
markWorkItem('enrich-with-llm', 'pidC', 'success', { detail: { name: 'Fine Place', markdown: dupC }, workflowRunId: null });
await assert.rejects(
  () => runVaultExport(ctx, { vaultDir }),
  /1\/2 item\(s\) failed/,
  'the run throws when any item failed (T416)',
);
assert.equal(readFileSync(join(vaultDir, 'Places/Fine Place.md'), 'utf8'), 'third ok item', 'other items still processed');
assert.equal(getWorkItem(JOB_NAME, exportKeyFor('enrich-with-llm', 'pidGone'))?.status, 'failed');
console.log('  ✓ a missing source file fails its item and the run, without blocking the rest');

console.log('export.test.ts: ok');
