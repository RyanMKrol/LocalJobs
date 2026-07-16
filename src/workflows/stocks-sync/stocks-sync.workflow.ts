import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Stocks-sync: pull the owner's current open equity positions from Trading212 via
 * a strictly read-only integration and write a local snapshot — no DynamoDB,
 * matching this repo's local-markdown-first direction.
 *
 * Stage 1, `stocks-fetch`, calls Trading212's read-only portfolio endpoint for the Invest
 * account (and the ISA account too, if TRADING212_ISA_API_KEY_ID/_SECRET_KEY are set),
 * normalizes each position into a broker-agnostic shape tagged by account, and writes
 * data/out/raw-positions.json — NOT yet ticker-resolved. Records one combined `work_items`
 * row per calendar day (investCount/isaCount/totalFetched), written unconditionally even
 * when zero positions are fetched.
 *
 * Stage 2, `stocks-resolve-names` (depends on stocks-fetch), reads raw-positions.json and
 * resolves each position's company name via Trading212's own instruments-metadata endpoint (at
 * most once per run) — Trading212-metadata-only, no OpenFIGI at all. A miss is a soft skip
 * (logged, `name` left undefined). Writes data/out/named-positions.json for stocks-snapshot to
 * read. Records ONE combined `work_items` row per calendar day, skipped entirely when there's
 * nothing to resolve.
 *
 * Stage 3, `stocks-snapshot` (depends on stocks-resolve-names), reads named-positions.json and
 * ALSO resolves each position's ISIN + a current, real-world ticker (Trading212's
 * `GET /equity/metadata/instruments`, at most once per run, + OpenFIGI) — a soft, never-throwing
 * best-effort step (a miss just logs a warn and leaves isin/resolvedTicker undefined for that
 * position). This is a deliberate, temporary duplication of the metadata call `stocks-resolve-names`
 * already makes — removing it (so `stocks-snapshot` no longer needs OpenFIGI at all) is a follow-up
 * task (T414). Writes the FINAL data/out/portfolio.json (structured) + data/out/portfolio.md
 * (human-readable, with a "Real ticker" column). Records ONE combined `work_items` row per
 * calendar day (same day-key convention as stocks-fetch — a same-day re-run overwrites rather
 * than duplicates), summarizing positionCount/totalValue/resolvedCount.
 *
 * Stage 4, `stocks-watch` (depends on stocks-snapshot), reads that snapshot and, for EVERY
 * position on EVERY run, computes + records its gain since average buy price — this
 * unconditional per-position ledger write (T300) means the check stage always has ledger
 * activity and is never misclassified as a noop by the framework's noop-detection, even when
 * nothing breaches. It tracks "already notified for the current breach episode" on a separate
 * ledger key and writes this run's fresh breaches to data/out/fresh-breaches.json.
 *
 * Stage 5, `stocks-notify` (depends on stocks-watch), reads fresh-breaches.json and sends ONE
 * push naming every position that freshly breached 30%+ above its average buy price this run —
 * a "re-scan + notification-log" idempotent stage (mirrors missing-tv-seasons): a fresh breach
 * notifies once, staying above 30% notifies nothing further, and dropping back below 30% resets
 * so a later re-breach notifies again. Unlike stocks-watch, `stocks-notify` legitimately shows as
 * skipped/noop when there's nothing to send — that's the correct, desired behavior; only the
 * *checking* work being mislabeled skipped was the bug.
 *
 * Runs daily (schedule editable from the dashboard).
 *
 * `outputJob: 'stocks-snapshot'` (T348, unaffected by the fetch/resolve split below since the
 * name didn't move): the DAG's terminal stage, `stocks-notify`, is a pure notify-trigger that
 * structurally never records work_items rows, so the unified Output section (T205, which by
 * default reads the terminal wave) would always show empty. `stocks-snapshot` is the stage with
 * real per-item output (the resolved-ticker positions — the genuinely user-facing "snapshot"),
 * so the Output section is overridden to read from it instead.
 */
const workflow: WorkflowDefinition = {
  name: 'stocks-sync',
  category: 'regular-maintenance',
  description:
    'Fetch the owner\'s Trading212 open equity positions (read-only), write a local ' +
    'portfolio.json + portfolio.md snapshot, and push a one-time alert when a position rises ' +
    '30%+ above its average buy price.',
  idempotencyNote: 'This workflow re-checks your full portfolio fresh every run (nothing is skipped) and only tracks which price-breach alerts have already been sent, so you\'re never re-alerted about the same breach until it resets by dropping back below the threshold first.',
  schedule: '0 7 * * *',
  maxConcurrency: 1,
  outputJob: 'stocks-snapshot',
  jobs: [
    { job: 'stocks-fetch' },
    { job: 'stocks-resolve-names', dependsOn: ['stocks-fetch'] },
    { job: 'stocks-snapshot', dependsOn: ['stocks-resolve-names'] },
    { job: 'stocks-watch', dependsOn: ['stocks-snapshot'] },
    { job: 'stocks-notify', dependsOn: ['stocks-watch'] },
  ],
};

export default workflow;
