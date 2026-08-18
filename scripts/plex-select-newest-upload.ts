/**
 * Select the MOST RECENTLY UPLOADED artwork on any item carrying several uploads.
 *
 * When the owner replaces a poster, Plex keeps the old image as well as the new
 * one, and its API exposes neither an upload date nor a stable ordering. So an
 * automated restore has no way to tell "the poster they chose last year" from "the
 * one they replaced it with" — the 2026-08-18 sweep picked wrong on 9 titles,
 * including Alien, where it restored a 2023 image over a 2025 one.
 *
 * The dates DO exist, just not over the API: Plex stores each uploaded image as a
 * file inside the item's own metadata bundle, named for the same hash the API
 * reports as `upload://posters/<hash>`, and those files carry mtimes. This reads
 * them straight off the Plex data share and selects the newest per item.
 *
 * Finding an item's bundle: sha1(the item's Plex GUID) gives a 40-char hash; the
 * bundle lives at <Metadata>/<Movies|TV Shows>/<first char>/<remaining 39>.bundle,
 * with uploads under Uploads/posters and Uploads/art.
 *
 * Requires the Plex data share mounted (PLEX_METADATA_DIR to override the default).
 * Reads from the share, writes only through Plex's own API. DRY RUN by default.
 *
 *   npx tsx scripts/plex-select-newest-upload.ts
 *   npx tsx scripts/plex-select-newest-upload.ts --apply
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { callService } from '../src/core/services.js';
import { plexGet, plexPut } from '../src/core/plex-client.js';

const METADATA_DIR =
  process.env.PLEX_METADATA_DIR ?? '/Volumes/PlexMediaServer/AppData/Plex Media Server/Metadata';

type Kind = 'poster' | 'art';

interface Upload {
  hash: string;
  selected: boolean;
  mtimeMs: number | null;
}

export interface SelectResult {
  scanned: number;
  multiUpload: number;
  changed: { title: string; ratingKey: string; kind: Kind; from: string; to: string; toDate: string }[];
  undatable: string[];
  failures: { title: string; error: string }[];
}

/** The metadata bundle directory for an item's GUID. */
export function bundlePathFor(guid: string, section: 'Movies' | 'TV Shows'): string {
  const h = createHash('sha1').update(guid).digest('hex');
  return `${METADATA_DIR}/${section}/${h[0]}/${h.slice(1)}.bundle`;
}

/** The upload hash an API candidate refers to, or null when it is not an upload. */
export function uploadHashOf(key: string): string | null {
  const m = /upload(?:%3A%2F%2F|:\/\/)(?:posters|art)(?:%2F|\/)([0-9a-f]+)/i.exec(key);
  return m ? m[1].toLowerCase() : null;
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await fsp.stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

export async function selectNewestUploads(opts: { apply: boolean; log?: (s: string) => void } = { apply: false }): Promise<SelectResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const result: SelectResult = { scanned: 0, multiUpload: 0, changed: [], undatable: [], failures: [] };
  log(`plex newest-upload selection — ${opts.apply ? 'APPLY' : 'DRY RUN'}`);

  try {
    await fsp.access(METADATA_DIR);
  } catch {
    log(`Plex metadata directory not readable at ${METADATA_DIR}.`);
    log('Mount the Plex data share first, or set PLEX_METADATA_DIR. Aborting.');
    return result;
  }

  const sections: { key: string; dir: 'Movies' | 'TV Shows' }[] = [
    { key: process.env.PLEX_MOVIE_SECTION ?? '4', dir: 'Movies' },
    { key: process.env.PLEX_TV_SECTION ?? '5', dir: 'TV Shows' },
  ];

  for (const section of sections) {
    const listing = await callService('plex', () =>
      plexGet<{ MediaContainer?: { Metadata?: { ratingKey?: string; title?: string; guid?: string }[] } }>(
        `/library/sections/${section.key}/all`,
      ),
    );
    const items = (listing.MediaContainer?.Metadata ?? []).filter((m) => m.ratingKey && m.guid);
    log(`\nSection ${section.key} (${section.dir}): ${items.length} item(s)`);

    for (const item of items) {
      result.scanned++;
      const ratingKey = String(item.ratingKey);
      const title = String(item.title ?? ratingKey);
      const bundle = bundlePathFor(String(item.guid), section.dir);

      for (const kind of ['poster', 'art'] as const) {
        let uploads: Upload[];
        try {
          const res = await callService('plex', () =>
            plexGet<{ MediaContainer?: { Metadata?: { key?: string; ratingKey?: string; selected?: boolean }[] } }>(
              `/library/metadata/${ratingKey}/${kind === 'poster' ? 'posters' : 'arts'}`,
            ),
          );
          const rows = res.MediaContainer?.Metadata ?? [];
          uploads = rows
            .map((r) => ({ hash: uploadHashOf(String(r.key ?? r.ratingKey ?? '')), selected: r.selected === true }))
            .filter((u): u is { hash: string; selected: boolean } => u.hash !== null)
            .map((u) => ({ ...u, mtimeMs: null }));
        } catch (err) {
          result.failures.push({ title, error: err instanceof Error ? err.message : String(err) });
          continue;
        }
        if (uploads.length < 2) continue; // nothing ambiguous to resolve
        if (kind === 'poster') result.multiUpload++;

        const dir = `${bundle}/Uploads/${kind === 'poster' ? 'posters' : 'art'}`;
        for (const u of uploads) u.mtimeMs = await mtimeOf(`${dir}/${u.hash}`);

        const dated = uploads.filter((u) => u.mtimeMs !== null);
        if (dated.length !== uploads.length) {
          // Some image has no file we can date: choosing would be guessing again.
          result.undatable.push(`${title} (${kind})`);
          continue;
        }
        dated.sort((a, b) => b.mtimeMs! - a.mtimeMs!);
        const newest = dated[0];
        const current = uploads.find((u) => u.selected);
        if (current && current.hash === newest.hash) continue; // already right

        const when = new Date(newest.mtimeMs!).toISOString().slice(0, 10);
        log(`  ${opts.apply ? 'selecting' : 'would select'} ${kind} for "${title}": ${newest.hash.slice(0, 8)}… (uploaded ${when})`);
        if (current) {
          const curWhen = current.mtimeMs ? new Date(current.mtimeMs).toISOString().slice(0, 10) : 'unknown date';
          log(`      replacing ${current.hash.slice(0, 8)}… (uploaded ${curWhen})`);
        }
        result.changed.push({
          title,
          ratingKey,
          kind,
          from: current?.hash ?? '(agent artwork)',
          to: newest.hash,
          toDate: when,
        });
        if (!opts.apply) continue;
        try {
          await callService('plex', () =>
            plexPut(`/library/metadata/${ratingKey}/${kind}`, { url: `upload://${kind === 'poster' ? 'posters' : 'art'}/${newest.hash}` }),
          );
        } catch (err) {
          result.failures.push({ title, error: err instanceof Error ? err.message : String(err) });
          log(`      FAILED: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  log('\n─────────────────────────────────────────────');
  log(`Scanned ${result.scanned} item(s) · items carrying several uploaded posters: ${result.multiUpload}`);
  log(`${opts.apply ? 'Switched' : 'Would switch'} to the newest upload: ${result.changed.length}`);
  log(`Could not date every image (left alone): ${result.undatable.length} · failures: ${result.failures.length}`);
  if (!opts.apply && result.changed.length > 0) log('DRY RUN — re-run with --apply to make these selections.');
  return result;
}

const isMain = process.argv[1]?.endsWith('plex-select-newest-upload.ts');
if (isMain) {
  selectNewestUploads({ apply: process.argv.includes('--apply') })
    .then((r) => process.exit(r.failures.length > 0 ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
