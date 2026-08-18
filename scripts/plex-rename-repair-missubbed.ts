/**
 * One-time repair for subtitles the 2026-08-17 backfill filed against the WRONG
 * episode.
 *
 * `planNestedSubtitles` used to accept any file in a flat `Subs/` folder that
 * declared a language, with nothing tying it to the media being processed. In a
 * season folder with one shared `Subs/` directory that meant every episode's
 * subtitles were handed to whichever episode happened to run first, and the
 * collision disambiguator then carried the original name through — producing
 * files like:
 *
 *   Sahsiyet (2018) - s01e01 - 1.Bölüm.eng.Sahsiyet.S01E02.eng.srt
 *                    ^ the episode it was filed under   ^ the episode it belongs to
 *
 * Those are recoverable precisely because the disambiguator preserved the
 * original name: the trailing fragment still carries the real episode marker. This
 * re-homes each file onto the episode its own name identifies, and only when that
 * episode's media file is sitting right there to confirm the target. Anything
 * ambiguous is reported and left alone.
 *
 * DRY RUN by default — pass --apply to act. Renames within one directory only:
 * no copying, no crossing shares, nothing deleted.
 *
 *   npx tsx scripts/plex-rename-repair-missubbed.ts
 *   npx tsx scripts/plex-rename-repair-missubbed.ts --apply
 */
import 'dotenv/config';
import { plexRenameConfig } from '../src/workflows/plex-rename/config.js';
import { mountHealthy, realWriteFs, type WriteFsSeam } from '../src/workflows/plex-rename/lib.js';
import { pathKey, splitExt, subtitleSuffix } from '../src/workflows/plex-rename/naming.js';

const SUBTITLE_EXTS = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub', 'idx', 'smi']);
const MEDIA_EXTS = new Set(['mkv', 'mp4', 'avi', 'm4v', 'ts', 'wmv', 'mpg', 'mpeg', 'mov', 'flv']);
const EPISODE_MARKER = /s(\d{1,2})[\s._-]*e(\d{1,3})/i;

export interface RepairResult {
  scanned: number;
  rehomed: { from: string; to: string }[];
  ambiguous: string[];
  failures: { path: string; error: string }[];
}

/** The (season, episode) a name identifies, or null. */
export function episodeOf(name: string): { season: number; episode: number } | null {
  const m = EPISODE_MARKER.exec(name);
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null;
}

/**
 * A mis-filed subtitle is one whose suffix — everything after the media stem it
 * currently sits against — names a DIFFERENT episode than that media file.
 */
export function misfiled(
  subName: string,
  ownerStem: string,
): { wanted: { season: number; episode: number }; suffix: string } | null {
  if (!pathKey(subName).startsWith(`${pathKey(ownerStem)}.`)) return null;
  const tail = subName.slice(ownerStem.length + 1); // e.g. "eng.Sahsiyet.S01E02.eng.srt"
  const wanted = episodeOf(tail);
  if (!wanted) return null;
  const owner = episodeOf(ownerStem);
  if (owner && owner.season === wanted.season && owner.episode === wanted.episode) return null;
  return { wanted, suffix: subtitleSuffix(tail) ?? `.${splitExt(tail).ext.toLowerCase()}` };
}

export async function repairMissubbed(
  opts: { apply: boolean; fs?: WriteFsSeam; log?: (s: string) => void } = { apply: false },
): Promise<RepairResult> {
  const fs = opts.fs ?? realWriteFs;
  const log = opts.log ?? ((s: string) => console.log(s));
  const result: RepairResult = { scanned: 0, rehomed: [], ambiguous: [], failures: [] };
  log(`plex-rename mis-filed subtitle repair — ${opts.apply ? 'APPLY' : 'DRY RUN'}`);

  for (const pair of plexRenameConfig.pathMap) {
    if (!(await mountHealthy(pair.local, fs))) {
      log(`Mount ${pair.local} absent — aborting.`);
      return result;
    }
  }

  const walk = async (dir: string): Promise<void> => {
    const entries = (await fs.readdir(dir)) ?? [];
    const files = entries.filter((e) => !e.isDir).map((e) => e.name);
    const media = files.filter((f) => MEDIA_EXTS.has(splitExt(f).ext.toLowerCase())).map((f) => splitExt(f).stem);
    const subs = files.filter((f) => SUBTITLE_EXTS.has(splitExt(f).ext.toLowerCase()));

    for (const sub of subs) {
      const owner = media.find((m) => pathKey(sub).startsWith(`${pathKey(m)}.`));
      if (!owner) continue;
      result.scanned++;
      const bad = misfiled(sub, owner);
      if (!bad) continue;
      // Find the media file in THIS directory that the subtitle actually names.
      const target = media.find((m) => {
        const e = episodeOf(m);
        return e && e.season === bad.wanted.season && e.episode === bad.wanted.episode;
      });
      if (!target) {
        result.ambiguous.push(`${dir}/${sub}`);
        continue;
      }
      let dest = `${dir}/${target}${bad.suffix}`;
      // Never overwrite: if the rightful name is taken, keep this one distinct.
      if (files.includes(`${target}${bad.suffix}`) || (await fs.stat(dest))) {
        const { ext } = splitExt(bad.suffix);
        dest = `${dir}/${target}${bad.suffix.slice(0, bad.suffix.length - ext.length - 1)}.alt.${ext}`;
        if (await fs.stat(dest)) {
          result.ambiguous.push(`${dir}/${sub} (rightful name already taken)`);
          continue;
        }
      }
      log(`  ${opts.apply ? 're-home' : 'would re-home'}: ${sub}`);
      log(`      → ${dest.slice(dir.length + 1)}`);
      result.rehomed.push({ from: `${dir}/${sub}`, to: dest });
      if (!opts.apply) continue;
      try {
        await fs.rename(`${dir}/${sub}`, dest);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.failures.push({ path: `${dir}/${sub}`, error: msg });
        log(`      FAILED: ${msg}`);
      }
    }
    for (const d of entries.filter((e) => e.isDir)) {
      if (d.name.startsWith('#') || d.name.startsWith('@')) continue;
      await walk(`${dir}/${d.name}`);
    }
  };

  for (const pair of plexRenameConfig.pathMap) {
    for (const lib of ['TV', 'Movies']) {
      if (await fs.stat(`${pair.local}/${lib}`)) await walk(`${pair.local}/${lib}`);
    }
  }

  log('─────────────────────────────────────────────');
  log(`Subtitles inspected: ${result.scanned} · ${opts.apply ? 're-homed' : 'would re-home'}: ${result.rehomed.length}`);
  log(`Ambiguous (left alone): ${result.ambiguous.length} · failures: ${result.failures.length}`);
  if (!opts.apply && result.rehomed.length > 0) log('DRY RUN — re-run with --apply to perform these renames.');
  return result;
}

const isMain = process.argv[1]?.endsWith('plex-rename-repair-missubbed.ts');
if (isMain) {
  repairMissubbed({ apply: process.argv.includes('--apply') })
    .then((r) => process.exit(r.failures.length > 0 ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
