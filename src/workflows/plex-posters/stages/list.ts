import { callService } from '../../../core/services.js';
import { plexGet } from '../../../core/plex-client.js';
import type { JobContext } from '../../../engine/index.js';
import type { PosterItem, PosterItemType, PosterList } from '../types.js';

/** A Plex GET that returns parsed JSON. Injectable so tests need no Plex. */
export type PlexGetter = <T>(path: string) => Promise<T>;

// Read live every time, never from the plex service's response cache: a backup
// that recorded a three-hour-old view of the library would defeat its purpose.
const livePlexGet: PlexGetter = (path) => callService('plex', () => plexGet(path));

const TYPE_IDS: Record<PosterItemType, number> = { movie: 1, show: 2, season: 3 };
/** Which kinds of item live in which kind of library. */
const SECTION_KINDS: Record<string, PosterItemType[]> = { movie: ['movie'], show: ['show', 'season'] };

interface PlexSection { key: string; title: string; type: string }
interface PlexEntry {
  ratingKey: string; guid?: string; title?: string; year?: number | string; thumb?: string; index?: number;
  parentRatingKey?: string; parentGuid?: string; parentTitle?: string; parentYear?: number | string;
}

const text = (v: number | string | undefined): string | null => (v == null || v === '' ? null : String(v));

function toItem(entry: PlexEntry, section: PlexSection, type: PosterItemType): PosterItem {
  const item: PosterItem = {
    type,
    ratingKey: String(entry.ratingKey),
    guid: entry.guid ?? null,
    sectionId: String(section.key),
    sectionTitle: section.title,
    title: entry.title ?? '',
    year: text(entry.year),
    thumb: entry.thumb ?? null,
  };
  if (type === 'season') {
    item.index = entry.index ?? null;
    item.show = {
      ratingKey: String(entry.parentRatingKey ?? ''),
      guid: entry.parentGuid ?? null,
      title: entry.parentTitle ?? '',
      year: text(entry.parentYear),
    };
  }
  return item;
}

/**
 * List every film, show and season in EVERY film and TV library on the server,
 * with the path of the poster each one currently shows. One request per library
 * per kind, so it is a handful of calls however big the library is. The libraries
 * are discovered from Plex, not taken from PLEX_MOVIE_SECTION / PLEX_TV_SECTION:
 * a backup should cover a library added later without anyone remembering to
 * configure it.
 */
export async function runList(ctx: JobContext, opts: { get?: PlexGetter; now?: Date } = {}): Promise<PosterList> {
  const get = opts.get ?? livePlexGet;
  ctx.log('plex-posters-list starting: reading every film and TV library live from Plex (no cache)');

  const identity = await get<{ MediaContainer?: { machineIdentifier?: string } }>('/identity');
  const machineIdentifier = identity?.MediaContainer?.machineIdentifier ?? '';
  if (!machineIdentifier) throw new Error('Plex did not report a machine identifier on /identity');

  const all = (await get<{ MediaContainer?: { Directory?: PlexSection[] } }>('/library/sections'))?.MediaContainer?.Directory ?? [];
  const sections = all.filter((s) => SECTION_KINDS[s.type]);
  ctx.log(`Plex has ${all.length} librar${all.length === 1 ? 'y' : 'ies'}; backing up ${sections.length}: ${sections.map((s) => `${s.title} (${s.type}, section ${s.key})`).join(', ') || 'none'}`);
  for (const skipped of all.filter((s) => !SECTION_KINDS[s.type])) ctx.log(`  skipping "${skipped.title}" (a ${skipped.type} library: only film and TV libraries have posters backed up)`);

  const items: PosterItem[] = [];
  let step = 0;
  const steps = sections.reduce((n, s) => n + SECTION_KINDS[s.type].length, 0);
  for (const section of sections) {
    for (const kind of SECTION_KINDS[section.type]) {
      const resp = await get<{ MediaContainer?: { Metadata?: PlexEntry[] } }>(`/library/sections/${section.key}/all?type=${TYPE_IDS[kind]}&includeGuids=1`);
      const entries = resp?.MediaContainer?.Metadata ?? [];
      for (const entry of entries) items.push(toItem(entry, section, kind));
      step++;
      ctx.log(`  ${section.title}: ${entries.length} ${kind}${entries.length === 1 ? '' : 's'}`);
      ctx.progress((step / steps) * 100, `${step}/${steps} listings read`);
    }
  }

  // A populated library never lists nothing. An empty read is a Plex hiccup, and
  // recording it would make next week's diff say every poster was removed.
  if (items.length === 0) throw new Error('Plex listed no films, shows or seasons at all. Refusing to record an empty list.');

  const noPoster = items.filter((i) => !i.thumb).length;
  ctx.log(`plex-posters-list complete: ${items.length} title(s), ${noPoster} of them with no poster`);
  ctx.progress(100, `${items.length} titles listed`);
  return {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    server: { machineIdentifier },
    sections: sections.map((s) => ({ id: String(s.key), title: s.title, type: s.type })),
    items,
  };
}
