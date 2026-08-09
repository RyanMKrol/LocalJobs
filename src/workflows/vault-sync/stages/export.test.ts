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

const SOURCES = [
  'enrich-with-llm', 'perfumes-build', 'plex-profiles-build', 'lastfm-digest', 'workouts-progress',
  'media-reviews-books', 'media-reviews-movies', 'media-reviews-tv', 'media-reviews-albums',
] as const;
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

// Workouts: one file per month (per-month layout since 2026-08) — every
// month's row points at its own surviving file, so both months sync.
const workoutsJune = seedFile('workouts-progress-2026-06.md', '# June workout report');
markWorkItem('workouts-progress', '2026-06', 'success', {
  detail: { name: 'Workouts progress — 2026-06', markdown: workoutsJune }, workflowRunId: null,
});
const workoutsJuly = seedFile('workouts-progress-2026-07.md', '# July workout report');
markWorkItem('workouts-progress', '2026-07', 'success', {
  detail: { name: 'Workouts progress — 2026-07', markdown: workoutsJuly }, workflowRunId: null,
});

// media-reviews: one item per category — detail.name is already the full
// display name, so the vault name is just its sanitized form under Reviews/.
const bookReview = seedFile('norwegian-wood.md', '---\ntype: book-review\n---\n\n## Review\n\nQuiet and sad.');
markWorkItem('media-reviews-books', 'book-0001-aaaa', 'success', {
  detail: { name: 'Norwegian Wood (Haruki Murakami)', markdown: bookReview, marker: 'aa11' }, workflowRunId: null,
});
const movieReview = seedFile('arrival.md', '---\ntype: movie-review\n---\n\n## Review\n\nStunning.');
markWorkItem('media-reviews-movies', 'movie-0001-bbbb', 'success', {
  detail: { name: 'Arrival (2016)', markdown: movieReview, marker: 'bb22' }, workflowRunId: null,
});
const tvReview = seedFile('mr-robot-review.md', '---\ntype: tv-review\n---\n\n## Review\n\nTense.');
markWorkItem('media-reviews-tv', 'tv-0001-cccc', 'success', {
  detail: { name: 'Mr. Robot (2015)', markdown: tvReview, marker: 'cc33' }, workflowRunId: null,
});
const albumReview = seedFile('in-rainbows.md', '---\ntype: album-review\n---\n\n## Highlights\n\nNude; Reckoner.');
markWorkItem('media-reviews-albums', 'album-0001-dddd', 'success', {
  detail: { name: 'In Rainbows (Radiohead)', markdown: albumReview, marker: 'dd44' }, workflowRunId: null,
});

// A legacy closed-out row from the old single-slot layout: exporter row exists
// with a note and no vaultPath — it must stay untouched forever.
markWorkItem('workouts-progress', '2026-05', 'success', {
  detail: { name: 'Workouts progress — 2026-05', markdown: join(srcDir, 'workouts-progress.md') }, workflowRunId: null,
});
markWorkItem(JOB_NAME, exportKeyFor('workouts-progress', '2026-05'), 'success', {
  detail: {
    name: 'Workouts progress — 2026-05',
    note: 'source slot already overwritten by a later month — content unrecoverable, not synced',
    sourceUpdatedAt: getWorkItem('workouts-progress', '2026-05')!.updated_at,
  }, workflowRunId: null,
});

// ── Run 1: initial full sync ──
const run1 = await runVaultExport(ctx, { vaultDir });
assert.equal(run1.synced, 11, 'eleven items copied (both workout months + the four reviews)');
assert.equal(run1.failed, 0);

assert.equal(readFileSync(join(vaultDir, 'Places/Akoko.md'), 'utf8'), '# Akoko\noriginal');
assert.ok(existsSync(join(vaultDir, 'Perfumes/Philosykos — Diptyque (EDP).md')));
assert.ok(existsSync(join(vaultDir, 'Plex/Movies/Twilight (2008).md')));
assert.ok(existsSync(join(vaultDir, 'Plex/TV/Mr. Robot (2015).md')));
assert.ok(existsSync(join(vaultDir, 'Listening/July 2026.md')));
assert.equal(readFileSync(join(vaultDir, 'Workouts/June 2026.md'), 'utf8'), '# June workout report');
assert.equal(readFileSync(join(vaultDir, 'Workouts/July 2026.md'), 'utf8'), '# July workout report');
assert.ok(!existsSync(join(vaultDir, 'Workouts/May 2026.md')), 'legacy closed-out month never written');
assert.equal(readFileSync(join(vaultDir, 'Reviews/Books/Norwegian Wood (Haruki Murakami).md'), 'utf8'), '---\ntype: book-review\n---\n\n## Review\n\nQuiet and sad.');
assert.ok(existsSync(join(vaultDir, 'Reviews/Movies/Arrival (2016).md')));
assert.ok(existsSync(join(vaultDir, 'Reviews/TV/Mr. Robot (2015).md')));
assert.ok(existsSync(join(vaultDir, 'Reviews/Albums/In Rainbows (Radiohead).md')));

const mayRow = getWorkItem(JOB_NAME, exportKeyFor('workouts-progress', '2026-05'));
assert.equal(mayRow?.status, 'success');
assert.match(JSON.parse(mayRow!.detail!).note, /unrecoverable/, 'legacy closed-out row untouched');
console.log('  ✓ initial sync copies every source with prettified names, leaving the legacy closed-out month alone');

// ── Run 2: nothing changed → nothing written ──
const run2 = await runVaultExport(ctx, { vaultDir });
assert.equal(run2.synced, 0);
assert.equal(run2.unchanged, 12, 'eleven synced items + the legacy closed-out May row all unchanged');
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

// ── Run 5: a new workouts month adds its own file; older months survive ──
const workoutsAugust = seedFile('workouts-progress-2026-08.md', '# August workout report');
markWorkItem('workouts-progress', '2026-08', 'success', {
  detail: { name: 'Workouts progress — 2026-08', markdown: workoutsAugust }, workflowRunId: null,
});
const run5 = await runVaultExport(ctx, { vaultDir });
assert.equal(run5.synced, 1);
assert.equal(readFileSync(join(vaultDir, 'Workouts/August 2026.md'), 'utf8'), '# August workout report');
assert.equal(readFileSync(join(vaultDir, 'Workouts/July 2026.md'), 'utf8'), '# July workout report',
  'an older month keeps its own vault copy when a new month lands');
console.log('  ✓ a new workouts month syncs alongside the older months');

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
