// Pure naming/mapping helpers for the vault-sync exporter. No I/O — the stage
// passes file content in where needed, so everything here is unit-testable.

/** The source jobs whose markdown output is mirrored into the vault. */
export const SOURCE_JOBS = [
  'enrich-with-llm', // places
  'perfumes-build',
  'plex-profiles-build',
  'lastfm-digest', // listening-digest
  'workouts-progress', // workouts-sync
  'media-reviews-books',
  'media-reviews-movies',
  'media-reviews-tv',
  'media-reviews-albums',
] as const;

export type SourceJob = (typeof SOURCE_JOBS)[number];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Characters no common filesystem/tool accepts in a filename, plus controls.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * Make a string safe as a vault filename (without extension): strip the
 * characters no common filesystem/tool accepts, collapse whitespace, trim
 * leading/trailing dots and spaces, and cap the length. An input that
 * sanitizes to nothing falls back to the (also sanitized) item key so a file
 * always gets SOME stable name.
 */
export function sanitizeFilename(raw: string, fallbackKey: string): string {
  const clean = raw
    .replace(UNSAFE_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 120)
    .trim();
  if (clean) return clean;
  const fromKey = fallbackKey
    .replace(UNSAFE_CHARS, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return fromKey || 'untitled';
}

/**
 * Render a listening/workouts ledger month key as a human month name:
 * `2026-07` → `July 2026`, `2026-07-3month` → `July 2026 (Trailing 3 Months)`.
 * A key that doesn't match the `YYYY-MM[-3month]` shape is returned unchanged.
 */
export function prettyMonth(key: string): string {
  const m = /^(\d{4})-(\d{2})(-3month)?$/.exec(key);
  if (!m) return key;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return key;
  const base = `${MONTH_NAMES[month - 1]} ${m[1]}`;
  return m[3] ? `${base} (Trailing 3 Months)` : base;
}

/**
 * Pull the numeric `year:` value out of a markdown file's leading YAML
 * frontmatter block, or null when absent (no frontmatter, or no year key).
 * Used for the Plex profile `Title (Year)` vault names — the year lives only
 * in the source file's frontmatter, not in its ledger detail.
 */
export function extractFrontmatterYear(md: string): number | null {
  if (!md.startsWith('---')) return null;
  const end = md.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm = md.slice(0, end);
  const m = /^year:\s*["']?(\d{4})["']?\s*$/m.exec(fm);
  return m ? Number(m[1]) : null;
}

export interface VaultTarget {
  /** Vault-relative folder, e.g. `Plex/Movies` (POSIX slashes). */
  folder: string;
  /** Sanitized base filename WITHOUT the `.md` extension. */
  baseName: string;
}

/**
 * Map one source ledger row to its vault folder + prettified base filename.
 * `readSourceMd` is only invoked for sources that need the file content (the
 * Plex year lookup), so the caller can hand in the already-read copy content
 * lazily. Falls back to the item key wherever a display name is missing.
 */
export function vaultTargetFor(
  sourceJob: SourceJob,
  itemKey: string,
  detailName: string | null,
  readSourceMd: () => string,
): VaultTarget {
  const name = detailName?.trim() || itemKey;
  switch (sourceJob) {
    case 'enrich-with-llm':
      return { folder: 'Places', baseName: sanitizeFilename(name, itemKey) };
    case 'perfumes-build': {
      // Key shape: <perfume>__<brand>__<concentration>; detail.name is
      // "Name — Brand" with no concentration, so surface it from the key.
      const conc = itemKey.split('__')[2];
      const base = conc ? `${name} (${conc.toUpperCase()})` : name;
      return { folder: 'Perfumes', baseName: sanitizeFilename(base, itemKey) };
    }
    case 'plex-profiles-build': {
      const folder = itemKey.startsWith('movie:') ? 'Plex/Movies' : 'Plex/TV';
      const year = extractFrontmatterYear(readSourceMd());
      const base = year ? `${name} (${year})` : name;
      return { folder, baseName: sanitizeFilename(base, itemKey) };
    }
    case 'lastfm-digest':
      return { folder: 'Listening', baseName: sanitizeFilename(prettyMonth(itemKey), itemKey) };
    case 'workouts-progress':
      return { folder: 'Workouts', baseName: sanitizeFilename(prettyMonth(itemKey), itemKey) };
    // media-reviews: detail.name is already the full display name the jobs
    // compute ("Title (Author)" / "Title (Artist)" / "Title (year)"), so the
    // vault name needs no key parsing or file reading.
    case 'media-reviews-books':
      return { folder: 'Reviews/Books', baseName: sanitizeFilename(name, itemKey) };
    case 'media-reviews-movies':
      return { folder: 'Reviews/Movies', baseName: sanitizeFilename(name, itemKey) };
    case 'media-reviews-tv':
      return { folder: 'Reviews/TV', baseName: sanitizeFilename(name, itemKey) };
    case 'media-reviews-albums':
      return { folder: 'Reviews/Albums', baseName: sanitizeFilename(name, itemKey) };
  }
}
