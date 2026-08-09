/**
 * plex-rename naming engine — PURE computation, no IO.
 *
 * Given one Plex-matched media file's metadata + its current Plex-side path +
 * a listing of its directory, compute the canonical Plex-convention target
 * path (and the ordered operations to get there), or a typed skip decision.
 * Everything here operates on PLEX-SIDE POSIX paths ('/'-separated, as
 * reported in `Media[].Part[].file`); mapping to the Mac's SMB mount paths is
 * the verify/apply stages' concern, never this module's.
 *
 * Canonical templates (official Plex conventions):
 *   Movie:   {root}/Title (Year) {tmdb-N}/Title (Year) {tmdb-N}[ {edition-X}][ - ptN].ext
 *   Episode: {root}/Show (Year) {tvdb-N}/Season NN/Show (Year) - sNNeNN[-eMM] - Title.ext
 *
 * ID policy: movies prefer tmdb (this repo's identity convention, see
 * `extractTmdbId` in src/core/plex-client.ts) falling back to imdb; shows
 * prefer tvdb (the Plex TV agent's canonical ordering source) falling back to
 * tmdb. NO id → skip `missing-id`: an unmatched title's Plex metadata is
 * filename-derived garbage, and renaming from garbage cements a wrong match.
 *
 * Anime / absolute-numbering note: episode names come from Plex's OWN current
 * belief (parentIndex/index), so a file named with an absolute number that
 * Plex matched to S02E01 becomes `s02e01` — self-consistent on rescan, and
 * reinforced by the emitted `.plexmatch`. If Plex's match is WRONG, this bakes
 * the wrong belief into the filename; the plan report (reviewed during the
 * probation period) is the v1 mitigation — garbage-in is not detectable here.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

/** One configured library root on one share, e.g. "/volume1/NAS-Cool Shared Drive/Movies". */
export interface LibraryRoot {
  path: string;
  kind: 'movie' | 'tv';
}

/** One entry of the media file's current directory listing (provided by discover). */
export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface MovieRef {
  ratingKey: string;
  title: string;
  year?: number;
  tmdbId?: number;
  imdbId?: string;
  editionTitle?: string;
}

export interface ShowRef {
  ratingKey: string;
  title: string;
  year?: number;
  tvdbId?: number;
  tmdbId?: number;
  imdbId?: string;
  /** True when a .plexmatch already exists in the show's current folder tree (never clobber). */
  hasExistingPlexmatch?: boolean;
}

export interface EpisodeRef {
  ratingKey: string;
  /** parentIndex — season number (0 = specials; ≥1900 with airDate = date-based show). */
  season: number;
  /** index — episode number within the season. */
  episode: number;
  title?: string;
  /** originallyAvailableAt, "YYYY-MM-DD" — required for date-based shows. */
  airDate?: string;
}

/** One physical media file = one engine input. */
export interface RenameInput {
  kind: 'movie' | 'episode';
  /** Part.file — the current absolute Plex-side path. */
  file: string;
  partId: number;
  /** Part.size in bytes (used by the <300MB "sample" exclusion-filter guard). */
  partSize?: number;
  /** item.Media.length — >1 means multi-version (v1 skips those). */
  mediaCount: number;
  /** media.Part.length — >1 means multi-part (renamed with " - ptN"). */
  partCount: number;
  /** 0-based position of this part within media.Part (Plex's play order). */
  partIndex: number;
  movie?: MovieRef;
  show?: ShowRef;
  /** All episodes this file represents (>1 = a multi-episode file). */
  episodes?: EpisodeRef[];
  /** Listing of the file's CURRENT directory (sidecar planning). */
  siblings: DirEntry[];
  roots: LibraryRoot[];
}

export type SkipReason =
  | 'unmapped-root'
  | 'missing-id'
  | 'missing-year'
  | 'missing-episode-numbering'
  | 'multi-version'
  | 'non-contiguous-multi-episode'
  | 'disc-image'
  | 'inside-plex-versions'
  | 'hidden-or-system-path'
  | 'existing-plexmatch'
  | 'path-too-long'
  | 'sample-filter-hazard'
  | 'target-collision'
  | 'already-canonical'
  | 'ambiguous-metadata';

export type NamingOp =
  | { op: 'mkdir'; path: string }
  | { op: 'write-plexmatch'; dir: string; content: string }
  | { op: 'move'; from: string; to: string; role: 'media' | 'sidecar' | 'asset'; caseOnly?: boolean };

export interface RenamePlanItem {
  kind: 'rename';
  ops: NamingOp[];
  /** Sibling files deliberately left in the old directory (for the report). */
  leftBehind: string[];
  /** The media file's final Plex-side path (collision-dedup key). */
  targetPath: string;
}

export type RenameDecision =
  | RenamePlanItem
  | { kind: 'already-canonical'; targetPath: string }
  | { kind: 'skip'; reason: SkipReason; detail: string };

// ── Small pure path helpers (Plex-side POSIX paths — no node:path) ─────────────

export function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export function posixBasename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** Split "Name.ext" → { stem, ext } where ext excludes the dot ('' when none). */
export function splitExt(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf('.');
  if (i <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, i), ext: name.slice(i + 1) };
}

/** The comparison key for path equality/collisions: NFC-normalized + case-folded (SMB is case-insensitive). */
export function pathKey(p: string): string {
  return p.normalize('NFC').toLowerCase();
}

// ── Sanitizer ──────────────────────────────────────────────────────────────────

const MAX_COMPONENT_BYTES = 255;
const DEFAULT_TITLE_BYTES = 200;

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Grapheme-safe truncation to a byte budget (never splits a surrogate pair / combined emoji). */
function clampBytes(s: string, maxBytes: number): string {
  if (byteLen(s) <= maxBytes) return s;
  const seg = new Intl.Segmenter('und', { granularity: 'grapheme' });
  let out = '';
  for (const { segment } of seg.segment(s)) {
    if (byteLen(out + segment) > maxBytes) break;
    out += segment;
  }
  return out;
}

/**
 * Sanitize ONE path component derived from a Plex title. Ordered pipeline —
 * every step exists for a documented reason (see the workflow CLAUDE.md):
 * NFC first (SMB/macOS NFD hazard, and stable byte math), semicolons deleted
 * (the Plex scanner truncates a title at ';' — "Steins;Gate" → "Steins"),
 * colon → " - " with a leading space (a bare "- " changes Plex's parse:
 * "Kill Bill- Vol. 1" parses as "Kill Bill"), square brackets → parens
 * (bracket content is Plex's IGNORE marker — "[Oshi no Ko]" must not vanish),
 * braces deleted (reserved for {tmdb-}/{edition-} hint tags), slashes →
 * space, remaining filesystem-illegal chars deleted, whitespace collapsed,
 * trailing dots/spaces trimmed (Windows/SMB reject them), then a
 * grapheme-safe byte clamp. Returns null when nothing survives.
 */
export function sanitizeComponent(name: string, maxBytes: number = DEFAULT_TITLE_BYTES): string | null {
  let s = name.normalize('NFC');
  s = s.replace(/;/g, '');
  s = s.replace(/\s*:\s*/g, ' - ');
  s = s.replace(/\[/g, '(').replace(/\]/g, ')');
  s = s.replace(/[{}]/g, '');
  s = s.replace(/[/\\]/g, ' ');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[<>"|?*\u0000-\u001f\u007f]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[. ]+$/g, '');
  s = clampBytes(s, maxBytes);
  s = s.replace(/\s+$/g, '').replace(/[. ]+$/g, '');
  return s.length > 0 ? s : null;
}

/**
 * Plex's special local-media directory names (plus "Plex Versions"): a
 * GENERATED folder component must never equal one of these, or the scanner
 * treats the folder as extras/optimized-versions instead of media.
 */
const SPECIAL_DIR_NAMES = new Set(
  [
    'extras',
    'behind the scenes',
    'deleted scenes',
    'featurettes',
    'interviews',
    'scenes',
    'shorts',
    'trailers',
    'other',
    'plex versions',
    'samples',
    'bonus',
    'bonus disc',
  ].map((s) => s.toLowerCase()),
);

const SAMPLE_FILTER_MAX_BYTES = 300 * 1024 * 1024; // Plex hides "sample" files under 300 MB

/**
 * True when a GENERATED name would trip one of Plex's automatic exclusion
 * filters: a folder component exactly matching a special directory name, or
 * the word "sample" in a file's name when the file is under 300 MB.
 */
export function hasExclusionHazard(component: string, opts: { isDir: boolean; sizeBytes?: number }): boolean {
  if (opts.isDir) return SPECIAL_DIR_NAMES.has(component.trim().toLowerCase());
  if (/\bsample\b/i.test(component)) {
    return opts.sizeBytes === undefined || opts.sizeBytes < SAMPLE_FILTER_MAX_BYTES;
  }
  return false;
}

// ── Current-path guards ────────────────────────────────────────────────────────

const HIDDEN_OR_SYSTEM = new Set(['#recycle', '@eadir', 'lost+found', '.appledouble', '.grab']);
const DISC_IMAGE_DIRS = new Set(['video_ts', 'bdmv']);
const DISC_IMAGE_EXTS = new Set(['iso', 'img', 'dvdmedia']);

/** Classify a CURRENT path that must not be touched at all, or null if it's fair game. */
export function currentPathGuard(file: string): { reason: SkipReason; detail: string } | null {
  const components = file.split('/').filter(Boolean);
  for (const c of components.slice(0, -1)) {
    const lc = c.toLowerCase();
    if (lc === 'plex versions') return { reason: 'inside-plex-versions', detail: `inside a "${c}" folder` };
    if (DISC_IMAGE_DIRS.has(lc)) return { reason: 'disc-image', detail: `inside a ${c} disc structure` };
    if (c.startsWith('.') || HIDDEN_OR_SYSTEM.has(lc)) {
      return { reason: 'hidden-or-system-path', detail: `inside hidden/system folder "${c}"` };
    }
  }
  const { ext } = splitExt(posixBasename(file));
  if (DISC_IMAGE_EXTS.has(ext.toLowerCase())) {
    return { reason: 'disc-image', detail: `disc-image file extension .${ext}` };
  }
  return null;
}

// ── Library-root resolution ────────────────────────────────────────────────────

/**
 * Longest-prefix match of a file against the configured library roots. Files
 * never change share/root by construction — the matched root is the `{root}`
 * of every generated target path. Null when the file lives under no root.
 */
export function resolveLibraryRoot(file: string, roots: LibraryRoot[]): LibraryRoot | null {
  const key = pathKey(file);
  let best: LibraryRoot | null = null;
  for (const root of roots) {
    const rootKey = pathKey(root.path.replace(/\/+$/, ''));
    if (key === rootKey || key.startsWith(`${rootKey}/`)) {
      if (!best || rootKey.length > pathKey(best.path).length) best = root;
    }
  }
  return best;
}

// ── .plexmatch content ─────────────────────────────────────────────────────────

/**
 * The emitted .plexmatch for a show folder: identity pins only (title/year +
 * every known id) — deliberately NO per-episode `ep:` lines, since canonical
 * `sNNeNN` filenames already parse deterministically and per-episode hints
 * couple the file to exact paths (a maintenance liability). Title is raw Plex
 * text (this is Plex-parsed content, not a filesystem name) minus newlines.
 */
export function buildPlexmatch(show: ShowRef): string {
  const lines: string[] = [`title: ${show.title.replace(/[\r\n]+/g, ' ').trim()}`];
  if (show.year !== undefined) lines.push(`year: ${show.year}`);
  if (show.tvdbId !== undefined) lines.push(`tvdbid: ${show.tvdbId}`);
  if (show.tmdbId !== undefined) lines.push(`tmdbid: ${show.tmdbId}`);
  if (show.imdbId !== undefined) lines.push(`imdbid: ${show.imdbId}`);
  return `${lines.join('\n')}\n`;
}

// ── Sidecar planning ───────────────────────────────────────────────────────────

/** Fixed-name assets that move with a MOVIE folder unchanged (never renamed). */
const FIXED_ASSET_PATTERNS: RegExp[] = [
  /^movie\.nfo$/i,
  /^(poster|fanart|background|banner|logo|folder|square)\.(jpg|jpeg|png|webp)$/i,
  /^theme\.mp3$/i,
];

export interface SidecarPlan {
  moves: Array<{ from: string; to: string; role: 'sidecar' | 'asset' }>;
  leftBehind: string[];
}

/**
 * Decide which of the media file's directory siblings move with it. A sibling
 * sharing the media's basename stem + '.' keeps its ENTIRE suffix chain
 * verbatim (`Old.en.forced.srt` → `New.en.forced.srt`; `.idx`/`.sub` pairs
 * fall out naturally) — suffixes are never re-interpreted. Movie folders also
 * carry their fixed-name assets across unchanged. Everything else (release
 * junk, non-matching subtitles like a lone `English.srt`) is left behind and
 * reported — guessing ownership/language is how libraries get corrupted.
 */
export function planSidecars(
  oldDir: string,
  oldStem: string,
  newDir: string,
  newStem: string,
  siblings: DirEntry[],
  opts: { moveFixedAssets: boolean; mediaName: string },
): SidecarPlan {
  const moves: SidecarPlan['moves'] = [];
  const leftBehind: string[] = [];
  const oldStemKey = pathKey(oldStem);
  for (const entry of siblings) {
    if (entry.isDir) continue;
    if (pathKey(entry.name) === pathKey(opts.mediaName)) continue; // the media file itself
    const nameKey = pathKey(entry.name);
    if (nameKey === '.plexmatch') {
      leftBehind.push(`${oldDir}/${entry.name}`);
      continue;
    }
    if (nameKey.startsWith(`${oldStemKey}.`)) {
      const suffix = entry.name.slice(oldStem.length); // includes the leading '.'
      moves.push({ from: `${oldDir}/${entry.name}`, to: `${newDir}/${newStem}${suffix}`, role: 'sidecar' });
      continue;
    }
    if (opts.moveFixedAssets && FIXED_ASSET_PATTERNS.some((re) => re.test(entry.name))) {
      moves.push({ from: `${oldDir}/${entry.name}`, to: `${newDir}/${entry.name}`, role: 'asset' });
      continue;
    }
    leftBehind.push(`${oldDir}/${entry.name}`);
  }
  return { moves, leftBehind };
}

// ── Canonical name builders ────────────────────────────────────────────────────

const EDITION_MAX_CHARS = 32; // Plex's documented {edition-...} limit

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function movieIdTag(m: MovieRef): string | null {
  if (m.tmdbId !== undefined) return `{tmdb-${m.tmdbId}}`;
  if (m.imdbId) return `{imdb-${m.imdbId}}`;
  return null;
}

function showIdTag(s: ShowRef): string | null {
  if (s.tvdbId !== undefined) return `{tvdb-${s.tvdbId}}`;
  if (s.tmdbId !== undefined) return `{tmdb-${s.tmdbId}}`;
  return null;
}

/** True for Plex's placeholder episode titles that add nothing to a filename. */
function isPlaceholderTitle(title: string): boolean {
  return /^episode\s+\d+$/i.test(title.trim()) || /^tba$/i.test(title.trim());
}

// ── The per-item decision ──────────────────────────────────────────────────────

function skip(reason: SkipReason, detail: string): RenameDecision {
  return { kind: 'skip', reason, detail };
}

export function decideRename(input: RenameInput): RenameDecision {
  const root = resolveLibraryRoot(input.file, input.roots);
  if (!root) return skip('unmapped-root', `${input.file} is under no configured library root`);

  const guard = currentPathGuard(input.file);
  if (guard) return skip(guard.reason, guard.detail);

  if (input.mediaCount > 1) {
    return skip('multi-version', `item has ${input.mediaCount} Media versions — v1 never renames multi-version items`);
  }

  const mediaName = posixBasename(input.file);
  const { ext } = splitExt(mediaName);
  if (!ext) return skip('ambiguous-metadata', `media file "${mediaName}" has no extension`);

  const partSuffix = input.partCount > 1 ? ` - pt${input.partIndex + 1}` : '';

  const rootPath = root.path.replace(/\/+$/, '');

  if (input.kind === 'movie') {
    const m = input.movie;
    if (!m) return skip('ambiguous-metadata', 'movie input carries no MovieRef');
    const idTag = movieIdTag(m);
    if (!idTag) return skip('missing-id', `"${m.title}" has no tmdb/imdb GUID — unmatched, renaming would cement garbage`);
    if (m.year === undefined) return skip('missing-year', `"${m.title}" has no year — bad-match smell, review manually`);

    const title = sanitizeComponent(m.title);
    if (!title) return skip('ambiguous-metadata', `movie title "${m.title}" sanitized to nothing`);

    const base = `${title} (${m.year}) ${idTag}`;
    let editionSuffix = '';
    if (m.editionTitle) {
      const edition = sanitizeComponent(m.editionTitle, EDITION_MAX_CHARS * 4);
      if (edition) editionSuffix = ` {edition-${[...edition].slice(0, EDITION_MAX_CHARS).join('').trim()}}`;
    }
    const folder = base;
    const fileName = `${base}${editionSuffix}${partSuffix}.${ext}`;
    if (byteLen(folder) > MAX_COMPONENT_BYTES || byteLen(fileName) > MAX_COMPONENT_BYTES) {
      return skip('path-too-long', `generated name exceeds ${MAX_COMPONENT_BYTES} bytes: "${fileName}"`);
    }
    if (hasExclusionHazard(folder, { isDir: true })) {
      return skip('sample-filter-hazard', `generated folder "${folder}" matches a Plex special-directory name`);
    }
    if (hasExclusionHazard(fileName, { isDir: false, sizeBytes: input.partSize })) {
      return skip('sample-filter-hazard', `generated file name "${fileName}" would trip the <300MB "sample" filter`);
    }

    const newDir = `${rootPath}/${folder}`;
    const targetPath = `${newDir}/${fileName}`;
    return assembleDecision(input, targetPath, newDir, null, ext, { moveFixedAssets: true, mediaName });
  }

  // ── episode ──
  const show = input.show;
  if (!show) return skip('ambiguous-metadata', 'episode input carries no ShowRef');
  if (show.hasExistingPlexmatch) {
    return skip('existing-plexmatch', `show "${show.title}" already has a .plexmatch — never clobbered or renamed under`);
  }
  const idTag = showIdTag(show);
  if (!idTag) return skip('missing-id', `show "${show.title}" has no tvdb/tmdb GUID — unmatched, renaming would cement garbage`);

  const episodes = [...(input.episodes ?? [])].sort((a, b) => a.season - b.season || a.episode - b.episode);
  if (episodes.length === 0) return skip('ambiguous-metadata', 'episode input carries no EpisodeRef list');

  const showTitle = sanitizeComponent(show.title);
  if (!showTitle) return skip('ambiguous-metadata', `show title "${show.title}" sanitized to nothing`);
  const showBase = show.year !== undefined ? `${showTitle} (${show.year})` : showTitle;
  const showFolder = `${showBase} ${idTag}`;
  if (hasExclusionHazard(showFolder, { isDir: true })) {
    return skip('sample-filter-hazard', `generated show folder "${showFolder}" matches a Plex special-directory name`);
  }

  const first = episodes[0];
  let seasonFolder: string;
  let epToken: string;
  const dateBased = first.season >= 1900;
  if (dateBased) {
    if (!first.airDate) {
      return skip('missing-episode-numbering', `date-based season ${first.season} but no originallyAvailableAt on the episode`);
    }
    seasonFolder = `Season ${first.season}`;
    epToken = first.airDate;
  } else {
    if (first.season === undefined || first.episode === undefined) {
      return skip('missing-episode-numbering', 'episode lacks parentIndex/index');
    }
    if (episodes.length > 1) {
      const sameSeason = episodes.every((e) => e.season === first.season);
      const contiguous = episodes.every((e, i) => i === 0 || e.episode === episodes[i - 1].episode + 1);
      if (!sameSeason || !contiguous) {
        return skip(
          'non-contiguous-multi-episode',
          `file spans ${episodes.map((e) => `s${pad2(e.season)}e${pad2(e.episode)}`).join(',')} — not a contiguous same-season range`,
        );
      }
      epToken = `s${pad2(first.season)}e${pad2(first.episode)}-e${pad2(episodes[episodes.length - 1].episode)}`;
    } else {
      epToken = `s${pad2(first.season)}e${pad2(first.episode)}`;
    }
    seasonFolder = `Season ${pad2(first.season)}`;
  }

  // Episode titles are all-or-nothing: sanitized at the full component budget
  // (never mid-truncated into gibberish) — if the resulting file name is over
  // budget, the ladder below drops the title ENTIRELY rather than clipping it.
  const epTitleRaw = first.title && !isPlaceholderTitle(first.title) ? sanitizeComponent(first.title, MAX_COMPONENT_BYTES) : null;
  let fileName = epTitleRaw
    ? `${showBase} - ${epToken} - ${epTitleRaw}${partSuffix}.${ext}`
    : `${showBase} - ${epToken}${partSuffix}.${ext}`;
  if (byteLen(fileName) > MAX_COMPONENT_BYTES) {
    // Length fallback ladder: drop the episode title first, then give up.
    fileName = `${showBase} - ${epToken}${partSuffix}.${ext}`;
    if (byteLen(fileName) > MAX_COMPONENT_BYTES) {
      return skip('path-too-long', `even without an episode title the name exceeds ${MAX_COMPONENT_BYTES} bytes: "${fileName}"`);
    }
  }
  if (byteLen(showFolder) > MAX_COMPONENT_BYTES) {
    return skip('path-too-long', `generated show folder exceeds ${MAX_COMPONENT_BYTES} bytes: "${showFolder}"`);
  }
  if (hasExclusionHazard(fileName, { isDir: false, sizeBytes: input.partSize })) {
    return skip('sample-filter-hazard', `generated file name "${fileName}" would trip the <300MB "sample" filter`);
  }

  const showDir = `${rootPath}/${showFolder}`;
  const newDir = `${showDir}/${seasonFolder}`;
  const targetPath = `${newDir}/${fileName}`;
  return assembleDecision(input, targetPath, newDir, { dir: showDir, content: buildPlexmatch(show) }, ext, {
    moveFixedAssets: false,
    mediaName,
  });
}

/** Compose the final decision: already-canonical detection, sidecars, ordered ops. */
function assembleDecision(
  input: RenameInput,
  targetPath: string,
  newDir: string,
  plexmatch: { dir: string; content: string } | null,
  ext: string,
  sidecarOpts: { moveFixedAssets: boolean; mediaName: string },
): RenameDecision {
  const oldDir = posixDirname(input.file);
  const oldStem = splitExt(posixBasename(input.file)).stem;
  const newStem = splitExt(posixBasename(targetPath)).stem;

  const sidecars = planSidecars(oldDir, oldStem, newDir, newStem, input.siblings, sidecarOpts);

  const mediaExact = input.file.normalize('NFC') === targetPath.normalize('NFC');
  const sidecarsExact = sidecars.moves.every((s) => s.from.normalize('NFC') === s.to.normalize('NFC'));
  if (mediaExact && sidecarsExact) {
    return { kind: 'already-canonical', targetPath };
  }

  const ops: NamingOp[] = [{ op: 'mkdir', path: newDir }];
  if (plexmatch) ops.push({ op: 'write-plexmatch', dir: plexmatch.dir, content: plexmatch.content });
  if (!mediaExact) {
    ops.push({
      op: 'move',
      from: input.file,
      to: targetPath,
      role: 'media',
      caseOnly: pathKey(input.file) === pathKey(targetPath),
    });
  }
  for (const s of sidecars.moves) {
    if (s.from.normalize('NFC') === s.to.normalize('NFC')) continue;
    ops.push({ op: 'move', from: s.from, to: s.to, role: s.role, caseOnly: pathKey(s.from) === pathKey(s.to) });
  }
  return { kind: 'rename', ops, leftBehind: sidecars.leftBehind, targetPath };
}

// ── Plan-level finalization (cross-item) ───────────────────────────────────────

export interface PlanEntry {
  key: string;
  decision: RenameDecision;
}

/**
 * Cross-item pass over every per-item decision:
 *  1. Two+ items computing the SAME target (case-folded NFC) → ALL of them are
 *     downgraded to `target-collision` skips (never "first wins" — order
 *     dependence would make re-runs unstable).
 *  2. A target that already exists on disk (`existingPaths`, the case-folded
 *     set of every file discover walked) and is not the item's own current
 *     path → `target-collision` (apply re-checks at execution time too — this
 *     keeps the PLAN report honest).
 *  3. `write-plexmatch` ops deduped per show dir (first item keeps it), and
 *     `mkdir` ops deduped within each item (they're idempotent anyway).
 * Deterministic: input order never changes the outcome set.
 */
export function finalizePlan(entries: PlanEntry[], existingPaths: ReadonlySet<string>): PlanEntry[] {
  const byTarget = new Map<string, PlanEntry[]>();
  for (const e of entries) {
    if (e.decision.kind !== 'rename') continue;
    const k = pathKey(e.decision.targetPath);
    const list = byTarget.get(k) ?? [];
    list.push(e);
    byTarget.set(k, list);
  }

  const collided = new Set<string>();
  for (const [, list] of byTarget) {
    if (list.length > 1) for (const e of list) collided.add(e.key);
  }

  const seenPlexmatchDirs = new Set<string>();
  const out: PlanEntry[] = [];
  for (const e of entries) {
    if (e.decision.kind !== 'rename') {
      out.push(e);
      continue;
    }
    const mediaMove = e.decision.ops.find((o) => o.op === 'move' && o.role === 'media') as
      | Extract<NamingOp, { op: 'move' }>
      | undefined;
    if (collided.has(e.key)) {
      out.push({
        key: e.key,
        decision: skip('target-collision', `two or more items compute the same target ${e.decision.targetPath}`),
      });
      continue;
    }
    const targetKey = pathKey(e.decision.targetPath);
    const ownCurrentKey = mediaMove ? pathKey(mediaMove.from) : null;
    if (existingPaths.has(targetKey) && targetKey !== ownCurrentKey) {
      out.push({
        key: e.key,
        decision: skip('target-collision', `target ${e.decision.targetPath} already exists on disk`),
      });
      continue;
    }

    const ops: NamingOp[] = [];
    const seenMkdirs = new Set<string>();
    for (const op of e.decision.ops) {
      if (op.op === 'mkdir') {
        const k = pathKey(op.path);
        if (seenMkdirs.has(k)) continue;
        seenMkdirs.add(k);
        ops.push(op);
      } else if (op.op === 'write-plexmatch') {
        const k = pathKey(op.dir);
        if (seenPlexmatchDirs.has(k)) continue;
        seenPlexmatchDirs.add(k);
        ops.push(op);
      } else {
        ops.push(op);
      }
    }
    out.push({ key: e.key, decision: { ...e.decision, ops } });
  }
  return out;
}
