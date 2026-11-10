// The one thing the overrides audit produces.
import { fromChecks, jsonArtifact } from '../../engine/index.js';
import type { StaleOverridesReport } from './types.js';

export const staleOverridesReport = jsonArtifact<StaleOverridesReport>({
  key: 'stale-overrides-report',
  description: 'Every dashboard override that has been live for two weeks or more, or whose age is unknown: the candidates to fold into code.',
  check: (v) => fromChecks([
    { label: 'has a list of overrides', ok: Array.isArray(v?.items), actual: Array.isArray(v?.items) ? `${v.items.length} override(s)` : 'no items list' },
    { label: 'count matches the list', ok: Array.isArray(v?.items) && v.count === v.items.length, actual: `count ${v?.count}` },
  ]),
  summary: (v) => `${v.count} stale override(s), threshold ${v.minAgeDays} day(s)`,
  items: (v) => v.items.map((i) => ({
    id: `${i.table}.${i.name}.${i.field}`,
    title: `${i.name} · ${i.field}`,
    fields: [
      { label: 'Kind', value: i.table },
      { label: 'Value', value: JSON.stringify(i.currentValue) },
      { label: 'Overridden', value: i.ageHuman },
    ],
  })),
});
