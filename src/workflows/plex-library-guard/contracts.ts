// What the library guard writes on every clean run.
import { fromChecks, jsonArtifact } from '../../engine/index.js';
import type { GuardReportFile, LibrarySnapshotFile } from './types.js';

/** What this run found: totals, what is missing, whether it alerted. */
export const guardReport = jsonArtifact<GuardReportFile>({
  key: 'plex-guard-report',
  description: 'What this run found: the library\'s size and file count, anything missing since the last run, and whether an alert went out.',
  check: (v) => fromChecks([
    { label: 'has totals', ok: typeof v?.fileCount === 'number' && typeof v?.totalBytes === 'number', actual: `${v?.fileCount} file(s), ${v?.totalHuman}` },
    { label: 'lists what is missing', ok: Array.isArray(v?.missing), actual: `${v?.missingCount ?? '?'} missing` },
  ]),
  summary: (v) => v.firstRun
    ? `baseline seeded: ${v.fileCount} file(s), ${v.totalHuman}`
    : `${v.fileCount} file(s), ${v.totalHuman}, ${v.missingCount} missing, ${v.addedCount} added${v.alerted ? ', ALERTED' : ''}`,
  items: (v) => v.missing.map((f) => ({
    id: f.key,
    title: f.title,
    status: 'failed',
    fields: [{ label: 'Kind', value: f.type }, ...(f.file ? [{ label: 'File', value: f.file }] : [])],
  })),
});

/** The baseline the NEXT run diffs against: every media file with its path and size. */
export const librarySnapshot = jsonArtifact<LibrarySnapshotFile>({
  key: 'plex-library-snapshot',
  description: 'The full per-file inventory of the library, and the baseline the next run is compared with.',
  // The dashboard has a dedicated searchable viewer for this shape.
  format: 'library-snapshot',
  check: (v) => fromChecks([
    { label: 'has a list of files', ok: Array.isArray(v?.files), actual: Array.isArray(v?.files) ? `${v.files.length} file(s)` : 'no files list' },
    // An empty inventory must never become the baseline: every file would then look "added" forever.
    { label: 'the library is not empty', ok: Array.isArray(v?.files) && v.files.length > 0 && v.fileCount === v.files.length, actual: `fileCount ${v?.fileCount}` },
  ]),
  summary: (v) => `${v.fileCount} file(s), ${v.totalHuman}`,
  count: (v) => v.fileCount,
  items: (v) => v.files.map((f) => ({
    id: f.key,
    title: f.title,
    fields: [{ label: 'Kind', value: f.type }, { label: 'Bytes', value: String(f.bytes) }, ...(f.file ? [{ label: 'File', value: f.file }] : [])],
  })),
});
