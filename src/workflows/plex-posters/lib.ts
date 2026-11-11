// Pure helpers and the archive's file handling for plex-poster-backup.
//
// Archive layout (content-addressed, so a repeat backup only stores new images):
//
//   <archive>/.plex-poster-archive      marker: proves this really is the archive
//   <archive>/images/<sha1>.<ext>       the posters, named by the SHA-1 of their bytes
//   <archive>/snapshots/posters-<stamp>.json   one manifest per backup
//   <archive>/latest.json               a copy of the newest manifest
//
// SHA-1 is deliberate: Plex names an uploaded poster `upload://posters/<sha1 of the
// file>`, so the restore script can tell whether Plex already holds an image
// without sending it again.
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PosterChange, PosterItem, PosterItemWithImage, SnapshotManifest, StoredImage } from './types.js';

export const ARCHIVE_MARKER = '.plex-poster-archive';
/**
 * How many posters may fail to download before the backup is called off. A few
 * (one title whose artwork Plex cannot serve) must not stop every other poster
 * being recorded; many means Plex was unwell and the run should fail and retry.
 */
export const failureTolerance = (items: number): number => Math.max(10, Math.floor(items * 0.02));
/** How many changed posters a report lists (the counts are always complete). */
export const CHANGE_LIST_CAP = 500;

const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export const sha1 = (buffer: Buffer): string => crypto.createHash('sha1').update(buffer).digest('hex');
export const extensionFor = (contentType: string): string => EXTENSIONS[contentType] ?? 'jpg';

/** "Severance (2022) / Season 2", "Heat (1995)". */
export function label(item: PosterItem): string {
  const withYear = (title: string, year: string | null | undefined) => (year ? `${title} (${year})` : title);
  if (item.type === 'season' && item.show) return `${withYear(item.show.title, item.show.year)} / ${item.title}`;
  return withYear(item.title, item.year);
}

/**
 * A key for "the same title" across two snapshots. Plex gives an item a new
 * ratingKey when it re-creates it (after a file move, say), so the Plex guid is
 * preferred; a season is its show's guid plus its number. Falls back to the
 * ratingKey for an unmatched item (`local://…`) or one with no guid.
 *
 * The LIBRARY is part of the key. The same show can sit in two libraries (the
 * owner has 73 titles in both "TV shows" and a second TV library), with the same
 * guid and a different poster in each. Without the library in the key the two
 * copies were compared with each other, and the first real run reported 67
 * posters as changed that had not been touched.
 */
export function identityKey(item: PosterItem): string {
  const real = (g: string | null | undefined) => (g && !g.startsWith('local://') ? g : null);
  const lib = `lib:${item.sectionId}`;
  if (item.type === 'season' && real(item.show?.guid) && item.index != null) return `${lib}|season|${item.show!.guid}|${item.index}`;
  const guid = real(item.guid);
  return guid ? `${lib}|${item.type}|${guid}` : `${lib}|${item.type}|key:${item.ratingKey}`;
}

/**
 * Refuse to touch an archive that is not really there. The archive usually sits on
 * a network share, and when the share is not mounted macOS can leave an EMPTY
 * folder at the mount point. Creating the archive's folders there would quietly
 * put gigabytes on the local disk and make the mount point look healthy. So the
 * archive's root is never created here: it must already exist and hold the marker
 * file. Only then are the two subfolders made.
 */
export function assertArchiveReady(archiveDir: string): void {
  if (!archiveDir) {
    throw new Error('PLEX_POSTER_ARCHIVE_DIR is not set. Point it at the folder that holds the poster archive (see this workflow\'s CLAUDE.md).');
  }
  if (!existsSync(join(archiveDir, ARCHIVE_MARKER))) {
    throw new Error(
      `The poster archive was not found at ${archiveDir} (no ${ARCHIVE_MARKER} marker file). ` +
        'If it is on a network share, the share is probably not mounted. Nothing was written.',
    );
  }
  mkdirSync(join(archiveDir, 'images'), { recursive: true });
  mkdirSync(join(archiveDir, 'snapshots'), { recursive: true });
}

/** Every image the archive holds, as archive-relative paths (`images/<name>`). One listing, not a stat per file. */
export function listArchiveImages(archiveDir: string): Set<string> {
  const dir = join(archiveDir, 'images');
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((f) => !f.endsWith('.part')).map((f) => `images/${f}`));
}

/**
 * Store image bytes under their hash. Written to a `.part` file and renamed into
 * place, so a killed run never leaves half an image under a real name. Skips the
 * write when the file is already there (the same poster on two titles, or an
 * unchanged poster downloaded again).
 */
export function storeImage(archiveDir: string, buffer: Buffer, contentType: string, known?: Set<string>): StoredImage {
  const hash = sha1(buffer);
  const file = `images/${hash}.${extensionFor(contentType)}`;
  const fullPath = join(archiveDir, file);
  if (!(known?.has(file) ?? existsSync(fullPath))) {
    const tmp = `${fullPath}.${process.pid}.part`;
    writeFileSync(tmp, buffer);
    renameSync(tmp, fullPath);
    known?.add(file);
  }
  return { sha1: hash, file, bytes: buffer.length, contentType };
}

/** Read a snapshot manifest, or null when the file is not there. Throws on a file that does not parse. */
export function readManifest(path: string): SnapshotManifest | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as SnapshotManifest;
  if (!parsed || !Array.isArray(parsed.items)) throw new Error(`${path} is not a poster snapshot (no items array)`);
  return parsed;
}

/** `posters-2026-11-05T00-37-19-157Z.json` for an ISO timestamp. */
export const snapshotFileName = (createdAt: string): string => `posters-${createdAt.replace(/[:.]/g, '-')}.json`;

export interface SnapshotDiff {
  compared: number;
  changed: PosterChange[];
  added: string[];
  removed: string[];
}

/**
 * How this set of posters differs from the previous snapshot. A poster has
 * CHANGED when the same title now points at different image bytes (a different
 * SHA-1), or has gained or lost its poster. Plex bumps the version in a poster's
 * path on any metadata refresh, so the path is not compared: only the bytes are.
 */
export function diffSnapshots(previous: PosterItemWithImage[], current: PosterItemWithImage[]): SnapshotDiff {
  const before = new Map(previous.map((i) => [identityKey(i), i]));
  const seen = new Set<string>();
  const changed: PosterChange[] = [];
  const added: string[] = [];
  let compared = 0;
  for (const item of current) {
    const key = identityKey(item);
    seen.add(key);
    const prev = before.get(key);
    if (!prev) {
      added.push(label(item));
      continue;
    }
    compared++;
    const from = prev.image?.sha1 ?? null;
    const to = item.image?.sha1 ?? null;
    if (from !== to) changed.push({ label: label(item), type: item.type, ratingKey: item.ratingKey, from, to, file: item.image?.file ?? null });
  }
  const removed = previous.filter((i) => !seen.has(identityKey(i))).map(label);
  return { compared, changed, added, removed };
}

/** Run an async function over a list with a fixed number of workers. */
export async function mapPool<T>(list: T[], concurrency: number, fn: (value: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
}
