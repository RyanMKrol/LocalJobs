// What the plex-profiles stage produces: two folders of markdown profiles.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { dirArtifact, fromChecks } from '../../engine/index.js';

/** A folder of markdown files, one per item: none of them may be empty. */
function markdownFolder(key: string, description: string, noun: string) {
  return dirArtifact({
    key,
    description,
    format: 'markdown',
    files: (name) => name.endsWith('.md'),
    check(d) {
      const empty = d.files.filter((f) => statSync(join(d.path, f)).size === 0);
      return fromChecks([{ label: `no ${noun} is empty`, ok: empty.length === 0, actual: empty.length ? `empty: ${empty.slice(0, 5).join(', ')}` : `${d.files.length} ${noun}(s)` }], `${d.files.length} ${noun}(s)`);
    },
    count: (d) => d.files.length,
    summary: (d) => `${d.files.length} ${noun}(s)`,
    items: (d) => d.files.map((f) => ({ id: f, title: f.replace(/\.md$/, ''), preview: { path: join(d.path, f), format: 'markdown' } })),
  });
}

export const movieProfiles = markdownFolder('plex-movie-profiles', 'One markdown profile per movie in the Plex library.', 'profile');
export const showProfiles = markdownFolder('plex-show-profiles', 'One markdown profile per TV show in the Plex library.', 'profile');
