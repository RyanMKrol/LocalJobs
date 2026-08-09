// Pure normalizing/markdown-building helpers for the media-reviews workflow —
// no I/O, unit-tested in lib.test.ts. The stages/build.ts engine owns the
// DynamoDB scan + file writes; everything here takes plain values in and
// returns strings/objects out.
import { createHash } from 'node:crypto';

import type {
  AlbumLastfm,
  AlbumReview,
  BookReview,
  RenderedReview,
  ScreenReview,
} from './types.js';

/** TMDB image host prefix — the site stores only the relative posterPath
 *  ('/xxx.jpg'); mirrors `tmdbPosterUrl()` in the site's src/lib/tmdb.js. */
const TMDB_POSTER_PREFIX = 'https://image.tmdb.org/t/p/w500';

/**
 * Deterministic JSON serialization: object keys recursively sorted, array
 * order preserved. Plain JSON.stringify key order follows insertion order,
 * which nothing guarantees to be stable across the site's different writers —
 * this makes the content hash below depend only on the DATA.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * The change marker for one raw Dynamo item: a sha256 of its stable
 * serialization. Hashing the WHOLE raw item (not editedDate) is deliberate —
 * the site's metadata backfills mutate fields without stamping editedDate, so
 * editedDate alone would miss real changes. Hash per item, never a whole scan
 * result (Scan ordering is not guaranteed).
 */
export function contentMarker(rawItem: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(rawItem)).digest('hex');
}

/**
 * Normalize the site's 'DD-MM-YYYY' review dates to ISO 'YYYY-MM-DD' for the
 * frontmatter (sortable, unambiguous). Anything that doesn't match the exact
 * shape passes through unchanged rather than guessing.
 */
export function isoFromDdMmYyyy(d: string): string {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(d.trim());
  if (!m) return d;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Pull the year off an ISO 'YYYY-MM-DD' tmdbDate, or null. NEVER derived from
 *  the 'DD-MM-YYYY' `date` field — that's the review date, not the release. */
export function yearFromIsoDate(isoDate: string | undefined): number | null {
  if (typeof isoDate !== 'string') return null;
  const m = /^(\d{4})-/.exec(isoDate.trim());
  return m ? Number(m[1]) : null;
}

/** Build the output filename stem: a lowercase-dash slug of the human stem
 *  plus a short id suffix for guaranteed uniqueness (plex-profiles
 *  `slugFileName` idiom, adapted for UUID-keyed items). */
export function slugStem(stem: string, id: string): string {
  const slug = stem
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  const suffix = id.slice(0, 8);
  return slug ? `${slug}-${suffix}` : suffix;
}

function yamlList(values: string[]): string {
  if (values.length === 0) return '[]';
  return `[${values.map((v) => JSON.stringify(v)).join(', ')}]`;
}

const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

// ── Normalizers — raw Dynamo item → typed review, or null when malformed ──
// A null means the row lacks a required field; the engine warn-skips it
// (perfumes loadPerfumes precedent) rather than failing the run.

export function normalizeBook(raw: Record<string, unknown>): BookReview | null {
  const {
    id, title, author, rating, review_text: reviewText, date, editedDate,
    isbn, pageCount, publisher, firstPublishedYear, subjects, coverUrl,
    hardcoverRating, hardcoverSynopsis, seriesName, seriesPosition,
  } = raw;
  if (!str(id) || !str(title) || !str(author)) return null;
  const subjectList = strList(subjects);
  return {
    id,
    title,
    author,
    ...(num(rating) ? { rating } : {}),
    ...(str(reviewText) ? { reviewText } : {}),
    ...(str(date) ? { date } : {}),
    ...(str(editedDate) ? { editedDate } : {}),
    ...(str(isbn) && isbn ? { isbn } : {}),
    ...(num(pageCount) ? { pageCount } : {}),
    ...(str(publisher) && publisher ? { publisher } : {}),
    ...(num(firstPublishedYear) ? { firstPublishedYear } : {}),
    ...(subjectList && subjectList.length > 0 ? { subjects: subjectList } : {}),
    ...(str(coverUrl) && coverUrl ? { coverUrl } : {}),
    ...(num(hardcoverRating) ? { hardcoverRating } : {}),
    ...(str(hardcoverSynopsis) && hardcoverSynopsis ? { hardcoverSynopsis } : {}),
    ...(str(seriesName) && seriesName ? { seriesName } : {}),
    ...(num(seriesPosition) ? { seriesPosition } : {}),
  };
}

export function normalizeScreen(raw: Record<string, unknown>): ScreenReview | null {
  const {
    id, title, rating, review_text: reviewText, date, editedDate,
    tmdbId, tmdbDate, tmdbOverview, posterPath,
  } = raw;
  if (!str(id) || !str(title)) return null;
  return {
    id,
    title,
    ...(num(rating) ? { rating } : {}),
    ...(str(reviewText) ? { reviewText } : {}),
    ...(str(date) ? { date } : {}),
    ...(str(editedDate) ? { editedDate } : {}),
    ...(num(tmdbId) ? { tmdbId } : {}),
    ...(str(tmdbDate) && tmdbDate ? { tmdbDate } : {}),
    ...(str(tmdbOverview) && tmdbOverview ? { tmdbOverview } : {}),
    ...(str(posterPath) && posterPath ? { posterPath } : {}),
  };
}

export function normalizeAlbum(raw: Record<string, unknown>): AlbumReview | null {
  const { id, title, artist, rating, highlights, date, editedDate, thumbnail, lastfm } = raw;
  if (!str(id) || !str(title) || !str(artist)) return null;
  let lastfmOut: AlbumLastfm | undefined;
  if (lastfm && typeof lastfm === 'object' && !Array.isArray(lastfm)) {
    const l = lastfm as Record<string, unknown>;
    const tagList = strList(l.tags);
    lastfmOut = {
      ...(str(l.url) && l.url ? { url: l.url } : {}),
      ...(str(l.mbid) && l.mbid ? { mbid: l.mbid } : {}),
      ...(tagList && tagList.length > 0 ? { tags: tagList } : {}),
      ...(num(l.trackCount) ? { trackCount: l.trackCount } : {}),
      ...(str(l.summary) && l.summary ? { summary: l.summary } : {}),
      ...(str(l.releaseDate) && l.releaseDate ? { releaseDate: l.releaseDate } : {}),
      ...(str(l.listeners) && l.listeners ? { listeners: l.listeners } : {}),
      ...(str(l.playcount) && l.playcount ? { playcount: l.playcount } : {}),
    };
  }
  return {
    id,
    title,
    artist,
    ...(num(rating) ? { rating } : {}),
    ...(str(highlights) ? { highlights } : {}),
    ...(str(date) ? { date } : {}),
    ...(str(editedDate) ? { editedDate } : {}),
    ...(str(thumbnail) && thumbnail ? { thumbnail } : {}),
    ...(lastfmOut && Object.keys(lastfmOut).length > 0 ? { lastfm: lastfmOut } : {}),
  };
}

// ── Markdown builders — deterministic, fixed frontmatter keys + fixed `##`
// section names across every file (the plex-profiles corpus-queryability
// rule). Every string frontmatter value goes through JSON.stringify (titles
// with quotes/colons, free-text Last.fm dates). Absent optionals are omitted
// entirely, never written as null. ──

export function buildBookReviewMarkdown(b: BookReview): string {
  const frontmatter = [
    '---',
    'type: book-review',
    `id: ${JSON.stringify(b.id)}`,
    `title: ${JSON.stringify(b.title)}`,
    `author: ${JSON.stringify(b.author)}`,
    `rating: ${num(b.rating) ? b.rating : 'null'}`,
    `date: ${JSON.stringify(isoFromDdMmYyyy(b.date ?? ''))}`,
    ...(b.editedDate ? [`edited_date: ${JSON.stringify(isoFromDdMmYyyy(b.editedDate))}`] : []),
    ...(b.isbn ? [`isbn: ${JSON.stringify(b.isbn)}`] : []),
    ...(num(b.pageCount) ? [`page_count: ${b.pageCount}`] : []),
    ...(b.publisher ? [`publisher: ${JSON.stringify(b.publisher)}`] : []),
    ...(num(b.firstPublishedYear) ? [`first_published_year: ${b.firstPublishedYear}`] : []),
    ...(b.seriesName ? [`series_name: ${JSON.stringify(b.seriesName)}`] : []),
    ...(num(b.seriesPosition) ? [`series_position: ${b.seriesPosition}`] : []),
    ...(b.subjects && b.subjects.length > 0 ? [`subjects: ${yamlList(b.subjects)}`] : []),
    ...(b.coverUrl ? [`cover_url: ${JSON.stringify(b.coverUrl)}`] : []),
    ...(num(b.hardcoverRating) ? [`hardcover_rating: ${b.hardcoverRating}`] : []),
    '---',
  ].join('\n');

  return [
    frontmatter,
    '',
    '## Review',
    '',
    b.reviewText || '(no review text recorded)',
    ...(b.hardcoverSynopsis ? ['', '## Synopsis', '', b.hardcoverSynopsis] : []),
    '',
  ].join('\n');
}

export function buildScreenReviewMarkdown(kind: 'movie' | 'tv', r: ScreenReview): string {
  const year = yearFromIsoDate(r.tmdbDate);
  const frontmatter = [
    '---',
    `type: ${kind}-review`,
    `id: ${JSON.stringify(r.id)}`,
    `title: ${JSON.stringify(r.title)}`,
    ...(year !== null ? [`year: ${year}`] : []),
    `rating: ${num(r.rating) ? r.rating : 'null'}`,
    `date: ${JSON.stringify(isoFromDdMmYyyy(r.date ?? ''))}`,
    ...(r.editedDate ? [`edited_date: ${JSON.stringify(isoFromDdMmYyyy(r.editedDate))}`] : []),
    ...(num(r.tmdbId) ? [`tmdb_id: ${r.tmdbId}`] : []),
    ...(r.tmdbDate ? [`release_date: ${JSON.stringify(r.tmdbDate)}`] : []),
    ...(r.posterPath ? [`poster_url: ${JSON.stringify(`${TMDB_POSTER_PREFIX}${r.posterPath}`)}`] : []),
    '---',
  ].join('\n');

  return [
    frontmatter,
    '',
    '## Review',
    '',
    r.reviewText || '(no review text recorded)',
    ...(r.tmdbOverview ? ['', '## Overview', '', r.tmdbOverview] : []),
    '',
  ].join('\n');
}

export function buildAlbumReviewMarkdown(a: AlbumReview): string {
  const l = a.lastfm;
  const frontmatter = [
    '---',
    'type: album-review',
    `id: ${JSON.stringify(a.id)}`,
    `title: ${JSON.stringify(a.title)}`,
    `artist: ${JSON.stringify(a.artist)}`,
    `rating: ${num(a.rating) ? a.rating : 'null'}`,
    `date: ${JSON.stringify(isoFromDdMmYyyy(a.date ?? ''))}`,
    ...(a.editedDate ? [`edited_date: ${JSON.stringify(isoFromDdMmYyyy(a.editedDate))}`] : []),
    ...(a.thumbnail ? [`artwork_url: ${JSON.stringify(a.thumbnail)}`] : []),
    ...(l?.url ? [`lastfm_url: ${JSON.stringify(l.url)}`] : []),
    ...(l?.mbid ? [`mbid: ${JSON.stringify(l.mbid)}`] : []),
    ...(l?.releaseDate ? [`release_date: ${JSON.stringify(l.releaseDate)}`] : []),
    ...(l?.tags && l.tags.length > 0 ? [`tags: ${yamlList(l.tags)}`] : []),
    ...(num(l?.trackCount) ? [`track_count: ${l?.trackCount}`] : []),
    ...(l?.listeners ? [`listeners: ${JSON.stringify(l.listeners)}`] : []),
    ...(l?.playcount ? [`playcount: ${JSON.stringify(l.playcount)}`] : []),
    '---',
  ].join('\n');

  return [
    frontmatter,
    '',
    '## Highlights',
    '',
    a.highlights || '(no review text recorded)',
    ...(l?.summary ? ['', '## About', '', l.summary] : []),
    '',
  ].join('\n');
}

// ── Render functions — one per category, composing normalize + build + naming.
// The engine (stages/build.ts) calls these; null = malformed row, warn-skip. ──

export function renderBookReview(raw: Record<string, unknown>): RenderedReview | null {
  const b = normalizeBook(raw);
  if (!b) return null;
  const name = `${b.title} (${b.author})`;
  return { name, stem: name, md: buildBookReviewMarkdown(b) };
}

export function renderMovieReview(raw: Record<string, unknown>): RenderedReview | null {
  return renderScreenReview('movie', raw);
}

export function renderTvReview(raw: Record<string, unknown>): RenderedReview | null {
  return renderScreenReview('tv', raw);
}

function renderScreenReview(kind: 'movie' | 'tv', raw: Record<string, unknown>): RenderedReview | null {
  const r = normalizeScreen(raw);
  if (!r) return null;
  const year = yearFromIsoDate(r.tmdbDate);
  const name = year !== null ? `${r.title} (${year})` : r.title;
  return { name, stem: name, md: buildScreenReviewMarkdown(kind, r) };
}

export function renderAlbumReview(raw: Record<string, unknown>): RenderedReview | null {
  const a = normalizeAlbum(raw);
  if (!a) return null;
  const name = `${a.title} (${a.artist})`;
  return { name, stem: name, md: buildAlbumReviewMarkdown(a) };
}
