// The one thing the space-saver audit produces.
import { fromChecks, jsonArtifact } from '../../engine/index.js';
import type { SizeBreakdownFile } from './types.js';

export const sizeBreakdown = jsonArtifact<SizeBreakdownFile>({
  key: 'plex-size-breakdown',
  description: 'Where the Plex library\'s disk space goes: one row per movie and per TV show, biggest first.',
  // The dashboard has a dedicated viewer for this shape (bars per title).
  format: 'size-table',
  check: (v) => fromChecks([
    { label: 'has a list of titles', ok: Array.isArray(v?.items), actual: Array.isArray(v?.items) ? `${v.items.length} title(s)` : 'no items list' },
    { label: 'the library is not empty', ok: Array.isArray(v?.items) && v.items.length > 0, actual: `${v?.movieCount ?? 0} movie(s), ${v?.showCount ?? 0} show(s)` },
  ]),
  summary: (v) => `${v.movieCount} movie(s) + ${v.showCount} show(s), ${v.totalHuman}`,
  items: (v) => v.items.map((i) => ({
    id: `${i.type}:${i.ratingKey}`,
    title: `${i.title}${i.year ? ` (${i.year})` : ''}`,
    fields: [{ label: 'Size', value: i.human }, { label: 'Kind', value: i.type }],
  })),
});
