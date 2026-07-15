import type { SortDir } from './SortTh';

/** Shared sort columns for the TV/movie recommendation manager tables. */
export type RecSortCol = 'title' | 'year' | 'genre' | 'lens' | 'tmdb';

export function sortRecs<T extends { title: string; year: number | null; genre: string; lens: string; tmdbRating: number | null }>(
  recs: T[], col: RecSortCol, dir: SortDir,
): T[] {
  return [...recs].sort((a, b) => {
    let cmp = 0;
    if (col === 'title') cmp = a.title.localeCompare(b.title);
    else if (col === 'year') cmp = (a.year ?? 0) - (b.year ?? 0);
    else if (col === 'genre') cmp = a.genre.localeCompare(b.genre);
    else if (col === 'lens') cmp = a.lens.localeCompare(b.lens);
    else if (col === 'tmdb') cmp = (a.tmdbRating ?? 0) - (b.tmdbRating ?? 0);
    return dir === 'asc' ? cmp : -cmp;
  });
}
