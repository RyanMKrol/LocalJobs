/**
 * Restore custom SEASON posters that Plex deselected when it rebuilt a show.
 *
 * A season is its own item in Plex, with its own artwork selection, and the
 * 2026-08 rename sweep recreated show and season entries as folders changed. The
 * earlier repairs only ever walked top-level items (films and shows), so seasons
 * were left showing the agent's default while the owner's uploaded poster sat
 * unused in the library. This closes that gap.
 *
 * Season uploads live inside the SHOW's metadata bundle, one directory per season
 * number: <bundle>/Uploads/posters/seasons/<season index>/<hash>. As with the
 * item-level repair, those files carry the upload dates the API does not expose,
 * so where a season accumulated several uploads the newest wins rather than an
 * arbitrary pick.
 *
 * It only ever switches TO an uploaded image, and only when the season is not
 * already showing it. Requires the Plex data share mounted. DRY RUN by default.
 *
 *   npx tsx scripts/plex-restore-season-artwork.ts
 *   npx tsx scripts/plex-restore-season-artwork.ts --apply
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { callService } from '../src/core/services.js';
import { plexGet, plexPut } from '../src/core/plex-client.js';

const METADATA_DIR = process.env.PLEX_METADATA_DIR ?? '/Volumes/PlexMediaServer/AppData/Plex Media Server/Metadata';

export interface SeasonRestoreResult {
  showsScanned: number;
  seasonsScanned: number;
  seasonsWithUploads: number;
  restored: { show: string; season: string; ratingKey: string; hash: string; uploadedAt: string; replaced: string }[];
  alreadyCorrect: number;
  failures: { where: string; error: string }[];
}

function bundleFor(showGuid: string): string {
  const h = createHash('sha1').update(showGuid).digest('hex');
  return `${METADATA_DIR}/TV Shows/${h[0]}/${h.slice(1)}.bundle`;
}

/**
 * The upload hash a candidate refers to. A SEASON's identifier carries the season
 * in the path — `upload://posters/seasons/1/<hash>` — where an item-level one is
 * just `upload://posters/<hash>`. Matching only the item form made every season
 * look unselected, which is why the first pass reported all 1,902 as broken.
 */
function uploadHashOf(key: string): string | null {
  const m = /upload(?:%3A%2F%2F|:\/\/)(?:posters|art)(?:%2F|\/)(?:seasons(?:%2F|\/)\d+(?:%2F|\/))?([0-9a-f]{16,})/i.exec(key);
  return m ? m[1].toLowerCase() : null;
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await fsp.stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

export async function restoreSeasonArtwork(
  opts: { apply: boolean; log?: (s: string) => void } = { apply: false },
): Promise<SeasonRestoreResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const r: SeasonRestoreResult = {
    showsScanned: 0,
    seasonsScanned: 0,
    seasonsWithUploads: 0,
    restored: [],
    alreadyCorrect: 0,
    failures: [],
  };
  log(`plex season artwork restore — ${opts.apply ? 'APPLY' : 'DRY RUN'}`);

  try {
    await fsp.access(METADATA_DIR);
  } catch {
    log(`Plex metadata directory not readable at ${METADATA_DIR}. Mount the Plex data share first. Aborting.`);
    return r;
  }

  const tvSection = process.env.PLEX_TV_SECTION ?? '5';
  const shows = await callService('plex', () =>
    plexGet<{ MediaContainer?: { Metadata?: { ratingKey?: string; title?: string; guid?: string }[] } }>(
      `/library/sections/${tvSection}/all`,
    ),
  );
  const showList = (shows.MediaContainer?.Metadata ?? []).filter((s) => s.ratingKey && s.guid);
  log(`Shows to walk: ${showList.length}`);

  for (const show of showList) {
    r.showsScanned++;
    const showTitle = String(show.title ?? show.ratingKey);
    const bundle = bundleFor(String(show.guid));

    let seasons: { ratingKey?: string; title?: string; index?: number }[];
    try {
      const res = await callService('plex', () =>
        plexGet<{ MediaContainer?: { Metadata?: { ratingKey?: string; title?: string; index?: number; type?: string }[] } }>(
          `/library/metadata/${show.ratingKey}/children`,
        ),
      );
      seasons = (res.MediaContainer?.Metadata ?? []).filter((m) => m.ratingKey !== undefined && m.index !== undefined);
    } catch (err) {
      r.failures.push({ where: showTitle, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    for (const season of seasons) {
      r.seasonsScanned++;
      const seasonRk = String(season.ratingKey);
      const seasonTitle = String(season.title ?? `Season ${season.index}`);
      const dir = `${bundle}/Uploads/posters/seasons/${season.index}`;

      let files: string[];
      try {
        files = await fsp.readdir(dir);
      } catch {
        continue; // no custom artwork was ever uploaded for this season
      }
      const dated: { hash: string; mtimeMs: number }[] = [];
      for (const f of files) {
        const t = await mtimeOf(`${dir}/${f}`);
        if (t !== null) dated.push({ hash: f.toLowerCase(), mtimeMs: t });
      }
      if (dated.length === 0) continue;
      r.seasonsWithUploads++;
      dated.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const newest = dated[0];

      let selectedHash: string | null = null;
      try {
        const res = await callService('plex', () =>
          plexGet<{ MediaContainer?: { Metadata?: { key?: string; ratingKey?: string; selected?: boolean }[] } }>(
            `/library/metadata/${seasonRk}/posters`,
          ),
        );
        const sel = (res.MediaContainer?.Metadata ?? []).find((m) => m.selected === true);
        selectedHash = sel ? uploadHashOf(String(sel.key ?? sel.ratingKey ?? '')) : null;
      } catch (err) {
        r.failures.push({ where: `${showTitle} / ${seasonTitle}`, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (selectedHash === newest.hash) {
        r.alreadyCorrect++;
        continue;
      }

      const when = new Date(newest.mtimeMs).toISOString().slice(0, 10);
      const replaced = selectedHash ? `an older upload (${selectedHash.slice(0, 8)}…)` : 'the agent default';
      log(`  ${opts.apply ? 'restoring' : 'would restore'} ${showTitle} / ${seasonTitle}: ${newest.hash.slice(0, 8)}… (uploaded ${when}), replacing ${replaced}`);
      r.restored.push({ show: showTitle, season: seasonTitle, ratingKey: seasonRk, hash: newest.hash, uploadedAt: when, replaced });
      if (!opts.apply) continue;
      try {
        // Seasons are selected by their own identifier form, including the season number.
        await callService('plex', () =>
          plexPut(`/library/metadata/${seasonRk}/poster`, { url: `upload://posters/seasons/${season.index}/${newest.hash}` }),
        );
      } catch (err) {
        r.failures.push({ where: `${showTitle} / ${seasonTitle}`, error: err instanceof Error ? err.message : String(err) });
        log(`      FAILED: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  log('\n─────────────────────────────────────────────');
  log(`Shows walked: ${r.showsScanned} · seasons: ${r.seasonsScanned} · seasons with custom artwork: ${r.seasonsWithUploads}`);
  log(`${opts.apply ? 'Restored' : 'Would restore'}: ${r.restored.length} · already correct: ${r.alreadyCorrect} · failures: ${r.failures.length}`);
  if (!opts.apply && r.restored.length > 0) log('DRY RUN — re-run with --apply to restore these.');
  return r;
}

const isMain = process.argv[1]?.endsWith('plex-restore-season-artwork.ts');
if (isMain) {
  restoreSeasonArtwork({ apply: process.argv.includes('--apply') })
    .then((res) => process.exit(res.failures.length > 0 ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
