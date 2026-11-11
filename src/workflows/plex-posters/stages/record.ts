import { join } from 'node:path';
import { callService } from '../../../core/services.js';
import { writeFileAtomic, type JobContext } from '../../../engine/index.js';
import { CHANGE_LIST_CAP, assertArchiveReady, diffSnapshots, identityKey, listArchiveImages, readManifest, snapshotFileName } from '../lib.js';
import type { BackupReport, PosterSet, SnapshotManifest } from '../types.js';

/**
 * Write this backup's snapshot into the archive and work out what changed since
 * the previous one.
 *
 * The snapshot is only written once every image it names is really in the
 * archive: a snapshot that points at a missing file would be a backup that cannot
 * be restored. The dated file is written first and `latest.json` second, so a
 * kill in between leaves the old `latest.json` whole and the next run compares
 * against it again.
 */
export async function runRecord(ctx: JobContext, set: PosterSet, opts: { archiveDir: string; now?: Date }): Promise<BackupReport> {
  const { archiveDir } = opts;
  ctx.log(`plex-posters-record starting: ${set.items.length} title(s), archive at ${archiveDir || '(not set)'}`);
  await callService('fs', async () => assertArchiveReady(archiveDir));
  const archived = await callService('fs', async () => listArchiveImages(archiveDir));
  const missing = set.items.filter((i) => i.image && !archived.has(i.image.file));
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} poster image(s) named by this backup are not in the archive (first: ${missing[0].image!.file}). ` +
        'Not recording a snapshot that could not be restored.',
    );
  }
  ctx.log(`Every image this snapshot names is in the archive (${archived.size} image(s) held in total)`);

  const previous = await callService('fs', async () => readManifest(join(archiveDir, 'latest.json')));
  const createdAt = (opts.now ?? new Date()).toISOString();
  const manifest: SnapshotManifest = {
    version: 1,
    createdAt,
    server: set.server,
    filters: null,
    counts: set.counts,
    errors: set.errors,
    items: set.items,
  };
  const snapshotFile = `snapshots/${snapshotFileName(createdAt)}`;
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  await callService('fs', async () => {
    writeFileAtomic(join(archiveDir, snapshotFile), json);
    writeFileAtomic(join(archiveDir, 'latest.json'), json);
  });
  ctx.log(`Wrote ${snapshotFile} and latest.json (${(json.length / 1_000_000).toFixed(1)} MB each)`);

  const distinct = new Map<string, number>();
  for (const item of set.items) if (item.image) distinct.set(item.image.sha1, item.image.bytes);
  const images = { distinct: distinct.size, bytes: [...distinct.values()].reduce((a, b) => a + b, 0) };

  // A title whose poster failed to download is left out of the comparison on both
  // sides: it is recorded with no image, and that is a failure to report (the
  // alert stage does), not a poster that changed.
  const failedKeys = new Set(set.errors.map((e) => e.ratingKey));
  const failedIds = new Set(set.items.filter((i) => failedKeys.has(i.ratingKey)).map(identityKey));
  const diff = previous
    ? diffSnapshots(previous.items.filter((i) => !failedIds.has(identityKey(i))), set.items.filter((i) => !failedKeys.has(i.ratingKey)))
    : { compared: 0, changed: [], added: [], removed: [] };
  if (set.counts.failed > 0) {
    ctx.log(`${set.counts.failed} poster(s) could not be downloaded and are recorded with no image:`, 'warn');
    for (const e of set.errors) ctx.log(`  ${e.label}: ${e.error}`, 'warn');
  }
  const report: BackupReport = {
    createdAt,
    snapshotFile,
    previousSnapshot: previous?.createdAt ?? null,
    counts: set.counts,
    images,
    compared: diff.compared,
    changed: diff.changed.length,
    added: diff.added.length,
    removed: diff.removed.length,
    changedPct: diff.compared > 0 ? Math.round((diff.changed.length / diff.compared) * 1000) / 10 : 0,
    changes: diff.changed.slice(0, CHANGE_LIST_CAP),
    addedSample: diff.added.slice(0, 50),
    removedSample: diff.removed.slice(0, 50),
    failures: set.errors,
  };

  if (!previous) {
    ctx.log('This is the first snapshot in the archive, so there is nothing to compare it with');
  } else {
    ctx.log(`Compared with the snapshot of ${previous.createdAt}: ${report.changed} of ${report.compared} poster(s) changed (${report.changedPct}%), ${report.added} title(s) new, ${report.removed} gone`);
    for (const c of diff.changed.slice(0, 40)) ctx.log(`  changed: ${c.label}`);
    if (diff.changed.length > 40) ctx.log(`  ...and ${diff.changed.length - 40} more`);
    for (const a of diff.added.slice(0, 20)) ctx.log(`  new: ${a}`);
    if (diff.added.length > 20) ctx.log(`  ...and ${diff.added.length - 20} more new`);
    for (const r of diff.removed.slice(0, 20)) ctx.log(`  gone: ${r}`);
    if (diff.removed.length > 20) ctx.log(`  ...and ${diff.removed.length - 20} more gone`);
  }
  ctx.log(`plex-posters-record complete: ${images.distinct} distinct image(s), ${(images.bytes / 1_000_000_000).toFixed(2)} GB referenced by this snapshot`);
  ctx.progress(100, `${set.counts.items} posters recorded`);
  return report;
}
