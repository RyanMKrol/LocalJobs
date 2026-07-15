// Plex-parsing + language-matching helpers for the per-title original-language
// default audit — no I/O beyond the shared plexGet/tmdbGet clients passed in by
// the stage. Unit-tested in stages/scan.test.ts.
import { callService } from '../../core/services.js';
import { plexGet, tmdbGet } from '../../core/plex-client.js';
import type { FileEntry, PlexPart, PlexSection, PlexStream, StreamChoice } from './types.js';

/** Titles that mark an alternate/special-purpose track we never want as "the" default. */
const STOPLIST = /commentary|description|descriptive|narration/i;

/**
 * Matches a "Songs & Signs"-only English subtitle track — surveyed from the real
 * library, this is named a huge variety of ways: "Signs & Songs", "S&S", "S & S",
 * "Signs/Karaoke", "Titles & Signs", "Sign & Songs" (typo), "Sings & Songs" (typo),
 * or bare "Signs"/"Songs". These tracks exist specifically so people watching the
 * ENGLISH DUB (which already voices the dialogue) get the untranslated on-screen
 * text and song lyrics — they do NOT translate spoken dialogue, so pairing one
 * with the original-language audio leaves the actual conversation unsubtitled.
 */
const SIGNS_SONGS_PATTERN = /\bs\s?&\s?s\b|\bsigns?\b|\bsongs?\b|\bkaraoke\b/i;
/**
 * Overrides the pattern above for a track that self-declares as a genuine, full
 * dialogue-inclusive track despite mentioning "signs"/"songs" in passing — e.g.
 * "Dialogue, Signs and Songs" (has dialogue too) or an SDH track titled
 * "...Without Songs" (an SDH track is a full dialogue transcription; it merely
 * skips song lyrics, which is a minor gap next to a true signs-only track).
 */
const FULL_DIALOGUE_OVERRIDE = /dialogue|\bsdh\b|deaf|hard of hearing|\bcc\b|\bfull\b|complete/i;

function isSignsOrSongsOnly(s: PlexStream): boolean {
  const text = `${s.title ?? ''} ${s.displayTitle ?? ''}`;
  return SIGNS_SONGS_PATTERN.test(text) && !FULL_DIALOGUE_OVERRIDE.test(text);
}

interface PlexListResponse<T> {
  MediaContainer: { Metadata?: T[]; size?: number };
}

/**
 * Injectable low-level Plex GET (tests) — swaps in for the real `plexGet` in
 * each `fetch*` helper below, still routed through `callService('plex', ...)`
 * so the 3-hour response-cache dedup (T477) can be exercised without a live
 * Plex call. Defaults to the real `plexGet`.
 */
type PlexFetcher = <T>(path: string) => Promise<T>;

export async function fetchSections(fetchPlex: PlexFetcher = plexGet): Promise<PlexSection[]> {
  const path = '/library/sections';
  const res = await callService('plex', () => fetchPlex<{ MediaContainer: { Directory?: PlexSection[] } }>(path), {
    cacheKey: `plex:${path}`,
  });
  return (res.MediaContainer.Directory ?? []).filter((s) => s.type === 'movie' || s.type === 'show');
}

export async function fetchSectionItems(
  sectionKey: string,
  type: string,
  fetchPlex: PlexFetcher = plexGet,
): Promise<{ ratingKey: string; title: string }[]> {
  const plexType = type === 'movie' ? 1 : 2;
  const path = `/library/sections/${sectionKey}/all?type=${plexType}`;
  const res = await callService('plex', () => fetchPlex<PlexListResponse<{ ratingKey: string; title: string }>>(path), {
    cacheKey: `plex:${path}`,
  });
  return res.MediaContainer.Metadata ?? [];
}

export async function fetchItemDetail(ratingKey: string, fetchPlex: PlexFetcher = plexGet) {
  const path = `/library/metadata/${ratingKey}`;
  const res = await callService(
    'plex',
    () => fetchPlex<PlexListResponse<import('./types.js').PlexMetadataItem>>(path),
    { cacheKey: `plex:${path}` },
  );
  return res.MediaContainer.Metadata?.[0];
}

export async function fetchAllLeaves(
  showRatingKey: string,
  fetchPlex: PlexFetcher = plexGet,
): Promise<{ ratingKey: string; title: string; index?: number; parentIndex?: number }[]> {
  const path = `/library/metadata/${showRatingKey}/allLeaves`;
  const res = await callService(
    'plex',
    () => fetchPlex<PlexListResponse<{ ratingKey: string; title: string; index?: number; parentIndex?: number }>>(path),
    { cacheKey: `plex:${path}` },
  );
  return res.MediaContainer.Metadata ?? [];
}

/** Extract a tmdb id from an item's Guid array, e.g. "tmdb://1429" -> 1429. */
export function extractTmdbId(guids: { id: string }[] | undefined): number | undefined {
  const hit = (guids ?? []).find((g) => g.id.startsWith('tmdb://'));
  if (!hit) return undefined;
  const n = Number(hit.id.slice('tmdb://'.length));
  return Number.isFinite(n) ? n : undefined;
}

export interface TmdbLanguageDetail {
  originalLanguage?: string;
  /** What TMDB actually lists as spoken in the source material — can DISAGREE
   *  with `originalLanguage` for international co-productions (TMDB appears to
   *  derive `original_language` from the producing/origin country rather than
   *  the real shooting language in these cases — confirmed on "The Young Pope",
   *  which lists `original_language: 'it'` but `spoken_languages: [English]`). */
  spokenLanguages: { code: string; name: string }[];
}

/** Look up a show/movie's TMDB language detail, routed through the shared rate-limited tmdb service. */
export async function lookupLanguageDetail(tmdbId: number, type: 'show' | 'movie'): Promise<TmdbLanguageDetail> {
  const path = type === 'show' ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
  const detail = await callService(
    'tmdb',
    () =>
      tmdbGet<{ original_language?: string; spoken_languages?: { iso_639_1: string; english_name: string }[] }>(
        path,
      ),
    { cacheKey: `tmdb:${path}` },
  );
  return {
    originalLanguage: detail.original_language,
    spokenLanguages: (detail.spoken_languages ?? []).map((l) => ({ code: l.iso_639_1, name: l.english_name })),
  };
}

function label(s: PlexStream): string {
  return s.extendedDisplayTitle ?? s.displayTitle ?? s.title ?? s.language ?? `stream ${s.id}`;
}

/**
 * Whichever audio/subtitle stream is CURRENTLY in effect for a part. Distinguishes
 * a real Plex `selected` flag (isExplicit: true, pinned server-side, survives any
 * client's own language preference) from merely landing on the file's own baked-in
 * `default` flag or the first stream by index (isExplicit: false) — the latter is
 * NOT pinned and can be silently overridden per-client, which is exactly the gap
 * this workflow exists to close (a multi-dub file's internal default flag isn't
 * guaranteed to be the language you'd expect).
 */
function currentChoice(streams: PlexStream[], streamType: number): StreamChoice {
  const ofType = streams.filter((s) => s.streamType === streamType).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (ofType.length === 0) return { streamId: null, label: 'none', isExplicit: false };
  const explicit = ofType.find((s) => s.selected);
  if (explicit) return { streamId: explicit.id, label: label(explicit), languageTag: explicit.languageTag, isExplicit: true };
  const fallback = ofType.find((s) => s.default) ?? (streamType === 3 ? undefined : ofType[0]);
  if (!fallback) return { streamId: null, label: 'none', isExplicit: false };
  return { streamId: fallback.id, label: label(fallback), languageTag: fallback.languageTag, isExplicit: false };
}

/**
 * Rough quality ranking for audio codecs, highest first. This resolves the
 * extremely common case of a remux carrying the SAME mix twice — once lossless,
 * once as a lossy compatibility copy (e.g. a remux carrying both a 6-channel
 * `truehd` track and a 6-channel `aac` track of the identical English audio) —
 * which is not a genuine "which version do I want" choice, just "which copy of
 * the same thing is better." Unknown codecs rank lowest, not highest, so an
 * unrecognized codec never wins a tie against a common, well-understood one.
 *
 * Plex reports the WHOLE DTS family — plain DTS core AND lossless DTS-HD Master
 * Audio alike — under the SAME raw codec string, `dca` (not `dts`, a real trap:
 * an earlier version of this check looked for `dts` and never matched anything,
 * silently ranking DTS-HD MA *below* AAC). The lossless/lossy distinction for
 * that family only shows up in the track's own title text ("DTS-HD MA" vs plain
 * "DTS"), not in a structured field, so it's checked separately here.
 */
function codecRank(s: PlexStream): number {
  const c = (s.codec ?? '').toLowerCase();
  const text = `${s.title ?? ''} ${s.displayTitle ?? ''} ${s.extendedDisplayTitle ?? ''}`.toLowerCase();
  if (c === 'truehd' || c === 'flac' || c === 'pcm' || c === 'mlp') return 5; // lossless
  if (c === 'dca') return /\bma\b|master audio/.test(text) ? 5 : 3; // DTS-HD MA (lossless) vs plain DTS (lossy core)
  if (c === 'eac3') return 2; // Dolby Digital Plus
  if (c === 'ac3') return 1; // Dolby Digital
  if (c === 'aac' || c === 'mp3' || c === 'mp2') return 0;
  return -1;
}

/**
 * A track explicitly labelled as the ORIGINAL mix (e.g. "Original 6-Track Mix
 * (Matrixed)", "Original Stereo Mix") outweighs channel count entirely — found
 * live on classic films where the authentic original mix is a lossless FLAC
 * stereo/mono track, and the higher-channel alternative is explicitly labelled
 * a "Remix" or "Upmix": a synthetic, DSP-expanded reprocessing of that same
 * stereo signal, not genuine additional channel information. More channels
 * isn't "better" when they were never real.
 */
function isOriginalMix(s: PlexStream): boolean {
  const text = `${s.title ?? ''} ${s.displayTitle ?? ''} ${s.extendedDisplayTitle ?? ''}`.toLowerCase();
  return /\boriginal\b/.test(text);
}

/**
 * Pick the best audio candidate for a target language: exclude stoplisted
 * (commentary/description) tracks unless that would remove everything, then
 * prefer a track explicitly labelled "Original" (see `isOriginalMix`) over
 * channel count entirely, then highest channel count, then higher-quality codec
 * (see `codecRank`), tie-broken by lowest index. Returns null when no track in
 * that language exists.
 *
 * A genuine tie after ALL of those tiebreaks is NOT flagged for manual review —
 * the owner explicitly wants every tie resolved automatically, so the sorted
 * top candidate (lowest index among the tied set) is simply taken as-is.
 */
function pickAudioCandidate(streams: PlexStream[], targetLang: string): { choice: StreamChoice } | null {
  const all = streams.filter((s) => s.streamType === 2 && s.languageTag === targetLang);
  if (all.length === 0) return null;
  const filtered = all.filter((s) => !STOPLIST.test(s.title ?? '') && !STOPLIST.test(s.displayTitle ?? ''));
  const pool = filtered.length > 0 ? filtered : all;
  const sorted = [...pool].sort(
    (a, b) =>
      (isOriginalMix(b) ? 1 : 0) - (isOriginalMix(a) ? 1 : 0) ||
      (b.channels ?? 0) - (a.channels ?? 0) ||
      codecRank(b) - codecRank(a) ||
      (a.index ?? 0) - (b.index ?? 0),
  );
  const top = sorted[0];
  return { choice: { streamId: top.id, label: label(top), languageTag: top.languageTag, isExplicit: true } };
}

/**
 * Pick the best English subtitle candidate: exclude commentary tracks, then
 * prefer a full dialogue track over a Songs & Signs-only one (see
 * `isSignsOrSongsOnly`) UNLESS that would remove every candidate — some files
 * genuinely have no full-dialogue English track at all, in which case falling
 * back to whichever Signs & Songs option is available is still better than no
 * subtitle. `signsSongsOnly` tells the caller which case happened, so the
 * report can flag it instead of silently picking a partial track.
 */
function pickSubtitleCandidate(streams: PlexStream[]): { choice: StreamChoice; signsSongsOnly: boolean } | null {
  const all = streams.filter((s) => s.streamType === 3 && s.languageTag === 'en');
  if (all.length === 0) return null;
  const nonCommentary = all.filter((s) => !STOPLIST.test(s.title ?? '') && !STOPLIST.test(s.displayTitle ?? ''));
  const pool = nonCommentary.length > 0 ? nonCommentary : all;
  const fullDialogue = pool.filter((s) => !isSignsOrSongsOnly(s));
  const signsSongsOnly = fullDialogue.length === 0;
  const preferredPool = fullDialogue.length > 0 ? fullDialogue : pool;
  const nonForced = preferredPool.filter((s) => !s.forced);
  const finalPool = nonForced.length > 0 ? nonForced : preferredPool;
  const sorted = [...finalPool].sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0) || (a.index ?? 0) - (b.index ?? 0));
  const top = sorted[0];
  return { choice: { streamId: top.id, label: label(top), languageTag: top.languageTag, isExplicit: true }, signsSongsOnly };
}

/**
 * A proposed choice only counts as a no-op if it's BOTH the same stream AND
 * already pinned explicitly. A file that already happens to play the right
 * language purely via its own baked-in `default` flag still needs an explicit
 * change — that coincidental match is exactly the fragile state this workflow
 * exists to close, not something to leave alone.
 */
function needsChange(current: StreamChoice, proposed: StreamChoice | undefined): boolean {
  if (!proposed) return false;
  return proposed.streamId !== current.streamId || !current.isExplicit;
}

/**
 * Try each candidate language in order (a title's spoken_languages, then
 * original_language as a final fallback) and return the first that has a
 * matching audio track in this file. Different files of the same show/movie
 * can resolve to different languages when their audio tracks differ (e.g. one
 * season shipped with a dub-only rip) — so this runs per file, not once per title.
 */
function resolveAudioForFile(
  streams: PlexStream[],
  candidateLanguages: string[],
): { lang: string; result: { choice: StreamChoice } } | null {
  for (const lang of candidateLanguages) {
    const result = pickAudioCandidate(streams, lang);
    if (result) return { lang, result };
  }
  return null;
}

/** Evaluate a single Part (file) against an ordered list of candidate languages, producing one FileEntry. */
export function evaluatePart(
  itemRatingKey: string,
  itemTitle: string,
  seasonEpisode: string | undefined,
  part: PlexPart,
  candidateLanguages: string[],
): FileEntry {
  const streams = part.Stream ?? [];
  const currentAudio = currentChoice(streams, 2);
  const currentSubtitle = currentChoice(streams, 3);

  const resolved = resolveAudioForFile(streams, candidateLanguages);
  const base: FileEntry = {
    itemRatingKey,
    itemTitle,
    seasonEpisode,
    partId: part.id,
    file: part.file,
    status: 'skip',
    currentAudio,
    currentSubtitle,
  };

  if (!resolved) {
    return { ...base, note: `no audio track found for any candidate language (${candidateLanguages.join(', ')})` };
  }
  const { lang: targetLang, result: audioResult } = resolved;

  const subtitleResult = targetLang === 'en' ? undefined : pickSubtitleCandidate(streams);
  const proposedSubtitle = subtitleResult?.choice;

  let subtitleNote: string | undefined;
  if (targetLang !== 'en' && !proposedSubtitle) {
    subtitleNote = 'no English subtitle track available — audio only';
  } else if (subtitleResult?.signsSongsOnly) {
    subtitleNote = 'only a Songs & Signs-only English subtitle track exists in this file — no full dialogue subs available';
  }

  const audioChanged = needsChange(currentAudio, audioResult.choice);
  const subtitleChanged = needsChange(currentSubtitle, proposedSubtitle);

  if (!audioChanged && !subtitleChanged) {
    return {
      ...base,
      status: 'skip',
      proposedAudio: audioResult.choice,
      proposedSubtitle,
      resolvedLanguage: targetLang,
      note: subtitleNote,
    };
  }

  return {
    ...base,
    status: 'change',
    proposedAudio: audioResult.choice,
    proposedSubtitle,
    resolvedLanguage: targetLang,
    note: subtitleNote,
  };
}

/**
 * original_language FIRST, then spoken_languages (TMDB order) as fallbacks —
 * deduped, in priority order. NOT the other way around: TMDB's spoken_languages
 * is NOT ordered by "which language is really the original" — for heavily-dubbed
 * global titles it just lists every dub available, with English commonly
 * landing first regardless of the show's real origin. Putting original_language
 * first still self-corrects the genuine mismatch cases (a title whose claimed
 * original_language has NO matching track in the file at all falls through to
 * spoken_languages regardless of check order) while no longer wrongly
 * overriding a title whose original_language track genuinely exists and is
 * correct.
 */
export function buildCandidateLanguages(originalLanguage: string | undefined, spokenLanguages: { code: string }[]): string[] {
  const ordered = [originalLanguage, ...spokenLanguages.map((l) => l.code)].filter((v): v is string => Boolean(v));
  return [...new Set(ordered)];
}
