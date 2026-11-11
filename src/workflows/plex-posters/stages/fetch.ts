import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { callService } from '../../../core/services.js';
import { plexGetBinary } from '../../../core/plex-client.js';
import { readJsonFile, writeJsonFile, type JobContext } from '../../../engine/index.js';
import { assertArchiveReady, label, listArchiveImages, mapPool, readManifest, storeImage } from '../lib.js';
import type { FetchCounts, FetchError, PosterItemWithImage, PosterList, PosterSet, StoredImage } from '../types.js';

/** Download one poster by its Plex path. Injectable so tests need no Plex. */
export type PosterDownloader = (thumb: string) => Promise<{ buffer: Buffer; contentType: string }>;

const liveDownload: PosterDownloader = (thumb) => callService('plex', () => plexGetBinary(thumb));

/** Poster path → the archived image it was last seen as. */
type PosterIndex = Record<string, StoredImage>;

const SAVE_INDEX_EVERY = 50;

export interface FetchOptions {
  archiveDir: string;
  /** Local index of what has been downloaded (poster path → image). */
  indexFile: string;
  download?: PosterDownloader;
  concurrency?: number;
  now?: Date;
}

/**
 * Make sure the archive holds the current poster of every listed title, and say
 * which image each title now points at.
 *
 * A poster is only downloaded when its path is new. Plex puts a version number in
 * a poster's path and bumps it whenever the poster (or just the item's metadata)
 * changes, so a path seen before, whose image is still in the archive, needs no
 * download. Two records answer "seen before": the local index file, which is saved
 * as this stage goes so that a retry after a failure does not download again what
 * the first attempt already stored, and, when that file is missing (a fresh
 * checkout, or after "Clear output data"), the archive's own latest snapshot.
 *
 * This is not an `eachItem` loop on purpose. Nothing here is ever "done": every
 * title is looked at again every week, and what makes the work skippable is the
 * poster's path, not a ledger row.
 */
export async function runFetch(ctx: JobContext, list: PosterList, opts: FetchOptions): Promise<PosterSet> {
  const { archiveDir, indexFile } = opts;
  const download = opts.download ?? liveDownload;
  const concurrency = opts.concurrency ?? 4;
  ctx.log(`plex-posters-fetch starting: ${list.items.length} title(s), archive at ${archiveDir || '(not set)'}, ${concurrency} download(s) at a time`);

  await callService('fs', async () => assertArchiveReady(archiveDir));
  const archived = await callService('fs', async () => listArchiveImages(archiveDir));
  ctx.log(`The archive holds ${archived.size} image(s)`);

  // What is already known: the archive's latest snapshot first, then the local
  // index over it (it is newer, and has what a failed attempt downloaded).
  const index: PosterIndex = {};
  const latest = await callService('fs', async () => readManifest(join(archiveDir, 'latest.json')));
  for (const item of latest?.items ?? []) if (item.thumb && item.image) index[item.thumb] = item.image;
  const fromLatest = Object.keys(index).length;
  const local = existsSync(indexFile) ? readJsonFile<PosterIndex>(indexFile, {}) : {};
  Object.assign(index, local);
  ctx.log(`Known poster paths: ${fromLatest} from the archive's latest snapshot${latest ? ` (${latest.createdAt})` : ' (there is none yet)'}, ${Object.keys(local).length} from the local index`);

  const counts: FetchCounts = { items: list.items.length, downloaded: 0, reused: 0, noPoster: 0, failed: 0 };
  const errors: FetchError[] = [];
  const items: PosterItemWithImage[] = new Array(list.items.length);
  let done = 0;
  let unsaved = 0;
  let newBytes = 0;
  const saveIndex = () => {
    mkdirSync(dirname(indexFile), { recursive: true });
    writeJsonFile(indexFile, index);
    unsaved = 0;
  };

  await mapPool(list.items, concurrency, async (item, i) => {
    const name = label(item);
    try {
      if (!item.thumb) {
        items[i] = { ...item, image: null };
        counts.noPoster++;
        return;
      }
      const known = index[item.thumb];
      if (known && archived.has(known.file)) {
        items[i] = { ...item, image: known };
        counts.reused++;
        return;
      }
      const { buffer, contentType } = await download(item.thumb);
      const wasThere = archived.size;
      const image = await callService('fs', async () => storeImage(archiveDir, buffer, contentType, archived));
      const isNewImage = archived.size > wasThere;
      if (isNewImage) newBytes += image.bytes;
      index[item.thumb] = image;
      items[i] = { ...item, image };
      counts.downloaded++;
      unsaved++;
      ctx.log(`  downloaded ${name}: ${(image.bytes / 1_000_000).toFixed(1)} MB, ${isNewImage ? 'new to the archive' : 'same image as one already archived'}`);
      if (unsaved >= SAVE_INDEX_EVERY) saveIndex();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      items[i] = { ...item, image: null };
      counts.failed++;
      errors.push({ ratingKey: item.ratingKey, label: name, error: message });
      ctx.log(`  FAILED ${name}: ${message}`, 'error');
    } finally {
      done++;
      if (done % 250 === 0 || done === list.items.length) {
        ctx.log(`${done}/${list.items.length} checked (${counts.downloaded} downloaded, ${counts.reused} already archived)`);
        ctx.progress((done / list.items.length) * 100, `${done}/${list.items.length} checked`);
      }
    }
  });
  saveIndex();

  ctx.log(
    `plex-posters-fetch complete: ${counts.downloaded} downloaded (${(newBytes / 1_000_000).toFixed(1)} MB new to the archive), ` +
      `${counts.reused} already archived, ${counts.noPoster} with no poster, ${counts.failed} failed`,
    counts.failed ? 'error' : 'info',
  );
  // A few failures do not stop the backup: they are recorded here, the snapshot
  // is still written, and the last stage fails the run so the owner hears about
  // them. Too many means Plex was unwell: the output's own check refuses the set,
  // this attempt fails, and the retry downloads only what is still missing.
  return { generatedAt: (opts.now ?? new Date()).toISOString(), server: list.server, counts, errors, items };
}
