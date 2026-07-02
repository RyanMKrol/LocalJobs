import type { WorkflowDefinition } from '../../core/types.js';

/**
 * stock-digest: weekly Claude-narrated markdown summary of current stock
 * holdings + performance movers, DISTINCT from `stocks-sync` (which only
 * snapshots positions + threshold-alerts). Single stage. NOT limitable:
 * nothing to fan out over.
 *
 * Scheduled for Monday 08:00 — deliberately AFTER `stocks-sync`'s daily
 * '0 7 * * *' run, so a same-day-fresh portfolio snapshot is typically
 * available by the time this runs.
 *
 * Cross-workflow read (new pattern in this repo, T337): this stage reads
 * `stocks-sync`'s `data/out/portfolio.json` directly via a plain relative
 * import of `stocksSyncConfig`/`NormalizedPosition` — the two workflows are
 * NOT DAG-linked (the framework has no cross-workflow `dependsOn`), so this
 * stage simply reads whatever is currently on disk at run time and soft-skips
 * (WARN + clean return, no crash) if the file is missing or empty.
 *
 * Markdown-only output — no push notification is sent, mirroring
 * `listening-digest`.
 */
const workflow: WorkflowDefinition = {
  name: 'stock-digest',
  category: 'regular-maintenance',
  description:
    'Weekly markdown digest of stock holdings + performance movers, narrated by Claude from the ' +
    'stocks-sync portfolio snapshot, written to data/out/.',
  schedule: '0 8 * * 1',
  maxConcurrency: 1,
  jobs: [{ job: 'stock-digest-build' }],
};

export default workflow;
