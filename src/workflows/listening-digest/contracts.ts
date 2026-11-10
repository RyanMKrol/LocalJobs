// What the listening digest produces: a folder of markdown digests, two per month.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { dirArtifact, fromChecks } from '../../engine/index.js';

export const listeningDigests = dirArtifact({
  key: 'listening-digests',
  description: 'The monthly listening digests: listening-digest-<YYYY-MM>.md and its trailing three month companion.',
  format: 'markdown',
  files: (name) => name.endsWith('.md'),
  check(d) {
    const empty = d.files.filter((f) => statSync(join(d.path, f)).size === 0);
    return fromChecks([
      { label: 'has at least one digest', ok: d.files.length > 0, actual: `${d.files.length} digest(s)` },
      { label: 'no digest is empty', ok: empty.length === 0, actual: empty.length ? `empty: ${empty.join(', ')}` : 'all have content' },
    ], `${d.files.length} digest(s)`);
  },
  count: (d) => d.files.length,
  summary: (d) => `${d.files.length} digest(s)`,
  // Newest first: the file names sort by month.
  items: (d) => [...d.files].reverse().map((f) => ({
    id: f, title: f.replace(/^listening-digest-|\.md$/g, ''), preview: { path: join(d.path, f), format: 'markdown' },
  })),
});
