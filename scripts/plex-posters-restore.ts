/**
 * Put Plex posters back from the poster archive that the plex-poster-backup
 * workflow keeps. Manual, never scheduled: it is the one part of that workflow
 * that WRITES to Plex.
 *
 * It reads a snapshot (the archive's latest.json unless told otherwise), finds
 * each title in the library as it is now, and for every title whose current
 * poster is not the one in the snapshot, makes it so: selects the image if Plex
 * still holds it as an upload, otherwise uploads it from the archive, then locks
 * the poster so a metadata refresh does not replace it again.
 *
 * DRY RUN by default: it prints what it would restore and changes nothing. Pass
 * --apply to act.
 *
 *   npx tsx scripts/plex-posters-restore.ts
 *   npx tsx scripts/plex-posters-restore.ts --match "severance"
 *   npx tsx scripts/plex-posters-restore.ts --snapshot <archive>/snapshots/posters-<stamp>.json --apply
 *
 * Options:
 *   --apply              actually change Plex
 *   --dir <path>         the archive folder (default PLEX_POSTER_ARCHIVE_DIR)
 *   --snapshot <path>    which snapshot to restore (default <dir>/latest.json)
 *   --types <a,b>        any of show,season,movie (default all)
 *   --match <text>       only titles whose name contains this text
 *   --deep               compare image bytes even when the poster path is unchanged
 *   --force              restore even where the poster already matches
 *   --no-lock            do not lock the poster after restoring it
 *   --concurrency <n>    titles handled at once (default 4)
 *
 * How a title is found again: by its ratingKey when the snapshot came from this
 * same server and the title is still the same one; otherwise by its Plex guid
 * (a season by its show's guid and its number); otherwise by name and year. A
 * title that matches more than one candidate is left alone unless exactly one of
 * them is in the library the snapshot recorded.
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callService } from '../src/core/services.js';
import { plexGet, plexGetBinary, plexPostBinary, plexPut } from '../src/core/plex-client.js';
import { label, mapPool, readManifest, sha1 } from '../src/workflows/plex-posters/lib.js';
import { runList } from '../src/workflows/plex-posters/stages/list.js';
import type { PosterItem, PosterItemType, PosterItemWithImage, SnapshotManifest } from '../src/workflows/plex-posters/types.js';

const TYPE_IDS: Record<PosterItemType, number> = { movie: 1, show: 2, season: 3 };
const ALL_TYPES: PosterItemType[] = ['show', 'season', 'movie'];

/** One entry of a title's poster list, as Plex returns it. */
export interface PosterCandidate {
  /** What Plex wants back to select this image, e.g. `upload://posters/<sha1>`. */
  ratingKey: string;
  selected: boolean;
}

/** Everything the restore does to the outside world, so a test can stand in for all of it. */
export interface RestoreDeps {
  machineIdentifier(): Promise<string>;
  listCurrent(): Promise<PosterItem[]>;
  posters(ratingKey: string): Promise<PosterCandidate[]>;
  download(thumb: string): Promise<Buffer>;
  readImage(file: string): Buffer | null;
  select(ratingKey: string, posterKey: string): Promise<void>;
  upload(ratingKey: string, body: Buffer, contentType: string): Promise<void>;
  lock(item: PosterItem): Promise<void>;
}

export interface RestoreOptions {
  apply: boolean;
  types?: PosterItemType[];
  match?: string;
  deep?: boolean;
  force?: boolean;
  lock?: boolean;
  concurrency?: number;
  log?: (line: string) => void;
}

export interface RestoreResult {
  ok: string[];
  restored: string[];
  wouldRestore: string[];
  notFound: string[];
  noBackup: string[];
  failed: string[];
}

const nameKey = (item: PosterItem): string => {
  const parts: (string | number | null | undefined)[] = [item.type, item.title.toLowerCase(), item.year ?? ''];
  if (item.type === 'season') parts.push(item.show?.title.toLowerCase(), item.show?.year ?? '', item.index);
  return parts.join('|');
};
const realGuid = (g: string | null | undefined): string | null => (g && !g.startsWith('local://') ? g : null);

export interface LibraryIndex {
  byKey: Map<string, PosterItem>;
  byGuid: Map<string, PosterItem[]>;
  bySeason: Map<string, PosterItem[]>;
  byName: Map<string, PosterItem[]>;
}

export function buildIndex(items: PosterItem[]): LibraryIndex {
  const index: LibraryIndex = { byKey: new Map(), byGuid: new Map(), bySeason: new Map(), byName: new Map() };
  const add = (map: Map<string, PosterItem[]>, key: string | null, item: PosterItem) => {
    if (!key) return;
    (map.get(key) ?? map.set(key, []).get(key)!).push(item);
  };
  for (const item of items) {
    index.byKey.set(item.ratingKey, item);
    add(index.byGuid, realGuid(item.guid) ? `${item.type}|${item.guid}` : null, item);
    add(index.bySeason, item.type === 'season' && realGuid(item.show?.guid) ? `${item.show!.guid}|${item.index}` : null, item);
    add(index.byName, nameKey(item), item);
  }
  return index;
}

/** Find the library item a saved one refers to, and say how it was matched. Null when there is no single answer. */
export function findTarget(saved: PosterItem, index: LibraryIndex, sameServer: boolean): { item: PosterItem; how: string } | null {
  if (sameServer) {
    const byKey = index.byKey.get(saved.ratingKey);
    if (byKey && byKey.type === saved.type && (!saved.guid || byKey.guid === saved.guid)) return { item: byKey, how: 'ratingKey' };
  }
  const pick = (list: PosterItem[] | undefined): PosterItem | null => {
    if (!list || list.length === 0) return null;
    if (list.length === 1) return list[0];
    const sameSection = list.filter((c) => c.sectionTitle === saved.sectionTitle);
    return sameSection.length === 1 ? sameSection[0] : null;
  };
  const attempts: [string, PosterItem[] | undefined][] = [
    ['guid', realGuid(saved.guid) ? index.byGuid.get(`${saved.type}|${saved.guid}`) : undefined],
    ['show+season', saved.type === 'season' && realGuid(saved.show?.guid) ? index.bySeason.get(`${saved.show!.guid}|${saved.index}`) : undefined],
    ['title', index.byName.get(nameKey(saved))],
  ];
  for (const [how, list] of attempts) {
    const item = pick(list);
    if (item) return { item, how };
  }
  return null;
}

const isUploadOf = (poster: PosterCandidate, hash: string): boolean => poster.ratingKey.startsWith('upload://') && poster.ratingKey.endsWith(`/${hash}`);

export async function restorePosters(snapshot: SnapshotManifest, opts: RestoreOptions, deps: RestoreDeps): Promise<RestoreResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const types = opts.types ?? ALL_TYPES;
  const lock = opts.lock ?? true;
  const result: RestoreResult = { ok: [], restored: [], wouldRestore: [], notFound: [], noBackup: [], failed: [] };

  const sameServer = (await deps.machineIdentifier()) === snapshot.server.machineIdentifier;
  if (!sameServer) log('This snapshot came from a different Plex server: matching by guid and title only.');
  const saved = snapshot.items.filter((item) => types.includes(item.type) && (!opts.match || label(item).toLowerCase().includes(opts.match.toLowerCase())));
  const index = buildIndex((await deps.listCurrent()).filter((i) => types.includes(i.type)));
  log(`${opts.apply ? 'RESTORING' : 'DRY RUN: checking'} ${saved.length} title(s) from the snapshot of ${snapshot.createdAt}`);

  let done = 0;
  await mapPool(saved, opts.concurrency ?? 4, async (item: PosterItemWithImage) => {
    const name = label(item);
    try {
      if (!item.image) {
        result.noBackup.push(name);
        return;
      }
      const hash = item.image.sha1;
      const found = findTarget(item, index, sameServer);
      if (!found) {
        result.notFound.push(name);
        return;
      }
      const target = found.item;
      // An unchanged poster path means Plex is still showing the same image.
      if (!opts.force && !opts.deep && target.thumb && target.thumb === item.thumb) {
        result.ok.push(name);
        return;
      }
      const posters = await deps.posters(target.ratingKey);
      const selected = posters.find((p) => p.selected);
      const existingUpload = posters.find((p) => isUploadOf(p, hash)) ?? null;
      let matches = !!selected && isUploadOf(selected, hash);
      // Not an upload of ours: the only way to know is to compare the bytes.
      if (!matches && target.thumb && !(selected && selected.ratingKey.startsWith('upload://') && /\/[0-9a-f]{40}$/.test(selected.ratingKey))) {
        matches = sha1(await deps.download(target.thumb)) === hash;
      }
      if (matches && !opts.force) {
        result.ok.push(name);
        return;
      }
      const note = found.how === 'ratingKey' ? name : `${name} (matched by ${found.how})`;
      if (!opts.apply) {
        result.wouldRestore.push(note);
        return;
      }

      if (existingUpload) {
        await deps.select(target.ratingKey, existingUpload.ratingKey);
      } else {
        const body = deps.readImage(item.image.file);
        if (!body) throw new Error(`image file missing from the archive: ${item.image.file}`);
        await deps.upload(target.ratingKey, body, item.image.contentType || 'image/jpeg');
      }
      // Plex usually selects a fresh upload itself. Make sure, and select it if not.
      let after = await deps.posters(target.ratingKey);
      if (!after.some((p) => p.selected && isUploadOf(p, hash))) {
        const uploaded = after.find((p) => isUploadOf(p, hash));
        if (!uploaded) throw new Error('the upload did not appear in the poster list');
        await deps.select(target.ratingKey, uploaded.ratingKey);
        after = await deps.posters(target.ratingKey);
        if (!after.some((p) => p.selected && isUploadOf(p, hash))) throw new Error('poster uploaded but Plex did not select it');
      }
      if (lock) await deps.lock(target);
      result.restored.push(note);
      log(`  restored ${note}`);
    } catch (e) {
      result.failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      log(`  FAILED ${name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      done++;
      if (done % 500 === 0) log(`  checked ${done}/${saved.length}`);
    }
  });

  const section = (title: string, names: string[], limit = 40) => {
    if (names.length === 0) return;
    log(`\n${title} (${names.length}):`);
    for (const n of names.slice(0, limit)) log(`  ${n}`);
    if (names.length > limit) log(`  ...and ${names.length - limit} more`);
  };
  section(opts.apply ? 'Restored' : 'Would restore', opts.apply ? result.restored : result.wouldRestore);
  section('Not found in the library now', result.notFound);
  section('Failed', result.failed);
  log(`\n${result.ok.length} already showing the saved poster · ${result.noBackup.length} had no poster when the snapshot was taken`);
  if (!opts.apply && result.wouldRestore.length > 0) log('DRY RUN: nothing was changed. Run again with --apply to restore these.');
  return result;
}

/** The real thing: Plex through the shared client, images from the archive folder. */
export function liveDeps(archiveDir: string): RestoreDeps {
  const quiet = { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
  type Posters = { MediaContainer?: { Metadata?: { ratingKey?: string; key?: string; selected?: boolean }[] } };
  return {
    machineIdentifier: async () => (await callService('plex', () => plexGet<{ MediaContainer?: { machineIdentifier?: string } }>('/identity')))?.MediaContainer?.machineIdentifier ?? '',
    listCurrent: async () => (await runList(quiet)).items,
    posters: async (ratingKey) => ((await callService('plex', () => plexGet<Posters>(`/library/metadata/${ratingKey}/posters`)))?.MediaContainer?.Metadata ?? [])
      .map((p) => ({ ratingKey: String(p.ratingKey ?? p.key ?? ''), selected: p.selected === true })),
    download: async (thumb) => (await callService('plex', () => plexGetBinary(thumb))).buffer,
    readImage: (file) => (existsSync(join(archiveDir, file)) ? readFileSync(join(archiveDir, file)) : null),
    select: (ratingKey, posterKey) => callService('plex', () => plexPut(`/library/metadata/${ratingKey}/poster`, { url: posterKey })),
    upload: (ratingKey, body, contentType) => callService('plex', () => plexPostBinary(`/library/metadata/${ratingKey}/posters`, body, contentType)),
    lock: (item) => callService('plex', () => plexPut(`/library/sections/${item.sectionId}/all`, { type: String(TYPE_IDS[item.type]), id: item.ratingKey, 'thumb.locked': '1' })),
  };
}

function parseArgs(argv: string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const [name, inline] = argv[i].slice(2).split('=', 2);
    if (inline !== undefined) flags[name] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
    else flags[name] = true;
  }
  return flags;
}

const isMain = process.argv[1]?.endsWith('plex-posters-restore.ts');
if (isMain) {
  const flags = parseArgs(process.argv.slice(2));
  const dir = typeof flags.dir === 'string' ? flags.dir : (process.env.PLEX_POSTER_ARCHIVE_DIR ?? '');
  const snapshotPath = typeof flags.snapshot === 'string' ? flags.snapshot : join(dir, 'latest.json');
  const types = typeof flags.types === 'string' ? (flags.types.split(',').map((t) => t.trim()).filter(Boolean) as PosterItemType[]) : undefined;
  (async () => {
    if (!dir) throw new Error('No archive folder: set PLEX_POSTER_ARCHIVE_DIR or pass --dir');
    if (types?.some((t) => !ALL_TYPES.includes(t))) throw new Error(`Unknown type in --types. Use any of ${ALL_TYPES.join(',')}`);
    const snapshot = readManifest(snapshotPath);
    if (!snapshot) throw new Error(`No snapshot at ${snapshotPath}. Is the archive's share mounted?`);
    const result = await restorePosters(snapshot, {
      apply: flags.apply === true,
      types,
      match: typeof flags.match === 'string' ? flags.match : undefined,
      deep: flags.deep === true,
      force: flags.force === true,
      lock: flags['no-lock'] !== true,
      concurrency: Number(flags.concurrency) || 4,
    }, liveDeps(dir));
    process.exit(result.failed.length > 0 ? 1 : 0);
  })().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
