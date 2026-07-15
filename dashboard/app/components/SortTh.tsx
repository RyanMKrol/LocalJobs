'use client';

export type SortDir = 'asc' | 'desc';

/** A clickable, sortable table header cell. Shared across any table that needs
 *  click-to-sort columns (movie/tv recs managers, the workflow-run IO panel). */
export function SortTh<Col extends string>({ label, col, active, dir, onSort }: {
  label: string; col: Col; active: Col | null; dir: SortDir; onSort: (c: Col) => void;
}) {
  const isActive = col === active;
  return (
    <th
      className={`sort-th${isActive ? ' sort-th-active' : ''}`}
      aria-sort={isActive ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        title={`Sort by ${label}`}
        style={{ background: 'none', border: 'none', padding: 0, margin: 0, font: 'inherit', color: 'inherit', cursor: 'pointer' }}
      >
        {label}{isActive ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );
}
