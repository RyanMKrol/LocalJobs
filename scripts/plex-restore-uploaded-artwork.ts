/**
 * Re-select the custom artwork Plex deselected when it recreated a library item.
 *
 * Moving a file to a new folder sometimes makes Plex retire the old library entry
 * and create a fresh one. The new entry matches the same title, but it starts from
 * the agent's DEFAULT artwork — so a poster the owner had uploaded stops being
 * shown. The upload itself is not lost: Plex keys its metadata bundle off the
 * item's GUID, so the same uploaded image is still listed among the new entry's
 * poster candidates. It just is not the selected one.
 *
 * This walks the library, finds every item whose selected poster (or background
 * art) is an agent default WHILE an upload is available, and re-selects the
 * upload. Deliberately conservative:
 *   - an item that has NO upload is never touched (nothing to restore);
 *   - an item already showing its upload is never touched (idempotent);
 *   - it only ever switches TO an upload, never away from one, so a deliberate
 *     choice of an agent poster is the only thing it could undo — and only for
 *     items that also carry an upload.
 *
 * DRY RUN by default — pass --apply to act. --type=movie|show limits the scope.
 *
 *   npx tsx scripts/plex-restore-uploaded-artwork.ts
 *   npx tsx scripts/plex-restore-uploaded-artwork.ts --apply
 */
import 'dotenv/config';
import { callService } from '../src/core/services.js';
import { plexGet, resolvePlexHost } from '../src/core/plex-client.js';

interface Candidate {
  key: string;
  selected: boolean;
  isUpload: boolean;
}

export interface RestoreResult {
  scanned: number;
  restored: { ratingKey: string; title: string; kind: 'poster' | 'art' }[];
  alreadyCustom: number;
  noUpload: number;
  failures: { ratingKey: string; error: string }[];
}

interface PhotoRow {
  key?: string;
  provider?: string;
  selected?: boolean;
}

function parseCandidates(rows: PhotoRow[]): Candidate[] {
  return rows.map((r) => {
    const key = r.key ?? '';
    return {
      key,
      selected: r.selected === true,
      // Plex serves an uploaded image through the item's own file URL as upload://…
      // (and reports no provider for it), vs metadata://… for anything an agent supplied.
      isUpload: key.includes('upload%3A') || key.includes('upload://'),
    };
  });
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Every item in a section, as { ratingKey, title }. */
async function sectionItems(sectionKey: string): Promise<{ ratingKey: string; title: string }[]> {
  const res = await callService('plex', () =>
    plexGet<{ MediaContainer?: { Metadata?: { ratingKey?: string; title?: string }[] } }>(`/library/sections/${sectionKey}/all`),
  );
  return (res.MediaContainer?.Metadata ?? [])
    .filter((m) => m.ratingKey && m.title)
    .map((m) => ({ ratingKey: String(m.ratingKey), title: decodeEntities(String(m.title)) }));
}

export async function restoreUploadedArtwork(
  opts: { apply: boolean; sections?: string[]; log?: (s: string) => void } = { apply: false },
): Promise<RestoreResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const result: RestoreResult = { scanned: 0, restored: [], alreadyCustom: 0, noUpload: 0, failures: [] };
  const host = await resolvePlexHost();
  const token = process.env.PLEX_API_TOKEN ?? '';
  log(`plex artwork restore — ${opts.apply ? 'APPLY' : 'DRY RUN'} · server ${host}`);

  const sections = opts.sections ?? [process.env.PLEX_MOVIE_SECTION ?? '4', process.env.PLEX_TV_SECTION ?? '5'];
  for (const section of sections) {
    const items = await sectionItems(section);
    log(`\nSection ${section}: ${items.length} item(s)`);
    for (const item of items) {
      result.scanned++;
      for (const kind of ['poster', 'art'] as const) {
        let candidates: Candidate[];
        try {
          const res = await callService('plex', () =>
            plexGet<{ MediaContainer?: { Metadata?: PhotoRow[] } }>(
              `/library/metadata/${item.ratingKey}/${kind === 'poster' ? 'posters' : 'arts'}`,
            ),
          );
          candidates = parseCandidates(res.MediaContainer?.Metadata ?? []);
        } catch (err) {
          result.failures.push({ ratingKey: item.ratingKey, error: err instanceof Error ? err.message : String(err) });
          continue;
        }
        const uploads = candidates.filter((c) => c.isUpload);
        if (uploads.length === 0) {
          if (kind === 'poster') result.noUpload++;
          continue;
        }
        if (uploads.some((u) => u.selected)) {
          if (kind === 'poster') result.alreadyCustom++;
          continue;
        }
        const target = uploads[0];
        log(`  ${opts.apply ? 'restoring' : 'would restore'} ${kind}: ${item.title} (rk${item.ratingKey})`);
        if (!opts.apply) {
          result.restored.push({ ratingKey: item.ratingKey, title: item.title, kind });
          continue;
        }
        try {
          const url = `${host}/library/metadata/${item.ratingKey}/${kind}?url=${encodeURIComponent(target.key)}&X-Plex-Token=${token}`;
          const res = await callService('plex', () => fetch(url, { method: 'PUT' }));
          if (!res.ok) throw new Error(`Plex HTTP ${res.status}`);
          result.restored.push({ ratingKey: item.ratingKey, title: item.title, kind });
        } catch (err) {
          result.failures.push({ ratingKey: item.ratingKey, error: err instanceof Error ? err.message : String(err) });
          log(`    FAILED: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  const posters = result.restored.filter((r) => r.kind === 'poster').length;
  const arts = result.restored.filter((r) => r.kind === 'art').length;
  log('\n─────────────────────────────────────────────');
  log(`Scanned ${result.scanned} item(s) · ${opts.apply ? 'restored' : 'would restore'} ${posters} poster(s) + ${arts} background(s)`);
  log(`Already showing a custom poster: ${result.alreadyCustom} · no upload available: ${result.noUpload} · failures: ${result.failures.length}`);
  if (!opts.apply && result.restored.length > 0) log('DRY RUN — re-run with --apply to restore these.');
  return result;
}

const isMain = process.argv[1]?.endsWith('plex-restore-uploaded-artwork.ts');
if (isMain) {
  const typeArg = process.argv.find((a) => a.startsWith('--type='));
  const sections =
    typeArg === undefined
      ? undefined
      : typeArg.includes('movie')
        ? [process.env.PLEX_MOVIE_SECTION ?? '4']
        : [process.env.PLEX_TV_SECTION ?? '5'];
  restoreUploadedArtwork({ apply: process.argv.includes('--apply'), sections })
    .then((r) => process.exit(r.failures.length > 0 ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
