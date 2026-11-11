// The data the plex-poster-backup stages hand to each other.
//
//   plex-posters-list ──list──▶ plex-posters-fetch ──set──▶ plex-posters-record ──report──▶ plex-posters-alert
//
// Each stage takes everything it needs from the one before it, so the graph is a
// plain chain. The images themselves and the dated snapshots are not artifacts:
// they live in the archive folder outside this repo (see config.ts), and the
// record stage's report says what was added to it.
import { fromChecks, inlineArtifact, jsonArtifact } from '../../engine/index.js';
import { failureTolerance, label } from './lib.js';
import type { BackupReport, PosterList, PosterSet } from './types.js';

/** Every film, show and season in every film and TV library, with the path of its current poster. */
export const posterList = jsonArtifact<PosterList>({
  key: 'plex-poster-list',
  description: 'Every film, show and season in the Plex library, each with the path of the poster it currently shows.',
  shape: {
    summary: 'The titles whose posters are backed up.',
    format: 'JSON object { generatedAt, server, sections, items[] }',
    expectations: [
      { label: 'Has at least one title', detail: 'A populated library never lists zero titles; an empty list means the Plex read went wrong.' },
      { label: 'Names the Plex server', detail: 'The server\'s machine identifier, which the restore script uses to tell whether it is talking to the same server.' },
    ],
  },
  check: (v) => fromChecks([
    { label: 'Has at least one title', ok: Array.isArray(v?.items) && v.items.length > 0, actual: `${v?.items?.length ?? 0} title(s)` },
    { label: 'Names the Plex server', ok: typeof v?.server?.machineIdentifier === 'string' && v.server.machineIdentifier.length > 0, actual: v?.server?.machineIdentifier ? 'present' : 'missing' },
  ], `${v?.items?.length ?? 0} title(s)`),
  summary: (v) => `${v.items.length} title(s) across ${v.sections.length} librar${v.sections.length === 1 ? 'y' : 'ies'}`,
  count: (v) => v.items.length,
  items: (v) => v.items.map((i) => ({ id: `${i.type}:${i.ratingKey}`, title: label(i), fields: [{ label: 'Kind', value: i.type }, { label: 'Library', value: i.sectionTitle }] })),
});

/** The same titles, each with the archived image its poster now is. */
export const posterSet = jsonArtifact<PosterSet>({
  key: 'plex-poster-set',
  description: 'The same titles, each now pointing at its poster in the archive, with how many were downloaded this run and how many were already there.',
  shape: {
    summary: 'Every title with the archived image of its poster.',
    format: 'JSON object { generatedAt, server, counts, errors[], items[] }',
    expectations: [
      { label: 'Has at least one title', detail: 'Carried over from the list.' },
      { label: 'Few enough posters failed to download', detail: 'A handful of failures are recorded and reported. More than 2% of the library (and more than 10) means Plex was unwell, and the backup stops here.' },
    ],
  },
  check: (v) => fromChecks([
    { label: 'Has at least one title', ok: Array.isArray(v?.items) && v.items.length > 0, actual: `${v?.items?.length ?? 0} title(s)` },
    { label: 'Few enough posters failed to download', ok: (v?.counts?.failed ?? 0) <= failureTolerance(v?.items?.length ?? 0), actual: `${v?.counts?.failed ?? 0} failed, ${failureTolerance(v?.items?.length ?? 0)} tolerated` },
  ], `${v?.counts?.downloaded ?? 0} downloaded, ${v?.counts?.reused ?? 0} already archived`),
  summary: (v) => `${v.counts.downloaded} downloaded, ${v.counts.reused} already archived, ${v.counts.noPoster} with no poster${v.counts.failed ? `, ${v.counts.failed} FAILED` : ''}`,
  count: (v) => v.items.length,
  items: (v) => v.items.map((i) => ({
    id: `${i.type}:${i.ratingKey}`,
    title: label(i),
    fields: [{ label: 'Kind', value: i.type }, ...(i.image ? [{ label: 'Size', value: `${(i.image.bytes / 1_000_000).toFixed(1)} MB` }] : [{ label: 'Poster', value: 'none' }])],
  })),
});

/** What this week's snapshot is and how it differs from the last one. The workflow's product. */
export const backupReport = jsonArtifact<BackupReport>({
  key: 'plex-poster-backup-report',
  description: 'This backup\'s snapshot: how many posters it covers, where it was written in the archive, and which posters changed since the previous snapshot.',
  check: (v) => fromChecks([
    { label: 'Names the snapshot it wrote', ok: typeof v?.snapshotFile === 'string' && v.snapshotFile.length > 0, actual: v?.snapshotFile ?? 'missing' },
    { label: 'Has counts', ok: typeof v?.counts?.items === 'number', actual: `${v?.counts?.items ?? '?'} title(s)` },
  ]),
  summary: (v) => v.previousSnapshot
    ? `${v.counts.items} posters backed up; ${v.changed} changed, ${v.added} new, ${v.removed} gone since the last snapshot`
    : `${v.counts.items} posters backed up (the first snapshot)`,
  count: (v) => v.changed,
  items: (v) => v.changes.map((c) => ({ id: `${c.type}:${c.ratingKey}`, title: c.label, fields: [{ label: 'Kind', value: c.type }, { label: 'Was', value: c.from ? c.from.slice(0, 10) : 'no poster' }, { label: 'Now', value: c.to ? c.to.slice(0, 10) : 'no poster' }] })),
});

export interface AlertDigest {
  alerted: boolean;
  changed: number;
  changedPct: number;
  reason: string;
}

/** Whether a push was sent, and why or why not. */
export const alertDigest = inlineArtifact<AlertDigest>({
  key: 'plex-poster-alert',
  description: 'Whether this backup raised an alert: sent only when a large share of posters changed since the previous snapshot.',
  check: (v) => fromChecks([{ label: 'Says whether it alerted', ok: typeof v?.alerted === 'boolean', actual: String(v?.alerted) }]),
  summary: (v) => (v.alerted ? `alert sent: ${v.reason}` : `no alert: ${v.reason}`),
});
