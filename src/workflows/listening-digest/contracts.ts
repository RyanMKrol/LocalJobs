// What the listening digest produces: a folder of markdown digests, two per month.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { dirArtifact, fromChecks } from '../../engine/index.js';

export const listeningDigests = dirArtifact({
  key: 'listening-digests',
  description: 'The monthly listening digests: listening-digest-<YYYY-MM>.md and its trailing three month companion.',
  format: 'markdown',
  check(d) {
    const mds = d.files.filter((f) => f.endsWith('.md'));
    const empty = mds.filter((f) => statSync(join(d.path, f)).size === 0);
    return fromChecks([
      { label: 'has at least one digest', ok: mds.length > 0, actual: `${mds.length} digest(s)` },
      { label: 'no digest is empty', ok: empty.length === 0, actual: empty.length ? `empty: ${empty.join(', ')}` : 'all have content' },
    ], `${mds.length} digest(s)`);
  },
  count: (d) => d.files.filter((f) => f.endsWith('.md')).length,
  summary: (d) => `${d.files.filter((f) => f.endsWith('.md')).length} digest(s)`,
  // Newest first: the file names sort by month.
  items: (d) => d.files.filter((f) => f.endsWith('.md')).reverse().map((f) => ({
    id: f, title: f.replace(/^listening-digest-|\.md$/g, ''), preview: { path: join(d.path, f), format: 'markdown' },
  })),
});
