// What each media-reviews stage produces. The four stages are independent (no
// edges): each mirrors one review table into its own folder.
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

/** One markdown file per review in a category. A review is rewritten only when its content changes. */
export const mediaReviews = markdownFolder(
  'media-reviews',
  'One markdown file per review in this category, mirrored from the website\'s table.',
  'review',
);
