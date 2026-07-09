'use client';

/**
 * Shared "one category group" panel used by pages that group a list into
 * labelled sections, each rendered as its own `.panel` with an `<h2>` heading
 * and a `<table>` (workflows/page.tsx, integrations/page.tsx). Stacked
 * instances get vertical spacing for free via the existing `.panel + .panel`
 * rule in globals.css — don't add new spacing CSS for this.
 *
 * The component owns the STRUCTURAL/STYLING wrapper only (panel, heading,
 * table/thead scaffold, optional colgroup for fixed column widths) — each
 * page still authors its own `<tr>`/`<td>` markup (and any interactivity —
 * click handlers, inline editing, popovers) as `children` for the `<tbody>`.
 *
 * Props:
 *   label      – category heading text, rendered in an `<h2>`
 *   columns    – header cells: `{ key, label, align?, width? }`. `align`
 *                defaults to 'left'; `width` (e.g. '32%') renders a
 *                `<colgroup>` when ANY column declares one.
 *   tableClassName – optional extra class on the `<table>` (e.g. "services-table")
 *   children   – the `<tbody>` content (one `<tr>` per row)
 */

interface CategoryTableColumn {
  key: string;
  label: string;
  align?: 'left' | 'center' | 'right';
  width?: string;
}

interface CategoryTableProps {
  label: string;
  columns: CategoryTableColumn[];
  tableClassName?: string;
  children: React.ReactNode;
}

export function CategoryTable({ label, columns, tableClassName, children }: CategoryTableProps) {
  const hasWidths = columns.some((c) => c.width);

  return (
    <div className="panel">
      <h2>{label}</h2>
      <table className={tableClassName}>
        {hasWidths && (
          <colgroup>
            {columns.map((c) => (
              <col key={c.key} style={c.width ? { width: c.width } : undefined} />
            ))}
          </colgroup>
        )}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={c.align && c.align !== 'left' ? { textAlign: c.align } : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
