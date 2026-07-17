'use client';

import { Fragment, type ReactNode } from 'react';
import { usePoll } from '../ui';
import { IgnoredSection } from './IgnoredSection';
import { useAction } from './useAction';

export interface GroupedManagerConfig<T, GK extends string | number, D> {
  /** Section heading — h2 "Output" (a page with no other manager) or h3 (a page whose own
   * <h2>Output</h2> wraps this manager). */
  heading: { tag: 'h2' | 'h3'; text: string };
  description: ReactNode;
  fetchData: () => Promise<D>;
  getGeneratedAt: (data: D) => string | null;
  getItems: (data: D) => T[];
  isIgnored: (item: T) => boolean;
  /** String key for React list keys + per-item busy tracking. */
  itemKey: (item: T) => string;
  /** Group items (already filtered to active or ignored), sorted for display. */
  groupBy: (items: T[]) => [GK, T[]][];
  renderGroupLabel: (groupKey: GK, items: T[], data: D, ignoredSide: boolean) => ReactNode;
  /** Column header labels for the active-side table, excluding the trailing action column. */
  activeColumns: string[];
  /** Column header labels for the ignored-side table, excluding the trailing action column. */
  ignoredColumns: string[];
  /** Render the `<td>` cells for one item (excluding the trailing action cell). */
  renderCells: (item: T, ignoredSide: boolean) => ReactNode;
  emptyBeforeGenerated: { inPanel: boolean; text: string };
  summaryLine: (data: D, active: T[], activeGroups: [GK, T[]][], ignored: T[]) => ReactNode;
  /** Shown when there's data but zero active items — omit to render nothing (matches
   * MovieGapsManager, which has no such message). */
  noActiveMessage?: string;
  ignoredSubtitle: string;
  ignoreItem: (item: T) => Promise<unknown>;
  unignoreItem: (item: T) => Promise<unknown>;
  ignoreGroup: (groupKey: GK, items: T[]) => Promise<unknown>;
  unignoreGroup: (groupKey: GK, items: T[]) => Promise<unknown>;
}

/**
 * Generic manage-outputs section for a grouped list (franchise gaps grouped by
 * collection, missing seasons grouped by show): a group header (label + "Ignore
 * all"/"Un-ignore all" when the group has >1 item) followed by per-item rows with
 * their own Ignore/Un-ignore control. Parameterized by `GroupedManagerConfig` —
 * see `MOVIE_GAPS_CONFIG`/`MISSING_SEASONS_CONFIG` in `workflows/[name]/page.tsx`
 * for the two call sites.
 */
export function GroupedManager<T, GK extends string | number, D>({ config }: { config: GroupedManagerConfig<T, GK, D> }) {
  const {
    heading, description, fetchData, getGeneratedAt, getItems, isIgnored, itemKey, groupBy,
    renderGroupLabel, activeColumns, ignoredColumns, renderCells, emptyBeforeGenerated,
    summaryLine, noActiveMessage, ignoredSubtitle, ignoreItem, unignoreItem, ignoreGroup, unignoreGroup,
  } = config;
  const { data, error, refetch } = usePoll(fetchData, 5000);
  const item = useAction<string>(refetch);
  const group = useAction<GK>(refetch);
  const ignoredGroup = useAction<GK>(refetch);

  const all = data ? getItems(data) : [];
  const active = all.filter((it) => !isIgnored(it));
  const ignored = all.filter((it) => isIgnored(it));
  const activeGroups = groupBy(active);
  const ignoredGroups = groupBy(ignored);
  const generatedAt = data ? getGeneratedAt(data) : null;

  const doIgnore = (it: T) => item.run(itemKey(it), () => ignoreItem(it));
  const doUnignore = (it: T) => item.run(itemKey(it), () => unignoreItem(it));
  const doIgnoreGroup = (gk: GK, items: T[]) => group.run(gk, () => ignoreGroup(gk, items));
  const doUnignoreGroup = (gk: GK, items: T[]) => ignoredGroup.run(gk, () => unignoreGroup(gk, items));

  const err = item.err || group.err || ignoredGroup.err;

  return (
    <>
      {heading.tag === 'h2'
        ? <h2>{heading.text}</h2>
        : <h3 style={{ fontSize: 15, marginTop: 20 }}>{heading.text}</h3>}
      <p className="muted" style={{ fontSize: 13 }}>{description}</p>

      {error && <p className="error">Failed to load: {String(error)}</p>}
      {err && <p className="error">{err}</p>}

      {data && generatedAt == null && (
        emptyBeforeGenerated.inPanel ? (
          <div className="panel">
            <p className="empty-state-panel">{emptyBeforeGenerated.text}</p>
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>{emptyBeforeGenerated.text}</p>
        )
      )}

      {data && generatedAt != null && (
        <p className="muted" style={{ fontSize: 13 }}>{summaryLine(data, active, activeGroups, ignored)}</p>
      )}

      {active.length > 0 && (
        <div className="panel">
          <table className="grouped-manager-table">
            <thead>
              <tr>
                {activeColumns.map((label) => <th key={label}>{label}</th>)}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {activeGroups.map(([gk, items]) => (
                <Fragment key={gk}>
                  <tr className="table-group-header">
                    <td colSpan={activeColumns.length + 1}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                        <span>{renderGroupLabel(gk, items, data as D, false)}</span>
                        <button
                          className="btn btn-sm grouped-action-btn"
                          onClick={() => doIgnoreGroup(gk, items)}
                          disabled={group.busy === gk}
                          style={{ flexShrink: 0 }}
                        >
                          {group.busy === gk ? 'Ignoring…' : '✕ Ignore all'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {items.map((it) => (
                    <tr key={itemKey(it)}>
                      {renderCells(it, false)}
                      <td>
                        <button className="btn btn-sm grouped-action-btn" onClick={() => doIgnore(it)} disabled={item.busy === itemKey(it)}>
                          {item.busy === itemKey(it) ? 'Ignoring…' : '✕ Ignore'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {active.length === 0 && generatedAt != null && noActiveMessage && (
        <p className="muted" style={{ fontSize: 13 }}>{noActiveMessage}</p>
      )}

      {ignored.length > 0 && (
        <IgnoredSection count={ignored.length} subtitle={ignoredSubtitle}>
          <table>
            <thead>
              <tr>
                {ignoredColumns.map((label) => <th key={label}>{label}</th>)}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {ignoredGroups.map(([gk, items]) => (
                <Fragment key={gk}>
                  <tr className="table-group-header">
                    <td colSpan={ignoredColumns.length + 1}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                        <span>{renderGroupLabel(gk, items, data as D, true)}</span>
                        <button
                          className="btn btn-sm grouped-action-btn"
                          onClick={() => doUnignoreGroup(gk, items)}
                          disabled={ignoredGroup.busy === gk}
                          style={{ flexShrink: 0 }}
                        >
                          {ignoredGroup.busy === gk ? 'Un-ignoring…' : '↺ Un-ignore all'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {items.map((it) => (
                    <tr key={itemKey(it)} className="muted">
                      {renderCells(it, true)}
                      <td>
                        <button className="btn btn-sm grouped-action-btn" onClick={() => doUnignore(it)} disabled={item.busy === itemKey(it)}>
                          {item.busy === itemKey(it) ? 'Un-ignoring…' : '↺ Un-ignore'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </IgnoredSection>
      )}
    </>
  );
}
