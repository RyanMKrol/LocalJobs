import type { WorkflowDefinition } from '../../core/types.js';

/**
 * stock-digest: weekly Claude-narrated markdown summary of current stock
 * holdings, performance movers, and a sector/diversification breakdown,
 * DISTINCT from `stocks-sync` (which only snapshots positions +
 * threshold-alerts). NOT limitable: nothing to fan out over.
 *
 * Scheduled for Monday 08:00 — historically AFTER `stocks-sync`'s daily
 * '0 7 * * *' run, back when this workflow read stocks-sync's snapshot; kept
 * at the same time since it's still a sensible weekly cadence, though it no
 * longer depends on that ordering (see below).
 *
 * NO inter-workflow dependency (T382, reverses the T337 cross-workflow-read
 * pattern): stock-digest fetches its OWN Trading212 snapshot rather than
 * reading `stocks-sync`'s `data/out/portfolio.json`. Three-stage DAG:
 * `stock-portfolio-snapshot` (own credentials read + its own ISIN/OpenFIGI
 * real-ticker resolution, T373, via the shared `src/services/trading212.service.ts`
 * also used by `stocks-sync`) fans out to BOTH `stock-sector-lookup` (resolves
 * each held ticker's industry via the Finnhub company-profile API — preferring
 * the OpenFIGI-resolved real-world ticker over the raw/possibly-stale
 * Trading212 ticker — idempotent per ticker via the work_items ledger, writes
 * data/out/sectors.json) AND `stock-digest-build` (a genuine fan-in: it reads
 * BOTH the portfolio snapshot and, once `stock-sector-lookup` has run, the
 * sector map). The report degrades gracefully (omits the diversification
 * section) if sectors.json is missing or empty, and soft-skips (WARN + clean
 * return, no crash) if the portfolio snapshot is empty.
 *
 * Markdown-only output — no push notification is sent, mirroring
 * `listening-digest`.
 *
 * Shared lineage root (follow-up to T382): all three stages' `markWorkItem` calls
 * use the SAME `weekKey(now)` (`src/jobs/stock-digest/lib.ts`) as their `rootKey` —
 * `stock-portfolio-snapshot` collapses to ONE combined ledger row per run (keyed by
 * that week, not one row per position), and both `stock-sector-lookup` (per-ticker
 * keys) and `stock-digest-build` (its own week-keyed row) pass that same value as
 * `rootKey` explicitly. Without this, each stage's `markWorkItem` calls defaulted to
 * `root_key = item_key`, so three DIFFERENT key shapes (composite `account:ticker`,
 * bare ticker, ISO week) never joined — the workflow-run Input → Output panel showed
 * a confusing union of disjoint roots instead of one clean row per week. See the root
 * CLAUDE.md "root_key/parent_key lineage" convention.
 */
const workflow: WorkflowDefinition = {
  name: 'stock-digest',
  category: 'regular-maintenance',
  description:
    'Weekly markdown digest of stock holdings, performance movers, and a sector/diversification ' +
    'breakdown, narrated by Claude from stock-digest\'s own Trading212 portfolio snapshot + Finnhub ' +
    'industry lookups, written to data/out/.',
  schedule: '0 8 * * 1',
  maxConcurrency: 1,
  jobs: [
    { job: 'stock-portfolio-snapshot' },
    { job: 'stock-sector-lookup', dependsOn: ['stock-portfolio-snapshot'] },
    { job: 'stock-digest-build', dependsOn: ['stock-portfolio-snapshot', 'stock-sector-lookup'] },
  ],
};

export default workflow;
