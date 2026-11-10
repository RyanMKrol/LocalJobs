// Shared hermetic dashboard test harness.
//
// This is the SINGLE source of truth for driving the dashboard in a headless browser
// against synthetic data — used by BOTH:
//   - mobile-check.mjs   (phone-viewport layout/overflow check)
//   - visual-check.mjs   (desktop-viewport screenshot capture for visual confirmation)
//
// It owns the page list, the synthetic API fixtures, the `next start` spawn, the
// `/api/**` route interception, and theme/localStorage seeding — so there is exactly
// ONE place to keep current. ⚠️ LIVING ARTIFACT: when the dashboard's UI surface
// changes (a page is added, a workflow/gate is added or removed, UI is removed), the
// PAGES list and/or fixtures below MUST be updated in the same change, so the checks
// stay accurate and don't start failing on intentionally-removed things.
//
// It is hermetic by design: it starts a production `next start` of the dashboard and
// serves every `/api/*` request from in-process fixtures (Playwright route
// interception), so NO daemon, NO real SQLite, and NO paid API calls are touched. The
// fixtures deliberately include long, adversarial strings (long cron, long URLs, long
// item keys, long errors) to stress the layout.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DASHBOARD_DIR = resolve(__dirname, '..');

// ── Synthetic fixtures ──────────────────────────────────────────────────────
// A long string to stress wrapping / overflow on every text surface.
const LONG = 'a-really-long-unbroken-identifier-token-that-should-not-widen-the-page-0123456789';
const LONG_URL =
  'https://www.fragrantica.com/perfume/Some-House/A-Very-Long-Perfume-Name-That-Goes-On-12345.html?ref=tracking';
const LONG_ERR =
  'Error: upstream returned an unexpectedly long error message that should wrap cleanly instead of pushing the layout sideways past the right edge of a narrow phone screen';
const NOW = '2026-06-22 09:00:00';

const run = (over) => ({
  id: '1', job_name: 'places-enrich-with-a-long-job-name', status: 'success', trigger: 'schedule',
  attempt: 1, progress: 100, progress_msg: 'done', started_at: NOW, finished_at: NOW,
  duration_ms: 12345, exit_code: 0, error: null, workflow_run_id: '1', ...over,
});

const workflowRun = (over) => ({
  id: '1', workflow_name: 'places', status: 'success', trigger: 'schedule', progress: 100,
  progress_msg: 'all stages complete', started_at: NOW, finished_at: NOW, duration_ms: 45678, ...over,
});

const members = [
  { job_name: 'places-resolve', depends_on: [] },
  { job_name: 'places-enrich', depends_on: ['places-resolve'] },
  { job_name: 'places-enrich-with-llm', depends_on: ['places-enrich'] },
];

const stuckItem = (over) => ({
  job_name: 'perfumes-fetch', item_key: LONG, attempts: 3,
  detail: { name: 'A Stuck Item With A Fairly Long Display Name', error: LONG_ERR, status: 'failed',
            pageTitle: 'Just a moment...', snippet: 'Checking your browser before accessing the site',
            debugFile: '/Users/x/Development/local-jobs/src/workflows/perfumes/data/debug/' + LONG + '.html',
            finalUrl: LONG_URL, textLength: 1234, httpStatus: 403 },
  updated_at: NOW, ...over,
});

const workflow = (over) => ({
  name: 'places', description: 'A worked-example workflow: ' + LONG, schedule: '0 3 * * *',
  category: 'second-brain',
  idempotency_note: 'Tracks each resolved place_id in the work_items ledger (T613 synthetic fixture) — ' + LONG,
  enabled: 1, effective_notify_enabled: true, created_at: NOW, last_run: workflowRun(), next_run: NOW, jobs: members,
  stuck: 2, runs: [workflowRun(), workflowRun({ id: '2', status: 'partial' })],
  gates: structuralGates, certified: 1, ...over,
});

const service = (over) => ({
  name: 'google-places', description: 'Google Places API — ' + LONG, category: 'api', rate_per_minute: 60,
  daily_cap: 100, monthly_cap: 3000, timeout_ms: 15000, paid: 1, limits_overridden: 1,
  used_today: 42, used_month: 123456, rate_last_min: 12,
  rate_limit_source: 'Documented at https://developers.google.com/maps/documentation/places/web-service/usage-and-billing — ' + LONG,
  ...over,
});

const job = (over) => ({
  name: 'places-enrich', description: 'Enrich resolved places — ' + LONG, schedule: null,
  timeout_ms: 600000, max_retries: 1, enabled: 1, created_at: NOW, last_run: run(),
  next_run: NOW, instructions: 'Set GOOGLE_PLACES_KEY in .env. ' + LONG, stuck: 1,
  workflow: 'places', ...over,
});

const logs = [
  { id: 1, ts: NOW, level: 'info', message: 'starting ' + LONG },
  { id: 2, ts: NOW, level: 'warn', message: 'slow upstream ' + LONG_URL },
  { id: 3, ts: NOW, level: 'error', message: LONG_ERR },
];

// Structural gates (no state — displayed as muted-grey padlocks on the definition-view DAG).
const structuralGates = [
  { key: 'resolved.json', producer: 'places-resolve', consumer: 'places-enrich', description: 'produces — resolved.json is a non-empty array of place_ids · consumes — every row has a place_id' },
  { key: 'enriched.json', producer: 'places-enrich', consumer: 'places-enrich-with-llm', description: 'produces — enriched.json has name + address fields' },
];

// Run-scoped gates (with state — colour-coded in the run-view DAG).
const gates = [
  { key: 'resolved.json', producer: 'places-resolve', consumer: 'places-enrich', state: 'passed', description: 'produces — resolved.json is a non-empty array of place_ids · consumes — every row has a place_id' },
  { key: 'enriched.json', producer: 'places-enrich', consumer: 'places-enrich-with-llm', state: 'failed', failureRunId: '1', description: 'produces — enriched.json has name + address fields' },
];

// Gate inspection fixtures (the gate DETAIL pages — run-scoped and definition-scoped).
const gateShape = {
  summary: 'A non-empty JSON array of resolved places, one row per input CID.',
  format: 'JSON array',
  expectations: [
    { label: 'file exists and is non-empty', detail: 'resolved.json has at least one row' },
    { label: 'every row has a place_id', detail: 'the Google Places identifier used downstream' },
  ],
};
const gateInspection = {
  gate: gates[0],
  produced: { shape: gateShape, result: { ok: true, checks: [
    { label: 'file exists and is non-empty', ok: true, actual: '42 rows' },
    { label: 'every row has a place_id', ok: true, actual: '42/42 rows' },
  ], sample: '[{"cid":"' + LONG + '","place_id":"ChIJ123"}]' } },
  consumed: { shape: gateShape, result: { ok: true, checks: [
    { label: 'file exists and is non-empty', ok: true, actual: '42 rows' },
    { label: 'every row has a place_id', ok: true, actual: '42/42 rows' },
  ], sample: '[{"cid":"' + LONG + '","place_id":"ChIJ123"}]' } },
  identical: true,
  // The result the engine RECORDED when it checked this boundary during the run
  // (not a re-check of whatever is on disk today).
  recorded: { at: 1780300800000, source: 'gate' },
};
const structuralGateDetail = {
  gate: structuralGates[0],
  produced: { shape: gateShape },
  consumed: { shape: gateShape },
  identical: true,
};

// A run/stage that did no work (T258 noop detection) — settles 'skipped' instead of
// 'success' so the dashboard reads "nothing to do", not a misleading green success.
// Exercises T281's distinct skipped pill/label.
const workflowRunSkipped = workflowRun({
  id: 'skipped', status: 'skipped', progress: 100, progress_msg: 'nothing to do',
});
// A noop run: every stage ran and had nothing to do. Each member row carries the
// machine-readable `outcome_reason` the run page explains under the stage name.
const membersSkipped = members.map((m, i) => run({
  id: `skipped-${i}`, job_name: m.job_name, status: 'skipped', workflow_run_id: 'skipped',
  outcome_reason: i === 0 ? 'noop' : 'upstream-skipped', cycle: 1,
  error: i === 0 ? null : `skipped: upstream ${members[0].job_name} did not succeed (skipped)`,
}));

// Builders for PORTS fixtures (a run page derived from what the engine recorded):
// an artifact card, an input card, and one stage's Inputs & Outputs.
let artifactSeq = 100;
const portsArtifact = (over) => ({
  id: artifactSeq++, job: '', port: '', artifactKey: '', description: null,
  storage: 'json', format: 'json', ok: true, fresh: true, note: null, summary: null, itemCount: null, bytes: null,
  committedAtMs: 1780300800000, preview: null, sample: [], check: { ok: true }, ...over,
});
const asInput = (artifact, consumerPort, extra = {}) => ({ ...artifact, consumerPort, resolved: { ok: true, reason: null }, ...extra });
const portsIo = (job, over) => ({
  job, mode: 'ports', limit: 100, predecessorJobs: [], outputJobs: [job], inputs: [], outputs: [], inputTotal: 0, outputTotal: 0,
  inputArtifacts: [], outputArtifacts: [], outputsUnchanged: 0, ...over,
});
const singleOutputIo = (job, artifacts, rows = []) => ({
  stage: { [job]: portsIo(job, { outputArtifacts: artifacts, outputs: rows, outputTotal: rows.length }) },
  overall: portsIo('__overall__', { outputJobs: [job], outputArtifacts: artifacts, outputs: rows, outputTotal: rows.length }),
});
// A three-stage audit on ports (snapshot -> check -> notify): missing-movies and
// missing-tv-seasons. The first two stages show artifacts only; the notify stage
// also lists the items it announced.
function auditPortsFixtures({ dir, stages: [snap, check, notify], snapshot, found, report, digest, announced }) {
  const snapshotArt = portsArtifact({ job: snap, port: 'snapshot', preview: { path: `${dir}/data/out/snapshot.json`, format: 'json' }, ...snapshot });
  const foundArt = portsArtifact({ job: check, preview: { path: `${dir}/data/out/${found.file}`, format: 'json' }, ...found });
  const reportArt = portsArtifact({ job: notify, port: 'report', storage: 'file', format: 'markdown', preview: { path: `${dir}/data/out/reports/${report.file}`, format: 'markdown' }, ...report });
  const digestArt = portsArtifact({ job: notify, port: 'digest', storage: 'inline', ...digest });
  const rows = announced.map((a) => ({ id: `${notify}:${a.itemKey}`, jobName: notify, status: 'success', fields: [], preview: reportArt.preview, ...a }));
  return {
    stageIo: {
      [snap]: portsIo(snap, { outputArtifacts: [snapshotArt] }),
      [check]: portsIo(check, { predecessorJobs: [snap], inputArtifacts: [asInput(snapshotArt, 'snapshot')], outputArtifacts: [foundArt] }),
      [notify]: portsIo(notify, { predecessorJobs: [check], inputArtifacts: [asInput(foundArt, foundArt.port)], outputArtifacts: [reportArt, digestArt], outputs: rows, outputTotal: rows.length }),
    },
    overall: portsIo('__overall__', { predecessorJobs: [snap], outputJobs: [notify], inputArtifacts: [snapshotArt], outputArtifacts: [reportArt, digestArt], outputs: rows, outputTotal: rows.length }),
    gates: [
      { key: snapshotArt.artifactKey, producer: snap, consumer: check, state: 'passed' },
      { key: foundArt.artifactKey, producer: check, consumer: notify, state: 'passed' },
    ],
  };
}
// A two-stage sync on ports (fetch -> build): workouts-sync and projects-sync. Each stage
// has an artifact card and the ledger items it changed this run; the second stage's
// input items are the first stage's rows.
function twoStagePortsFixtures({ stages: [first, second], firstArtifact, firstRows, secondArtifacts, secondRows }) {
  const a = portsArtifact({ job: first, ...firstArtifact });
  const outs = secondArtifacts.map((x) => portsArtifact({ job: second, ...x }));
  const row = (job) => (r) => ({ id: `${job}:${r.itemKey}`, jobName: job, status: 'success', fields: [], ...r });
  const r1 = firstRows.map(row(first));
  const r2 = secondRows.map(row(second));
  return {
    stageIo: {
      [first]: portsIo(first, { outputArtifacts: [a], outputs: r1, outputTotal: r1.length }),
      [second]: portsIo(second, { predecessorJobs: [first], inputArtifacts: [asInput(a, a.port)], inputs: r1, inputTotal: r1.length, outputArtifacts: outs, outputs: r2, outputTotal: r2.length }),
    },
    overall: portsIo('__overall__', { predecessorJobs: [first], outputJobs: [second], inputs: r1, inputTotal: r1.length, outputArtifacts: outs, outputs: r2, outputTotal: r2.length }),
    gates: [{ key: a.artifactKey, producer: first, consumer: second, state: 'passed' }],
  };
}
// A workflow whose data travels in the LEDGER (plex-language-fix, plex-rename): every
// stage's output is a ledger artifact, and its items are the rows it changed this run.
// `stages` are in DAG order; each names the stages it depends on.
function ledgerPipelineFixtures(stages, { product } = {}) {
  const art = Object.fromEntries(stages.map((st) => [st.job, portsArtifact({
    job: st.job, port: st.port, artifactKey: st.key, storage: 'ledger', format: null, description: st.description,
    summary: st.summary, itemCount: st.count, sample: st.rows.map((r) => ({ id: r.itemKey, title: r.title, fields: r.fields ?? [] })),
  })]));
  const rowsOf = Object.fromEntries(stages.map((st) => [st.job, st.rows.map((r) => ({ id: `${st.job}:${r.itemKey}`, jobName: st.job, status: 'success', fields: [], ...r }))]));
  const portOf = Object.fromEntries(stages.map((st) => [st.job, st.port]));
  const stageIo = Object.fromEntries(stages.map((st) => {
    const deps = st.deps ?? [];
    const inputs = deps.length ? rowsOf[deps[deps.length - 1]] : [];
    return [st.job, portsIo(st.job, {
      predecessorJobs: deps,
      inputArtifacts: deps.map((d) => asInput(art[d], portOf[d])),
      inputs, inputTotal: inputs.length,
      outputArtifacts: [art[st.job]],
      outputs: rowsOf[st.job], outputTotal: st.outputTotal ?? rowsOf[st.job].length,
    })];
  }));
  const first = stages[0].job;
  const out = product ?? stages[stages.length - 1].job;
  const overall = portsIo('__overall__', {
    predecessorJobs: [first], outputJobs: [out], inputs: rowsOf[first], inputTotal: rowsOf[first].length,
    outputArtifacts: [art[out]], outputs: rowsOf[out], outputTotal: rowsOf[out].length,
  });
  const gates = stages.flatMap((st) => (st.deps ?? []).map((d) => ({ key: art[d].artifactKey, producer: d, consumer: st.job, state: 'passed' })));
  return { stageIo, overall, gates };
}
const stocksMembers = [
  { job_name: 'stocks-fetch', depends_on: [] },
  { job_name: 'stocks-resolve-names', depends_on: ['stocks-fetch'] },
  { job_name: 'stocks-snapshot', depends_on: ['stocks-resolve-names'] },
  { job_name: 'stocks-watch', depends_on: ['stocks-snapshot'] },
  { job_name: 'stocks-notify', depends_on: ['stocks-watch'] },
];
const stocksWorkflowRun = workflowRun({ id: 'stocks', workflow_name: 'stocks-sync' });
const stocksRunJobs = stocksMembers.map((m, i) => run({
  id: `stocks-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'stocks',
}));
// stocks-sync on ports: five stages in a line. Its PRODUCT is the portfolio the third
// stage writes (the stage is marked `product`), not anything the final notify stage does,
// so the Overall tab's outputs are the snapshot's.
const positionSample = [
  { id: 'invest:AAPL_US_EQ', title: 'Apple Inc.', fields: [{ label: 'Ticker', value: 'AAPL_US_EQ' }, { label: 'Account', value: 'invest' }, { label: 'Value', value: '1983.20' }] },
  { id: 'isa:VUSA_EQ', title: 'Vanguard S&P 500', fields: [{ label: 'Ticker', value: 'VUSA_EQ' }, { label: 'Account', value: 'isa' }, { label: 'Value', value: '4105.00' }] },
];
const stocksArt = {
  raw: portsArtifact({ job: 'stocks-fetch', port: 'raw', artifactKey: 'stocks-raw-positions', description: 'The open positions as fetched from Trading212, tagged by account, before any name is resolved.', summary: '9 position(s)', itemCount: 9, bytes: 1_900, preview: { path: 'stocks-sync/data/out/raw-positions.json', format: 'json' }, sample: positionSample }),
  named: portsArtifact({ job: 'stocks-resolve-names', port: 'named', artifactKey: 'stocks-named-positions', description: 'The positions with each company name filled in where Trading212 knows it. A missing name is allowed.', summary: '9 position(s), 9 named', itemCount: 9, bytes: 2_200, preview: { path: 'stocks-sync/data/out/named-positions.json', format: 'json' }, sample: positionSample }),
  portfolio: portsArtifact({ job: 'stocks-snapshot', port: 'portfolio', artifactKey: 'stocks-portfolio', description: 'The portfolio snapshot: every open position with its quantity, prices and value.', summary: '9 position(s), total value 307129.77', itemCount: 9, bytes: 2_200, preview: { path: 'stocks-sync/data/out/portfolio.json', format: 'json' }, sample: positionSample }),
  report: portsArtifact({ job: 'stocks-snapshot', port: 'report', artifactKey: 'stocks-portfolio-report', storage: 'file', format: 'markdown', description: 'The portfolio as a markdown table, one row per position with its gain since purchase.', bytes: 1_100, preview: { path: 'stocks-sync/data/out/portfolio.md', format: 'markdown' } }),
  breaches: portsArtifact({ job: 'stocks-watch', port: 'breaches', artifactKey: 'stocks-fresh-breaches', description: 'The positions that newly crossed the gain threshold this run. Empty on a normal day.', summary: '1 fresh breach(es)', itemCount: 1, bytes: 140, preview: { path: 'stocks-sync/data/out/fresh-breaches.json', format: 'json' }, sample: [{ id: 'invest:AAPL_US_EQ', title: 'AAPL_US_EQ', fields: [{ label: 'Account', value: 'invest' }, { label: 'Gain', value: '32.2%' }] }] }),
  digest: portsArtifact({ job: 'stocks-notify', port: 'digest', artifactKey: 'stocks-breach-digest', storage: 'inline', description: 'What this run announced: how many newly breaching positions were pushed, and which.', summary: '1 announced: AAPL_US_EQ', inline: { notified: 1, tickers: ['AAPL_US_EQ'] }, bytes: 44 }),
};
const stocksWatchRows = [
  { id: 'stocks-watch:invest:AAPL_US_EQ', jobName: 'stocks-watch', itemKey: 'invest:AAPL_US_EQ', status: 'success', title: '[invest] AAPL_US_EQ', fields: [{ label: 'Gain', value: '32.2%' }, { label: 'Above threshold', value: 'yes' }] },
  { id: 'stocks-watch:isa:VUSA_EQ', jobName: 'stocks-watch', itemKey: 'isa:VUSA_EQ', status: 'success', title: '[isa] VUSA_EQ', fields: [{ label: 'Gain', value: '-9.3%' }] },
];
const stocksStageIo = {
  'stocks-fetch': portsIo('stocks-fetch', { outputArtifacts: [stocksArt.raw] }),
  'stocks-resolve-names': portsIo('stocks-resolve-names', { predecessorJobs: ['stocks-fetch'], inputArtifacts: [asInput(stocksArt.raw, 'raw')], outputArtifacts: [stocksArt.named] }),
  'stocks-snapshot': portsIo('stocks-snapshot', { predecessorJobs: ['stocks-resolve-names'], inputArtifacts: [asInput(stocksArt.named, 'named')], outputArtifacts: [stocksArt.portfolio, stocksArt.report] }),
  'stocks-watch': portsIo('stocks-watch', { predecessorJobs: ['stocks-snapshot'], inputArtifacts: [asInput(stocksArt.portfolio, 'portfolio')], outputArtifacts: [stocksArt.breaches], outputs: stocksWatchRows, outputTotal: 2 }),
  'stocks-notify': portsIo('stocks-notify', { predecessorJobs: ['stocks-watch'], inputArtifacts: [asInput(stocksArt.breaches, 'breaches')], outputArtifacts: [stocksArt.digest] }),
};
const stocksStageIoOverall = portsIo('__overall__', {
  predecessorJobs: ['stocks-fetch'], outputJobs: ['stocks-snapshot'],
  inputArtifacts: [stocksArt.raw], outputArtifacts: [stocksArt.portfolio, stocksArt.report],
});
const stocksGates = [
  { key: 'stocks-raw-positions', producer: 'stocks-fetch', consumer: 'stocks-resolve-names', state: 'passed' },
  { key: 'stocks-named-positions', producer: 'stocks-resolve-names', consumer: 'stocks-snapshot', state: 'passed' },
  { key: 'stocks-portfolio', producer: 'stocks-snapshot', consumer: 'stocks-watch', state: 'passed' },
  { key: 'stocks-fresh-breaches', producer: 'stocks-watch', consumer: 'stocks-notify', state: 'passed' },
];

// stock-digest — exercises StageIoPanel (decoupled inputs/outputs, T382 follow-up).
// StageIoPanel is now (T386) the default for EVERY workflow's run-detail page, so this
// fixture set proves the genuine fan-in shape it was originally built for.
// A 4-stage diamond: stock-portfolio-snapshot feeds both stock-sector-lookup AND
// stock-digest-build, and the build also takes the lookup's sector map.
const stockDigestMembers = [
  { job_name: 'stock-portfolio-fetch', depends_on: [] },
  { job_name: 'stock-portfolio-snapshot', depends_on: ['stock-portfolio-fetch'] },
  { job_name: 'stock-sector-lookup', depends_on: ['stock-portfolio-snapshot'] },
  { job_name: 'stock-digest-build', depends_on: ['stock-portfolio-snapshot', 'stock-sector-lookup'] },
];
const stockDigestWorkflowRun = workflowRun({ id: 'stock-digest-run', workflow_name: 'stock-digest' });
const stockDigestRunJobs = stockDigestMembers.map((m, i) => run({
  id: `stock-digest-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'stock-digest-run',
}));
// On ports: the build stage shows TWO input cards from two different stages (the
// portfolio from the snapshot, the sector map from the lookup). The lookup's items
// include a failed one, with its error.
const stockDigestArt = {
  raw: portsArtifact({ job: 'stock-portfolio-fetch', port: 'raw', artifactKey: 'stock-raw-portfolio', description: 'The open positions as fetched from Trading212, before any ticker is resolved.', summary: '9 position(s)', itemCount: 9, bytes: 1_900, preview: { path: 'stock-digest/data/out/raw-portfolio.json', format: 'json' }, sample: positionSample }),
  portfolio: portsArtifact({ job: 'stock-portfolio-snapshot', port: 'portfolio', artifactKey: 'stock-digest-portfolio', description: 'The positions with each real-world ticker resolved where possible. This is what the digest is written from.', summary: '9 position(s), 9 with a resolved ticker', itemCount: 9, bytes: 2_600, preview: { path: 'stock-digest/data/out/portfolio.json', format: 'json' }, sample: positionSample }),
  sectors: portsArtifact({ job: 'stock-sector-lookup', port: 'sectors', artifactKey: 'stock-sectors', description: 'Each held ticker mapped to its industry, or null where none could be found. Grows as tickers are looked up.', summary: '9 ticker(s), 8 with an industry', itemCount: 9, bytes: 410, preview: { path: 'stock-digest/data/out/sectors.json', format: 'json' }, sample: [{ id: 'AMD_US_EQ', title: 'AMD_US_EQ', fields: [{ label: 'Industry', value: 'Semiconductors' }] }] }),
  digests: portsArtifact({ job: 'stock-digest-build', port: 'digests', artifactKey: 'stock-digests', storage: 'dir', format: 'markdown', description: 'The weekly digests: stock-digest-<YYYY-Www>.md.', summary: '19 digest(s)', itemCount: 19 }),
};
const stockDigestSectorRows = [
  { id: 'stock-sector-lookup:AMD_US_EQ', jobName: 'stock-sector-lookup', itemKey: 'AMD_US_EQ', status: 'success', title: 'AMD_US_EQ', fields: [{ label: 'Industry', value: 'Semiconductors' }, { label: 'Looked up as', value: 'AMD' }] },
  { id: 'stock-sector-lookup:AMZN_US_EQ', jobName: 'stock-sector-lookup', itemKey: 'AMZN_US_EQ', status: 'success', title: 'AMZN_US_EQ', fields: [{ label: 'Industry', value: 'Retail' }, { label: 'Looked up as', value: 'AMZN' }] },
  { id: 'stock-sector-lookup:BRK_B_US_EQ', jobName: 'stock-sector-lookup', itemKey: 'BRK_B_US_EQ', status: 'failed', title: 'BRK_B_US_EQ', fields: [{ label: 'Looked up as', value: 'BRK/B' }, { label: 'Error', value: 'Finnhub returned no finnhubIndustry field' }] },
];
const stockDigestBuildRows = [
  { id: 'stock-digest-build:2026-W27', jobName: 'stock-digest-build', itemKey: '2026-W27', status: 'success', title: 'Stock digest — Week 27, 2026', fields: [], preview: { path: 'stock-digest/data/out/stock-digest-2026-W27.md', format: 'markdown' } },
];
const stockDigestStageIo = {
  'stock-portfolio-fetch': portsIo('stock-portfolio-fetch', { outputArtifacts: [stockDigestArt.raw] }),
  'stock-portfolio-snapshot': portsIo('stock-portfolio-snapshot', { predecessorJobs: ['stock-portfolio-fetch'], inputArtifacts: [asInput(stockDigestArt.raw, 'raw')], outputArtifacts: [stockDigestArt.portfolio] }),
  'stock-sector-lookup': portsIo('stock-sector-lookup', { predecessorJobs: ['stock-portfolio-snapshot'], inputArtifacts: [asInput(stockDigestArt.portfolio, 'portfolio')], outputArtifacts: [stockDigestArt.sectors], outputs: stockDigestSectorRows, outputTotal: 3 }),
  'stock-digest-build': portsIo('stock-digest-build', {
    predecessorJobs: ['stock-portfolio-snapshot', 'stock-sector-lookup'],
    inputArtifacts: [asInput(stockDigestArt.portfolio, 'portfolio'), asInput(stockDigestArt.sectors, 'sectors')],
    outputArtifacts: [stockDigestArt.digests], outputs: stockDigestBuildRows, outputTotal: 1,
  }),
};
const stockDigestStageIoOverall = portsIo('__overall__', {
  predecessorJobs: ['stock-portfolio-fetch'], outputJobs: ['stock-digest-build'],
  inputArtifacts: [stockDigestArt.raw], outputArtifacts: [stockDigestArt.digests], outputs: stockDigestBuildRows, outputTotal: 1,
});
const stockDigestGates = [
  { key: 'stock-raw-portfolio', producer: 'stock-portfolio-fetch', consumer: 'stock-portfolio-snapshot', state: 'passed' },
  { key: 'stock-digest-portfolio', producer: 'stock-portfolio-snapshot', consumer: 'stock-sector-lookup', state: 'passed' },
  { key: 'stock-digest-portfolio', producer: 'stock-portfolio-snapshot', consumer: 'stock-digest-build', state: 'passed' },
  { key: 'stock-sectors', producer: 'stock-sector-lookup', consumer: 'stock-digest-build', state: 'passed' },
];

// T386: `places` — a STRICTLY-LINEAR 3-stage chain (places-resolve -> places-enrich ->
// places-enrich-with-llm, no fan-out/fan-in at all), proving StageIoPanel against the
// simplest multi-stage shape now that it's the default for every workflow. Reuses the
// existing `/workflow-runs/1` run (workflow_name: 'places', `members` above).
// T457: detail carries fields beyond `name` (mirroring the real resolve.ts/enrich.ts
// `markWorkItem` calls) so the dashboard's per-item detail-hint pills are exercised.
const placesResolveOutput = { jobName: 'places-resolve', itemKey: 'cid:' + LONG, status: 'success', detail: { name: 'A Resolved Place With A Long Name', placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4' } };
const placesEnrichOutput = { jobName: 'places-enrich', itemKey: 'place:ChIJ' + LONG, status: 'success', detail: { name: 'A Resolved Place With A Long Name — enriched fields only', rating: 4.6, type: 'Restaurant', address: '221B Baker Street, London' } };
const placesLlmOutput = { jobName: 'places-enrich-with-llm', itemKey: 'place:ChIJ' + LONG, status: 'success', detail: { name: 'A Resolved Place With A Long Name', markdown: '/abs/data/out/' + LONG + '.md' } };
// T458: a JSON-format (detail.path + format:'json', not detail.markdown) output item, so
// visual-check exercises the OutputRenderer's real json renderer (pretty-printed, not
// collapsed through the markdown viewer) on the Stage I/O popover.
const PLACES_JSON_ITEM_KEY = 'place:json-summary';
const placesLlmJsonOutput = {
  jobName: 'places-enrich-with-llm', itemKey: PLACES_JSON_ITEM_KEY, status: 'success',
  detail: { name: 'Enrichment summary (JSON)', path: '/abs/data/out/place-summary.json', format: 'json' },
};
// The GET .../output(-items)?...&key=<PLACES_JSON_ITEM_KEY> response body — a real
// (unformatted) JSON string so the OutputRenderer json path's own pretty-printing
// (JSON.stringify(..., null, 2)) is what's actually visible in the screenshot.
const placesJsonOutputFixture = {
  found: true, job: 'places-enrich-with-llm', key: PLACES_JSON_ITEM_KEY, format: 'json',
  file: '/abs/data/out/place-summary.json', bytes: 256, truncated: false,
  content: JSON.stringify({
    name: 'A Resolved Place With A Long Name',
    rating: 4.6,
    tags: ['restaurant', 'italian'],
    location: { lat: 51.5237, lng: -0.1586 },
  }),
};
const placesStageIo = {
  'places-resolve': { inputs: [], outputs: [placesResolveOutput], predecessorJobs: [], job: 'places-resolve' },
  'places-enrich': { inputs: [placesResolveOutput], outputs: [placesEnrichOutput], predecessorJobs: ['places-resolve'], job: 'places-enrich' },
  'places-enrich-with-llm': { inputs: [placesEnrichOutput], outputs: [placesLlmOutput, placesLlmJsonOutput], predecessorJobs: ['places-enrich'], job: 'places-enrich-with-llm' },
};
const placesStageIoOverall = {
  inputs: [placesResolveOutput],
  outputs: [placesLlmOutput, placesLlmJsonOutput],
  predecessorJobs: ['places-resolve'],
  outputJobs: ['places-enrich-with-llm'],
  job: '__overall__',
};

// T386: a SINGLE-STAGE workflow (self-pairing — root wave AND terminal wave are the
// SAME single job) — proves StageIoPanel doesn't crash/render nonsense when a stage is
// simultaneously its own predecessor-less root and its own terminal output.
const singleStageMembers = [{ job_name: 'claude-warm', depends_on: [] }];
const singleStageWorkflowRun = workflowRun({ id: 'claude-warmer-run', workflow_name: 'claude-warmer', progress: 100 });
const singleStageRunJobs = singleStageMembers.map((m, i) => run({
  id: `claude-warmer-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'claude-warmer-run',
}));
// claude-warm is a ports stage with one INLINE output: how the warm attempt went.
const claudeWarmIo = singleOutputIo('claude-warm', [portsArtifact({
  job: 'claude-warm', port: 'result', artifactKey: 'claude-warm-result', storage: 'inline',
  description: 'How this warm attempt went: warmed, already active (a limit was hit), or failed.',
  summary: 'warmed (claude-haiku-4-5-20251001)', bytes: 86,
  inline: { outcome: 'warmed', model: 'claude-haiku-4-5-20251001', at: '2026-06-22T09:00:02.000Z' },
})]);
const singleStageStageIo = claudeWarmIo.stage;
const singleStageStageIoOverall = claudeWarmIo.overall;

const rec = (over) => ({
  tmdbId: 100, title: 'Inception', year: 2010, reason: 'A deeply layered thriller.', lens: 'cerebral',
  genre: 'Science Fiction', tmdbRating: 8.4, notified: false, ignored: false, ...over,
});

// T333: ~15 ACTIVE (non-ignored) rows — a realistic magnitude that genuinely overflows the
// 520px .movie-gaps-scroll max-height, so the scroll-container bug (and its fix) is actually
// reproducible/visible rather than vacuously passing with a short, non-overflowing list.
const movieRecs = {
  generatedAt: NOW, pooled: 20,
  recommendations: [
    rec({ tmdbId: 100, title: 'Inception', year: 2010, lens: 'cerebral', genre: 'Science Fiction', tmdbRating: 8.4 }),
    rec({ tmdbId: 101, title: 'Arrival', year: 2016, lens: 'cerebral', genre: 'Science Fiction', tmdbRating: 7.9 }),
    rec({ tmdbId: 102, title: 'Parasite', year: 2019, lens: 'serendipity', genre: 'Drama', tmdbRating: 8.5, notified: true }),
    rec({ tmdbId: 103, title: 'Mad Max: Fury Road', year: 2015, lens: 'high-octane', genre: 'Action', tmdbRating: 7.8 }),
    rec({ tmdbId: 104, title: 'The Grand Budapest Hotel', year: 2014, lens: 'auteur', genre: 'Comedy', tmdbRating: 8.1 }),
    rec({ tmdbId: 105, title: 'Spirited Away', year: 2001, lens: 'canon', genre: 'Animation', tmdbRating: 8.5 }),
    rec({ tmdbId: 106, title: 'City of God', year: 2002, lens: 'world-cinema', genre: 'Crime', tmdbRating: 8.6 }),
    rec({ tmdbId: 107, title: 'The Third Man', year: 1949, lens: 'older-era', genre: 'Mystery', tmdbRating: 8.1 }),
    rec({ tmdbId: 108, title: 'Whiplash', year: 2014, lens: 'thin-genre', genre: 'Drama', tmdbRating: 8.4 }),
    rec({ tmdbId: 109, title: 'Blade Runner 2049', year: 2017, lens: 'cerebral', genre: 'Science Fiction', tmdbRating: 8.0 }),
    rec({ tmdbId: 110, title: 'Amélie', year: 2001, lens: 'world-cinema', genre: 'Romance', tmdbRating: 8.3 }),
    rec({ tmdbId: 111, title: 'No Country for Old Men', year: 2007, lens: 'canon', genre: 'Thriller', tmdbRating: 8.1 }),
    rec({ tmdbId: 112, title: 'Chungking Express', year: 1994, lens: 'auteur', genre: 'Drama', tmdbRating: 7.9 }),
    rec({ tmdbId: 113, title: 'Oldboy', year: 2003, lens: 'thin-genre', genre: 'Thriller', tmdbRating: 8.4 }),
    rec({ tmdbId: 114, title: 'Seven Samurai', year: 1954, lens: 'older-era', genre: 'Action', tmdbRating: 8.6 }),
    rec({ tmdbId: 200, title: 'An Ignored Film', year: 2000, lens: 'serendipity', genre: 'Drama', tmdbRating: 6.0, ignored: true }),
  ],
};

// T315: missing-tv-seasons fixture — exercises the flattened row-group-header table
// (a show with 2+ missing seasons), the "notified" marker, and the separate Ignored panel.
const movieGaps = {
  generatedAt: NOW,
  collectionsChecked: 8,
  collectionExamples: { 'The Bourne Collection': { title: 'The Bourne Identity', year: 2002 } },
  gaps: [
    { collectionId: 1, collectionName: 'The Bourne Collection', tmdbId: 600, title: 'The Bourne Supremacy', year: 2004, tmdbRating: 7.2, notified: false, ignored: false },
    { collectionId: 1, collectionName: 'The Bourne Collection', tmdbId: 601, title: 'The Bourne Ultimatum', year: 2007, tmdbRating: 7.6, notified: true, ignored: false },
    { collectionId: 2, collectionName: LONG, tmdbId: 602, title: 'Some Sequel', year: 2018, tmdbRating: 6.1, notified: false, ignored: false },
    { collectionId: 3, collectionName: 'An Ignored Collection', tmdbId: 603, title: 'An Ignored Film', year: 2011, tmdbRating: 5.4, notified: false, ignored: true },
    // T455: a second ignored film in the same collection so the grouped Ignored panel's
    // per-group "Un-ignore all" button (shown only when a group has >1 item) is reachable.
    { collectionId: 3, collectionName: 'An Ignored Collection', tmdbId: 604, title: 'Another Ignored Film', year: 2013, tmdbRating: 5.0, notified: false, ignored: true },
  ],
};

const missingSeasons = {
  generatedAt: NOW,
  shows: [
    { tmdbId: 500, title: 'The Wire', year: 2002, season: 3, tmdbStatus: 'Ended', notified: false, ignored: false },
    { tmdbId: 500, title: 'The Wire', year: 2002, season: 4, tmdbStatus: 'Ended', notified: true, ignored: false },
    { tmdbId: 501, title: LONG, year: 2015, season: 2, tmdbStatus: 'Ended', notified: false, ignored: false },
    { tmdbId: 502, title: 'Fargo', year: 2014, season: 5, tmdbStatus: 'Returning Series', notified: false, ignored: false },
    { tmdbId: 503, title: 'An Ignored Show', year: 2010, season: 1, tmdbStatus: 'Ended', notified: false, ignored: true },
    // T455: a second ignored season of the same show so the grouped Ignored panel's
    // per-group "Un-ignore all" button (shown only when a group has >1 item) is reachable.
    { tmdbId: 503, title: 'An Ignored Show', year: 2010, season: 2, tmdbStatus: 'Ended', notified: false, ignored: true },
  ],
};

// T332: the real movie-recommendations 10-node fan-out (movie-snapshot → 8 rec-* branches →
// rec-merge → movie-recs-notify — see src/workflows/movies/movies.workflow.ts). The
// deterministic franchise-gap audit (franchise-gaps → movie-gaps-notify) moved to the separate
// `missing-movies` workflow (T468/T469) — this fixture models the RECS-ONLY DAG post-split, so
// it no longer includes those two jobs (see the `missingMoviesMembers` fixture below for those).
// Modeled as a RUN-scoped view (statusByJob + gates populated, mirroring a completed run) so
// visual-check can actually reproduce/confirm the run-view-only rec-auteur
// spacing bug (T332), which never showed up under the generic 3-node `workflowRun`/`gates`
// fixture the `workflow-run` PAGES entry uses.
const movieRecsMembers = [
  { job_name: 'movie-snapshot', depends_on: [] },
  { job_name: 'rec-random-1', depends_on: ['movie-snapshot'] },
  { job_name: 'rec-random-2', depends_on: ['movie-snapshot'] },
  { job_name: 'rec-random-3', depends_on: ['movie-snapshot'] },
  { job_name: 'rec-auteur', depends_on: ['movie-snapshot'] },
  { job_name: 'rec-canon', depends_on: ['movie-snapshot'] },
  { job_name: 'rec-thin-genre', depends_on: ['movie-snapshot'] },
  { job_name: 'rec-older-era', depends_on: ['movie-snapshot'] },
  { job_name: 'rec-world-cinema', depends_on: ['movie-snapshot'] },
  {
    job_name: 'rec-merge',
    // The merge reads the snapshot itself too (to drop films already owned), so that is a real edge.
    depends_on: ['movie-snapshot', 'rec-random-1', 'rec-random-2', 'rec-random-3', 'rec-auteur', 'rec-canon', 'rec-thin-genre', 'rec-older-era', 'rec-world-cinema'],
  },
  { job_name: 'movie-recs-notify', depends_on: ['rec-merge'] },
];
const movieRecsWorkflowRun = workflowRun({ id: 'movie-recs-run', workflow_name: 'movie-recommendations' });
const movieRecsStatusByJob = Object.fromEntries(movieRecsMembers.map((m) => [m.job_name, 'success']));
const movieRecsRunIdByJob = Object.fromEntries(movieRecsMembers.map((m) => [m.job_name, 'movie-recs-run']));
const movieRecsRunJobs = movieRecsMembers.map((m, i) => run({
  id: `movie-recs-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'movie-recs-run',
}));


// T333: bumped to ~15 active rows too (same shared .movie-gaps-scroll/.panel CSS as movieRecs).
const tvRecs = {
  generatedAt: NOW, pooled: 16,
  recommendations: [
    { tmdbId: 300, title: 'Severance', year: 2022, reason: 'Workplace thriller.', lens: 'cerebral', genre: 'Drama', tmdbRating: 8.7, notified: false, ignored: false },
    { tmdbId: 301, title: 'The Bear', year: 2022, reason: 'Intense kitchen drama.', lens: 'serendipity', genre: 'Drama', tmdbRating: 8.6, notified: true, ignored: false },
    { tmdbId: 302, title: 'Dark', year: 2017, reason: 'Mind-bending time travel.', lens: 'cerebral', genre: 'Science Fiction', tmdbRating: 8.8, notified: false, ignored: false },
    { tmdbId: 303, title: 'Fleabag', year: 2016, reason: 'Sharp dark comedy.', lens: 'auteur', genre: 'Comedy', tmdbRating: 8.5, notified: false, ignored: false },
    { tmdbId: 304, title: 'Chernobyl', year: 2019, reason: 'Gripping historical drama.', lens: 'canon', genre: 'Drama', tmdbRating: 8.7, notified: false, ignored: false },
    { tmdbId: 305, title: 'Better Call Saul', year: 2015, reason: 'A slow-burn character study.', lens: 'canon', genre: 'Crime', tmdbRating: 8.8, notified: false, ignored: false },
    { tmdbId: 306, title: 'Money Heist', year: 2017, reason: 'World cinema heist thriller.', lens: 'world-cinema', genre: 'Crime', tmdbRating: 8.2, notified: false, ignored: false },
    { tmdbId: 307, title: 'The Wire', year: 2002, reason: 'Older-era institutional drama.', lens: 'older-era', genre: 'Crime', tmdbRating: 9.0, notified: false, ignored: false },
    { tmdbId: 308, title: 'Atlanta', year: 2016, reason: 'Genre-bending surreal comedy.', lens: 'thin-genre', genre: 'Comedy', tmdbRating: 8.1, notified: false, ignored: false },
    { tmdbId: 309, title: 'Twin Peaks', year: 1990, reason: 'Auteur-driven mystery.', lens: 'auteur', genre: 'Mystery', tmdbRating: 8.4, notified: false, ignored: false },
    { tmdbId: 310, title: 'Broadchurch', year: 2013, reason: 'Serendipitous crime pick.', lens: 'serendipity', genre: 'Crime', tmdbRating: 8.2, notified: false, ignored: false },
    { tmdbId: 311, title: 'Babylon Berlin', year: 2017, reason: 'World cinema noir.', lens: 'world-cinema', genre: 'Crime', tmdbRating: 8.3, notified: false, ignored: false },
    { tmdbId: 312, title: 'Cheers', year: 1982, reason: 'Older-era sitcom classic.', lens: 'older-era', genre: 'Comedy', tmdbRating: 8.0, notified: false, ignored: false },
    { tmdbId: 313, title: 'Kaamelott', year: 2005, reason: 'Thin-genre comedy pick.', lens: 'thin-genre', genre: 'Comedy', tmdbRating: 8.0, notified: false, ignored: false },
    { tmdbId: 314, title: 'The Leftovers', year: 2014, reason: 'Canon prestige drama.', lens: 'canon', genre: 'Drama', tmdbRating: 8.4, notified: false, ignored: false },
    { tmdbId: 400, title: 'An Ignored Show', year: 2010, reason: 'Not interested.', lens: 'serendipity', genre: 'Comedy', tmdbRating: 5.5, notified: false, ignored: true },
  ],
};

// T473: fixture sets for every remaining shipped workflow that previously had NO
// /stage-io fixture + PAGES run-detail coverage — missing-tv-seasons, workouts-sync,
// listening-digest, projects-sync, plex-space-saver, plex-language-fix, plex-profiles,
// vercel-daily-redeploy, tv-recommendations, perfumes. Each mirrors the SAME 3-part shape
// as the existing sets above (`<name>Members` / `<name>WorkflowRun` + run jobs /
// `<name>StageIo` + an `Overall` variant), matching each workflow's REAL DAG from its
// `*.workflow.ts` manifest.

// missing-tv-seasons — plex-tv-snapshot -> tmdb-season-check -> plex-seasons-notify (linear).
const missingTvSeasonsMembers = [
  { job_name: 'plex-tv-snapshot', depends_on: [] },
  { job_name: 'tmdb-season-check', depends_on: ['plex-tv-snapshot'] },
  { job_name: 'plex-seasons-notify', depends_on: ['tmdb-season-check'] },
];
const missingTvSeasonsWorkflowRun = workflowRun({ id: 'missing-tv-seasons-run', workflow_name: 'missing-tv-seasons' });
const missingTvSeasonsRunJobs = missingTvSeasonsMembers.map((m, i) => run({
  id: `missing-tv-seasons-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'missing-tv-seasons-run',
}));
const missingTvSeasonsPorts = auditPortsFixtures({
  dir: 'missing-tv-seasons', stages: ['plex-tv-snapshot', 'tmdb-season-check', 'plex-seasons-notify'],
  snapshot: {
    artifactKey: 'plex-tv-snapshot', description: 'The Plex TV library as of this run: every show with its TMDB id and the highest season owned.',
    summary: '650 show(s), 650 with a TMDB id', itemCount: 650, bytes: 96_000,
    sample: [{ id: '1399', title: 'Game of Thrones (2011)', fields: [{ label: 'Owned up to', value: 'S7' }, { label: 'TMDB', value: '1399' }] }],
  },
  found: {
    port: 'missing', file: 'missing-seasons.json', artifactKey: 'tmdb-missing-seasons',
    description: 'Shows with at least one complete season the owner is missing, plus the shows that could not be checked.',
    summary: '12 show(s) with a complete missing season', itemCount: 12, bytes: 3_400,
    sample: [{ id: '1399', title: 'Game of Thrones (2011)', fields: [{ label: 'Missing', value: 'S8' }, { label: 'Owned up to', value: 'S7' }, { label: 'Status', value: 'Ended' }] }],
  },
  report: { file: 'missing-seasons.md', artifactKey: 'missing-seasons-report', description: 'The markdown report of every complete season currently missing, marking the newly found ones.', bytes: 2_100 },
  digest: {
    artifactKey: 'missing-seasons-digest', description: 'What this run announced: how many missing seasons were new, and how many had been announced before.',
    summary: '1 announced, 14 already announced', inline: { announced: 1, alreadyAnnounced: 14, titles: ['Game of Thrones S8'] }, bytes: 70,
  },
  announced: [{ itemKey: '1399::S8', title: 'Game of Thrones S8' }],
});
const missingTvSeasonsStageIo = missingTvSeasonsPorts.stageIo;
const missingTvSeasonsStageIoOverall = missingTvSeasonsPorts.overall;

// workouts-sync — hevy-sync -> workouts-progress (linear, 2 stages).
const workoutsSyncMembers = [
  { job_name: 'hevy-sync', depends_on: [] },
  { job_name: 'workouts-progress', depends_on: ['hevy-sync'] },
];
const workoutsSyncWorkflowRun = workflowRun({ id: 'workouts-sync-run', workflow_name: 'workouts-sync' });
const workoutsSyncRunJobs = workoutsSyncMembers.map((m, i) => run({
  id: `workouts-sync-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'workouts-sync-run',
}));
const workoutsSyncPorts = twoStagePortsFixtures({
  stages: ['hevy-sync', 'workouts-progress'],
  firstArtifact: {
    port: 'history', artifactKey: 'workouts-history', description: 'The full history of Hevy workouts synced so far.',
    summary: '312 workout(s)', itemCount: 312, bytes: 1_840_000, preview: { path: 'workouts-sync/data/out/workouts-history.json', format: 'json' },
    sample: [{ id: 'abc123', title: 'Push day', fields: [{ label: 'Date', value: '2026-06-15' }, { label: 'Exercises', value: '6' }] }],
  },
  firstRows: [{ itemKey: 'abc123', title: 'Push day', fields: [{ label: 'Date', value: '2026-06-15' }, { label: 'Exercises', value: '6' }, { label: 'Sets', value: '21' }] }],
  secondArtifacts: [
    { port: 'data', artifactKey: 'workouts-progress-data', description: 'The computed comparison behind the report: each exercise this month against six months ago.', summary: '24 exercise(s), 2026-06 against 2025-12', itemCount: 24, bytes: 9_300, preview: { path: 'workouts-sync/data/out/progress-data.json', format: 'json' } },
    { port: 'reports', artifactKey: 'workouts-progress-reports', storage: 'dir', format: 'markdown', description: 'The monthly progress reports: workouts-progress-<YYYY-MM>.md.', summary: '5 report(s)', itemCount: 5 },
  ],
  secondRows: [{ itemKey: '2026-06', title: 'Workouts progress — 2026-06', preview: { path: 'workouts-sync/data/out/workouts-progress-2026-06.md', format: 'markdown' } }],
});
const workoutsSyncStageIo = workoutsSyncPorts.stageIo;
const workoutsSyncStageIoOverall = workoutsSyncPorts.overall;

// listening-digest — single stage: lastfm-digest.
const listeningDigestMembers = [{ job_name: 'lastfm-digest', depends_on: [] }];
const listeningDigestWorkflowRun = workflowRun({ id: 'listening-digest-run', workflow_name: 'listening-digest' });
const listeningDigestRunJobs = listeningDigestMembers.map((m, i) => run({
  id: `listening-digest-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'listening-digest-run',
}));
// A ports stage: the folder of digests is its declared output, and the two digests
// a run writes are its items (each previews its markdown file).
const listeningDigestRows = [
  { id: 'lastfm-digest:2026-06', jobName: 'lastfm-digest', itemKey: '2026-06', status: 'success', title: 'Listening digest — June 2026', fields: [], preview: { path: 'listening-digest/data/out/listening-digest-2026-06.md', format: 'markdown' } },
  { id: 'lastfm-digest:2026-06-3month', jobName: 'lastfm-digest', itemKey: '2026-06-3month', status: 'success', title: 'Listening digest (trailing 3 months) — June 2026', fields: [], preview: { path: 'listening-digest/data/out/listening-digest-2026-06-3month.md', format: 'markdown' } },
];
const listeningDigestIo = singleOutputIo('lastfm-digest', [portsArtifact({
  job: 'lastfm-digest', port: 'digests', artifactKey: 'listening-digests', storage: 'dir', format: 'markdown',
  description: 'The monthly listening digests: listening-digest-<YYYY-MM>.md and its trailing three month companion.',
  summary: '14 digest(s)', itemCount: 14,
  sample: [{ id: 'listening-digest-2026-06.md', title: '2026-06', preview: { path: 'listening-digest/data/out/listening-digest-2026-06.md', format: 'markdown' } }],
})], listeningDigestRows);
const listeningDigestStageIo = listeningDigestIo.stage;
const listeningDigestStageIoOverall = listeningDigestIo.overall;

// projects-sync — github-sync -> project-summarize (linear, 2 stages).
const projectsSyncMembers = [
  { job_name: 'github-sync', depends_on: [] },
  { job_name: 'project-summarize', depends_on: ['github-sync'] },
];
const projectsSyncWorkflowRun = workflowRun({ id: 'projects-sync-run', workflow_name: 'projects-sync' });
const projectsSyncRunJobs = projectsSyncMembers.map((m, i) => run({
  id: `projects-sync-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'projects-sync-run',
}));
const projectsSyncPorts = twoStagePortsFixtures({
  stages: ['github-sync', 'project-summarize'],
  firstArtifact: {
    port: 'catalog', artifactKey: 'projects-catalog', description: 'The catalog of the owner\'s GitHub repos: one entry per repo, most recently pushed first.',
    summary: '18 repo(s)', itemCount: 18, bytes: 7_900, preview: { path: 'projects-sync/data/out/projects.json', format: 'json' },
    sample: [{ id: '123456', title: 'owner/local-jobs', subtitle: 'A self-hosted job runner', fields: [{ label: 'Language', value: 'TypeScript' }, { label: 'Pushed', value: '2026-06-21' }] }],
  },
  firstRows: [{ itemKey: '123456', title: 'owner/local-jobs', subtitle: 'A self-hosted job runner', fields: [{ label: 'Language', value: 'TypeScript' }, { label: 'Pushed', value: '2026-06-21' }] }],
  secondArtifacts: [
    { port: 'summaries', artifactKey: 'project-summaries', storage: 'dir', format: 'markdown', description: 'The markdown profile of each repo: <repo>.md.', summary: '18 profile(s)', itemCount: 18 },
  ],
  secondRows: [{ itemKey: '123456', title: 'owner/local-jobs', fields: [{ label: 'Pushed', value: '2026-06-21' }], preview: { path: 'projects-sync/data/out/local-jobs.md', format: 'markdown' } }],
});
const projectsSyncStageIo = projectsSyncPorts.stageIo;
const projectsSyncStageIoOverall = projectsSyncPorts.overall;

// plex-space-saver — single stage: plex-space-saver-scan.
const plexSpaceSaverMembers = [{ job_name: 'plex-space-saver-scan', depends_on: [] }];
const plexSpaceSaverWorkflowRun = workflowRun({ id: 'plex-space-saver-run', workflow_name: 'plex-space-saver' });
const plexSpaceSaverRunJobs = plexSpaceSaverMembers.map((m, i) => run({
  id: `plex-space-saver-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'plex-space-saver-run',
}));
// A ports stage with one declared output and no ledger: the breakdown file, whose
// declared format ('size-table') picks the dashboard's bar-chart viewer.
const plexSpaceSaverArtifact = portsArtifact({
  job: 'plex-space-saver-scan', port: 'breakdown', artifactKey: 'plex-size-breakdown', format: 'size-table',
  description: 'Where the Plex library\'s disk space goes: one row per movie and per TV show, biggest first.',
  summary: '812 movie(s) + 214 show(s), 17.5 TB', itemCount: 1026, bytes: 184_000,
  preview: { path: 'plex-space-saver/data/out/size-breakdown.json', format: 'size-table' },
  sample: [{ id: 'movie:1', title: 'A Very Long Movie Title That Might Wrap On Narrow Screens (2019)', fields: [{ label: 'Size', value: '40.0 GB' }, { label: 'Kind', value: 'movie' }] }],
});
const plexSpaceSaverIo = singleOutputIo('plex-space-saver-scan', [plexSpaceSaverArtifact]);
const plexSpaceSaverStageIo = plexSpaceSaverIo.stage;
const plexSpaceSaverStageIoOverall = plexSpaceSaverIo.overall;
// T617: the GET .../output(-items) response body for `plexSpaceSaverOutput` — a real
// SizeBreakdownFile JSON string (biggest-first) so the OutputRenderer's 'size-table'
// bar-chart renderer has real varied-`bytes` rows to paint, in both the workflow
// Output section and the run-scoped Stage I/O popover.
const plexSpaceSaverOutputFixture = {
  found: true, job: 'plex-space-saver-scan', key: '2026-W25', format: 'size-table',
  file: '/abs/data/out/size-breakdown-2026-W25.json', bytes: 512, truncated: false,
  content: JSON.stringify({
    items: [
      { title: 'A Very Long Movie Title That Might Wrap On Narrow Screens', year: 2019, type: 'movie', ratingKey: '1', bytes: 42_949_672_960, human: '40.0 GB' },
      { title: 'A Great TV Show', year: 2016, type: 'show', ratingKey: '2', bytes: 32_212_254_720, human: '30.0 GB' },
      { title: 'Another Movie', year: 2021, type: 'movie', ratingKey: '3', bytes: 12_884_901_888, human: '12.0 GB' },
      { title: 'A Small Documentary', year: 2011, type: 'movie', ratingKey: '4', bytes: 1_073_741_824, human: '1.0 GB' },
    ],
  }),
};

// plex-language-fix — discover -> resolve -> evaluate (fan-in on discover+resolve) -> apply.
const plexLanguageFixMembers = [
  { job_name: 'plex-language-discover', depends_on: [] },
  { job_name: 'plex-language-resolve', depends_on: ['plex-language-discover'] },
  { job_name: 'plex-language-evaluate', depends_on: ['plex-language-discover', 'plex-language-resolve'] },
  // apply reads the discover rows too, so it depends on discover directly.
  { job_name: 'plex-language-apply', depends_on: ['plex-language-discover', 'plex-language-evaluate'] },
];
// On ports, with the data in the ledger. The gates include two same-row edges that skip a
// column (discover -> evaluate, discover -> apply): the DAG routes each around the nodes in
// between (T592's padlock-collision case, now drawn as a detour).
const plexLanguageFixPorts = ledgerPipelineFixtures([
  { job: 'plex-language-discover', port: 'files', key: 'plex-language-discover', description: 'Every media file (movie or episode) known across the configured Plex sections, one ledger row each.', summary: '55643 file(s)', count: 55643,
    rows: [{ itemKey: '12345::part678', title: 'Amélie', fields: [{ label: 'Kind', value: 'movie' }, { label: 'TMDB', value: '194' }] }] },
  { job: 'plex-language-resolve', port: 'languages', key: 'plex-language-resolve', description: 'Each file\'s true original language, resolved through TMDB, one ledger row per file.', summary: '55643 file(s) resolved', count: 55643, deps: ['plex-language-discover'],
    rows: [{ itemKey: '12345::part678', title: 'Amélie', fields: [{ label: 'Original language', value: 'fr' }] }] },
  { job: 'plex-language-evaluate', port: 'decisions', key: 'plex-language-evaluate', description: 'Each file\'s decision: change its default audio and subtitle tracks, or leave it. One ledger row per file.', summary: '55643 file(s) evaluated, 2021 to change', count: 55643, deps: ['plex-language-discover', 'plex-language-resolve'],
    rows: [{ itemKey: '12345::part678', title: 'Amélie', fields: [{ label: 'Decision', value: 'change' }] }] },
  { job: 'plex-language-apply', port: 'applied', key: 'plex-language-applied', description: 'Every file whose default tracks have been changed in Plex, one ledger row each. A file is applied once, ever.', summary: '2021 file(s) applied', count: 2021, deps: ['plex-language-discover', 'plex-language-evaluate'],
    rows: [{ itemKey: '12345::part678', title: 'Amélie — applied', preview: { path: 'plex-language-fix/data/out/applied-log.json', format: 'json' } }] },
]);
const plexLanguageFixGates = plexLanguageFixPorts.gates;
const plexLanguageFixWorkflowRun = workflowRun({ id: 'plex-language-fix-run', workflow_name: 'plex-language-fix' });
const plexLanguageFixRunJobs = plexLanguageFixMembers.map((m, i) => run({
  id: `plex-language-fix-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'plex-language-fix-run',
}));
const plexLanguageFixStageIo = plexLanguageFixPorts.stageIo;
const plexLanguageFixStageIoOverall = plexLanguageFixPorts.overall;

// plex-profiles — single stage: plex-profiles-build.
const plexProfilesMembers = [{ job_name: 'plex-profiles-build', depends_on: [] }];
const plexProfilesWorkflowRun = workflowRun({ id: 'plex-profiles-run', workflow_name: 'plex-profiles' });
const plexProfilesRunJobs = plexProfilesMembers.map((m, i) => run({
  id: `plex-profiles-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'plex-profiles-run',
}));
// A ports stage with two cumulative folders (movie and show profiles) and the profile it rewrote this run.
const plexProfilesIo = singleOutputIo('plex-profiles-build', [
  portsArtifact({ job: 'plex-profiles-build', port: 'movies', artifactKey: 'plex-movie-profiles', storage: 'dir', format: 'markdown', description: 'One markdown profile per movie in the Plex library.', summary: '1658 profile(s)', itemCount: 1658 }),
  portsArtifact({ job: 'plex-profiles-build', port: 'shows', artifactKey: 'plex-show-profiles', storage: 'dir', format: 'markdown', description: 'One markdown profile per TV show in the Plex library.', summary: '649 profile(s)', itemCount: 649 }),
], [
  { id: 'plex-profiles-build:show:1399', jobName: 'plex-profiles-build', itemKey: 'show:1399', status: 'success', title: 'Game of Thrones', fields: [], preview: { path: 'plex-profiles/data/out/shows/1399-game-of-thrones.md', format: 'markdown' } },
]);
const plexProfilesStageIo = plexProfilesIo.stage;
const plexProfilesStageIoOverall = plexProfilesIo.overall;

// vercel-daily-redeploy — single stage: vercel-redeploy.
const vercelDailyRedeployMembers = [{ job_name: 'vercel-redeploy', depends_on: [] }];
const vercelDailyRedeployWorkflowRun = workflowRun({ id: 'vercel-daily-redeploy-run', workflow_name: 'vercel-daily-redeploy' });
const vercelDailyRedeployRunJobs = vercelDailyRedeployMembers.map((m, i) => run({
  id: `vercel-daily-redeploy-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'vercel-daily-redeploy-run',
}));
// A ports stage with one INLINE output (how the deploy went) and its per-day deploy-log row.
const vercelDailyRedeployIo = singleOutputIo('vercel-redeploy', [portsArtifact({
  job: 'vercel-redeploy', port: 'result', artifactKey: 'vercel-redeploy-result', storage: 'inline',
  description: 'How the deploy went: deployed (with its URL), skipped (and why), or failed (and why).',
  summary: 'deployed · https://ryankrol-co-uk.vercel.app', bytes: 132,
  inline: { generatedAt: '2026-07-10T23:01:12.000Z', key: '2026-07-10', outcome: 'deployed', deployUrl: 'https://ryankrol-co-uk.vercel.app' },
})], [
  { id: 'vercel-redeploy:2026-07-10', jobName: 'vercel-redeploy', itemKey: '2026-07-10', status: 'success', title: 'Redeploy deployed — 2026-07-10', fields: [], preview: { path: 'vercel-daily-redeploy/data/out/vercel-redeploy-2026-07-10.json', format: 'json' } },
]);
const vercelDailyRedeployStageIo = vercelDailyRedeployIo.stage;
const vercelDailyRedeployStageIoOverall = vercelDailyRedeployIo.overall;

// tv-recommendations — tv-snapshot -> 8 rec branches -> tv-rec-merge -> tv-recs-notify.
const tvRecommendationsMembers = [
  { job_name: 'tv-snapshot', depends_on: [] },
  { job_name: 'tv-rec-random-1', depends_on: ['tv-snapshot'] },
  { job_name: 'tv-rec-random-2', depends_on: ['tv-snapshot'] },
  { job_name: 'tv-rec-random-3', depends_on: ['tv-snapshot'] },
  { job_name: 'tv-rec-creator', depends_on: ['tv-snapshot'] },
  { job_name: 'tv-rec-canon', depends_on: ['tv-snapshot'] },
  { job_name: 'tv-rec-thin-genre', depends_on: ['tv-snapshot'] },
  { job_name: 'tv-rec-older-era', depends_on: ['tv-snapshot'] },
  { job_name: 'tv-rec-world', depends_on: ['tv-snapshot'] },
  {
    job_name: 'tv-rec-merge',
    // The merge also reads the snapshot directly (to verify against the owned
    // library), so that is a real edge, not a hidden read two stages back.
    depends_on: ['tv-snapshot', 'tv-rec-random-1', 'tv-rec-random-2', 'tv-rec-random-3', 'tv-rec-creator', 'tv-rec-canon', 'tv-rec-thin-genre', 'tv-rec-older-era', 'tv-rec-world'],
  },
  { job_name: 'tv-recs-notify', depends_on: ['tv-rec-merge'] },
];
const tvRecommendationsWorkflowRun = workflowRun({ id: 'tv-recommendations-run', workflow_name: 'tv-recommendations' });
const tvRecommendationsRunJobs = tvRecommendationsMembers.map((m, i) => run({
  id: `tv-recommendations-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'tv-recommendations-run',
}));
// Both recommenders are PORTS workflows: the run page is derived from what the engine
// recorded. Each stage shows the ARTIFACTS it was handed / committed (cards) and the
// ledger ITEMS it changed. No stage writes a row just to be visible. The two workflows
// share their stages (src/core/recommender/stages.ts), so one generator builds both.
function recommenderPortsFixtures({ prefix, noun, dir, snapshotJob, branches, mergeJob, notifyJob, ledgerJob, librarySample, total, suggestion, announced }) {
  const snapshot = portsArtifact({
    job: snapshotJob, port: 'snapshot', artifactKey: `${prefix}-snapshot`,
    description: `The Plex library snapshot: every one of the owned ${noun}, each with its TMDB id and taste metadata.`,
    summary: `${total} ${noun}, ${total - 38} with a TMDB id`, itemCount: total, bytes: 412_000,
    preview: { path: `${dir}/data/out/snapshot.json`, format: 'json' }, sample: librarySample,
  });
  const taste = portsArtifact({
    job: snapshotJob, port: 'taste', artifactKey: `${prefix}-taste-profile`,
    description: `What the owned ${noun} lean towards: genres, people, decades and countries, counted across the whole library.`,
    summary: '18 genres, 40 people', bytes: 9_800, preview: { path: `${dir}/data/out/taste-profile.json`, format: 'json' },
  });
  const branchArtifact = Object.fromEntries(branches.map((branch, i) => [branch, portsArtifact({
    job: branch, port: 'suggestions', artifactKey: `${prefix}-branch-suggestions`,
    description: 'Raw suggestions from one recommender branch, before verification.',
    summary: `${9 - (i % 4)} suggestions`, itemCount: 9 - (i % 4), bytes: 2_400,
    preview: { path: `${dir}/data/out/recs/${branch}.json`, format: 'json' },
    sample: [{ id: '0', ...suggestion, fields: [{ label: 'Lens', value: branch.replace(/^(tv-)?rec-/, '') }] }],
  })]));
  const recs = portsArtifact({
    job: mergeJob, port: 'recommendations', artifactKey: `${prefix}-recommendations`,
    description: 'The TMDB-verified, deduped, balanced recommendation list.',
    summary: '15 recommendations (pooled 65)', itemCount: 15, bytes: 6_100,
    preview: { path: `${dir}/data/out/recommendations.json`, format: 'json' },
    sample: [{ id: announced[0].itemKey, title: announced[0].title, fields: announced[0].fields }],
  });
  const report = portsArtifact({
    job: notifyJob, port: 'report', artifactKey: `${prefix}-recs-report`, storage: 'file', format: 'markdown',
    description: 'The markdown report of the current recommendations.', bytes: 3_900,
    preview: { path: `${dir}/data/out/reports/${prefix}-recommendations.md`, format: 'markdown' },
  });
  const digest = portsArtifact({
    job: notifyJob, port: 'digest', artifactKey: `${prefix}-recs-digest`, storage: 'inline',
    description: 'What this run announced: how many recommendations were new, and how many were already announced or dismissed.',
    inline: { announced: announced.length, alreadyAnnounced: 15 - announced.length, ignored: 0 }, bytes: 48,
  });
  const rows = announced.map((a) => ({
    id: `${ledgerJob}:${a.itemKey}`, jobName: ledgerJob, status: 'success', ...a,
    preview: { path: report.preview.path, format: 'markdown' },
  }));
  const stageIo = {
    [snapshotJob]: portsIo(snapshotJob, { outputArtifacts: [snapshot, taste] }),
    ...Object.fromEntries(branches.map((branch) => [branch, portsIo(branch, {
      predecessorJobs: [snapshotJob],
      // A branch reports the 40-title sample its prompt actually used, not the whole library.
      inputArtifacts: [asInput(snapshot, 'snapshot', { used: { total: 40, items: librarySample } }), asInput(taste, 'taste')],
      outputArtifacts: [branchArtifact[branch]],
    })])),
    [mergeJob]: portsIo(mergeJob, {
      predecessorJobs: [snapshotJob, ...branches],
      // The fan-in: one input per branch, plus the snapshot and taste profile it verifies against.
      inputArtifacts: [asInput(snapshot, 'snapshot'), asInput(taste, 'taste'), ...branches.map((b) => asInput(branchArtifact[b], 'branches'))],
      outputArtifacts: [recs],
    }),
    [notifyJob]: portsIo(notifyJob, {
      predecessorJobs: [mergeJob],
      inputArtifacts: [asInput(recs, 'recommendations')],
      outputArtifacts: [report, digest], outputs: rows, outputTotal: rows.length,
    }),
  };
  const overall = portsIo('__overall__', {
    predecessorJobs: [snapshotJob], outputJobs: [notifyJob],
    inputArtifacts: [snapshot, taste],
    outputArtifacts: [report, digest], outputs: rows, outputTotal: rows.length,
  });
  const gates = [
    ...branches.flatMap((b) => [
      { key: `${prefix}-snapshot`, producer: snapshotJob, consumer: b, state: 'passed' },
      { key: `${prefix}-taste-profile`, producer: snapshotJob, consumer: b, state: 'passed' },
      { key: `${prefix}-branch-suggestions`, producer: b, consumer: mergeJob, state: 'passed' },
    ]),
    { key: `${prefix}-snapshot`, producer: snapshotJob, consumer: mergeJob, state: 'passed' },
    { key: `${prefix}-taste-profile`, producer: snapshotJob, consumer: mergeJob, state: 'passed' },
    { key: `${prefix}-recommendations`, producer: mergeJob, consumer: notifyJob, state: 'passed' },
  ];
  return { stageIo, overall, gates };
}
const TV_BRANCHES = ['tv-rec-random-1', 'tv-rec-random-2', 'tv-rec-random-3', 'tv-rec-creator', 'tv-rec-canon', 'tv-rec-thin-genre', 'tv-rec-older-era', 'tv-rec-world'];
const tvPorts = recommenderPortsFixtures({
  prefix: 'tv', noun: 'shows', dir: 'tv-recs', snapshotJob: 'tv-snapshot', branches: TV_BRANCHES,
  mergeJob: 'tv-rec-merge', notifyJob: 'tv-recs-notify', ledgerJob: 'tv-recs', total: 650,
  librarySample: [
    { id: '100088', title: 'The Last of Us', fields: [{ label: 'Year', value: '2023' }] },
    { id: '102540', title: 'The Shrink Next Door', fields: [{ label: 'Year', value: '2021' }] },
    { id: '102619', title: 'I May Destroy You', fields: [{ label: 'Year', value: '2020' }] },
  ],
  suggestion: { title: 'Severance (2022)', subtitle: 'A workplace thriller that matches your sci-fi lean.' },
  announced: [
    { itemKey: '111110', title: 'ONE PIECE (2023)', fields: [{ label: 'Lens', value: 'serendipity' }, { label: 'Genre', value: 'Action & Adventure' }, { label: 'TMDB', value: '8.1' }] },
    { itemKey: '1678', title: 'The Golden Girls (1985)', fields: [{ label: 'Lens', value: 'older-era' }, { label: 'Genre', value: 'Comedy' }, { label: 'TMDB', value: '8.0' }] },
  ],
});
const tvRecommendationsStageIo = tvPorts.stageIo;
const tvRecommendationsStageIoOverall = tvPorts.overall;
const tvRecommendationsGates = tvPorts.gates;
const moviePorts = recommenderPortsFixtures({
  prefix: 'movie', noun: 'movies', dir: 'movies', snapshotJob: 'movie-snapshot',
  branches: movieRecsMembers.map((m) => m.job_name).filter((n) => n.startsWith('rec-') && n !== 'rec-merge'),
  mergeJob: 'rec-merge', notifyJob: 'movie-recs-notify', ledgerJob: 'movie-recs', total: 812,
  librarySample: [
    { id: '603', title: 'The Matrix', fields: [{ label: 'Year', value: '1999' }] },
    { id: '680', title: 'Pulp Fiction', fields: [{ label: 'Year', value: '1994' }] },
    { id: '129', title: 'Spirited Away', fields: [{ label: 'Year', value: '2001' }] },
  ],
  suggestion: { title: 'Stalker (1979)', subtitle: 'Slow, strange science fiction, close to the Tarkovsky you already own.' },
  announced: [
    { itemKey: '1398', title: 'Stalker (1979)', fields: [{ label: 'Lens', value: 'auteur' }, { label: 'Genre', value: 'Science Fiction' }, { label: 'TMDB', value: '8.1' }] },
    { itemKey: '11216', title: 'Cinema Paradiso (1988)', fields: [{ label: 'Lens', value: 'world-cinema' }, { label: 'Genre', value: 'Drama' }, { label: 'TMDB', value: '8.4' }] },
  ],
});
const movieRecsStageIo = moviePorts.stageIo;
const movieRecsStageIoOverall = moviePorts.overall;
const movieRecsGates = moviePorts.gates;

// missing-movies — the gaps-only workflow (after T468 split movie-recommendations into recs-only + gaps-only).
// Simple linear, on ports: plex-movie-snapshot -> franchise-gaps -> movie-gaps-notify (T469).
const missingMoviesMembers = [
  { job_name: 'plex-movie-snapshot', depends_on: [] },
  { job_name: 'franchise-gaps', depends_on: ['plex-movie-snapshot'] },
  { job_name: 'movie-gaps-notify', depends_on: ['franchise-gaps'] },
];
const missingMoviesWorkflowRun = workflowRun({ id: 'missing-movies-run', workflow_name: 'missing-movies' });
const missingMoviesRunJobs = missingMoviesMembers.map((m, i) => run({
  id: `missing-movies-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'missing-movies-run',
}));
const missingMoviesPorts = auditPortsFixtures({
  dir: 'missing-movies', stages: ['plex-movie-snapshot', 'franchise-gaps', 'movie-gaps-notify'],
  snapshot: {
    artifactKey: 'plex-movie-snapshot', description: 'The Plex movie library as of this run: every movie with its TMDB id.',
    summary: '812 movie(s), 808 with a TMDB id', itemCount: 812, bytes: 412_000,
    sample: [{ id: '2501', title: 'The Bourne Identity (2002)', fields: [{ label: 'TMDB', value: '2501' }] }],
  },
  found: {
    port: 'gaps', file: 'franchise-gaps.json', artifactKey: 'franchise-gaps',
    description: 'Every released film missing from a collection the owner has part of. May be empty when nothing is missing.',
    summary: '37 gap(s) across 140 collection(s) checked', itemCount: 37, bytes: 9_200,
    sample: [{ id: '2502', title: 'The Bourne Supremacy (2004)', subtitle: 'The Bourne Collection', fields: [{ label: 'TMDB', value: '7.3' }] }],
  },
  report: { file: 'franchise-gaps.md', artifactKey: 'franchise-gaps-report', description: 'The markdown report of the current franchise gaps, grouped by collection.', bytes: 4_800 },
  digest: {
    artifactKey: 'franchise-gaps-digest', description: 'What this run announced: how many gaps were new, and how many were already announced or dismissed.',
    summary: '1 announced, 35 already announced, 1 dismissed', inline: { announced: 1, alreadyAnnounced: 35, ignored: 1, titles: ['The Bourne Collection: The Bourne Supremacy'] }, bytes: 120,
  },
  announced: [{ itemKey: '2502', title: 'The Bourne Collection: The Bourne Supremacy', fields: [{ label: 'Year', value: '2004' }, { label: 'TMDB', value: '7.3' }] }],
});
const missingMoviesStageIo = missingMoviesPorts.stageIo;
const missingMoviesStageIoOverall = missingMoviesPorts.overall;

// perfumes — find-url -> fetch -> parse -> build, with build also fed by find-url (the URLs).
// A PORTS item pipeline: every artifact is a cumulative store, so a card shows the whole
// store (46 URLs, 45 pages) and whether this run added to it, while the ITEM rows show only
// what this run did (2 perfumes: one went all the way through, one failed at fetch).
const perfumesMembers = [
  { job_name: 'perfumes-find-url', depends_on: [] },
  { job_name: 'perfumes-fetch', depends_on: ['perfumes-find-url'] },
  { job_name: 'perfumes-parse', depends_on: ['perfumes-fetch'] },
  { job_name: 'perfumes-build', depends_on: ['perfumes-find-url', 'perfumes-parse'] },
];
const perfumesWorkflowRun = workflowRun({ id: 'perfumes-run', workflow_name: 'perfumes' });
const perfumesRunJobs = perfumesMembers.map((m, i) => run({
  id: `perfumes-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'perfumes-run',
}));
const perfumeRow = (job, key, title, fields, extra = {}) => ({ id: `${job}:${key}`, jobName: job, itemKey: key, status: 'success', title, fields, ...extra });
const AVENTUS = 'aventus__creed__edp';
const HALFETI = 'halfeti__penhaligons__edp';
const perfumesUrls = portsArtifact({
  job: 'perfumes-find-url', port: 'urls', artifactKey: 'fragrantica-urls',
  description: 'Each perfume id mapped to its Fragrantica page URL. Grows as perfumes are resolved.',
  summary: '46 URL(s)', itemCount: 46, bytes: 5_200, preview: { path: 'perfumes/data/out/fragrantica-urls.json', format: 'json' },
  sample: [{ id: AVENTUS, title: AVENTUS, fields: [{ label: 'URL', value: 'https://www.fragrantica.com/perfume/Creed/Aventus-9828.html' }] }],
});
const perfumesPages = portsArtifact({
  job: 'perfumes-fetch', port: 'pages', artifactKey: 'fragrantica-pages', storage: 'dir', format: 'text',
  description: 'The captured Fragrantica page of each perfume: <id>.txt (the text) and <id>.html (the raw page).',
  summary: '45 captured page(s)', itemCount: 45, bytes: null,
  sample: [{ id: AVENTUS, title: AVENTUS, preview: { path: `perfumes/data/out/pages/${AVENTUS}.txt`, format: 'text' } }],
});
const perfumesData = portsArtifact({
  job: 'perfumes-parse', port: 'data', artifactKey: 'fragrantica-data', storage: 'dir',
  description: 'Each captured page parsed into a structured record: <id>.json with the name, notes, accords and community votes.',
  summary: '45 parsed perfume(s)', itemCount: 45, bytes: null,
  sample: [{ id: AVENTUS, title: AVENTUS, preview: { path: `perfumes/data/out/fragrantica/${AVENTUS}.json`, format: 'json' } }],
});
const perfumesProfiles = portsArtifact({
  job: 'perfumes-build', port: 'profiles', artifactKey: 'perfume-profiles', storage: 'dir', format: 'markdown',
  description: 'The finished markdown profile of each perfume: <id>.md.',
  summary: '45 profile(s)', itemCount: 45, bytes: null,
  sample: [{ id: AVENTUS, title: AVENTUS, preview: { path: `perfumes/data/out/markdown/${AVENTUS}.md`, format: 'markdown' } }],
});
const perfumesFound = [
  perfumeRow('perfumes-find-url', AVENTUS, 'Aventus — Creed', [{ label: 'URL', value: 'https://www.fragrantica.com/perfume/Creed/Aventus-9828.html' }, { label: 'Source', value: 'web search' }]),
  perfumeRow('perfumes-find-url', HALFETI, 'Halfeti — Penhaligon\'s', [{ label: 'URL', value: LONG_URL }, { label: 'Source', value: 'PerfumeRatings' }]),
];
const perfumesFetched = [
  perfumeRow('perfumes-fetch', AVENTUS, 'Aventus — Creed', [{ label: 'Captured', value: '18432 chars' }], { preview: { path: `perfumes/data/out/pages/${AVENTUS}.txt`, format: 'text' } }),
  // A failed item keeps what came back, so the reason is on the page and not only in the log.
  perfumeRow('perfumes-fetch', HALFETI, 'Halfeti — Penhaligon\'s', [{ label: 'HTTP', value: '403' }, { label: 'Page title', value: 'Just a moment...' }, { label: 'Error', value: 'cloudflare challenge / bot block' }], { status: 'failed' }),
];
const perfumesParsed = [
  perfumeRow('perfumes-parse', AVENTUS, 'Aventus — Creed', [{ label: 'Accords', value: '8' }, { label: 'Notes', value: '13' }, { label: 'Rating', value: '4.31' }], { preview: { path: `perfumes/data/out/fragrantica/${AVENTUS}.json`, format: 'json' } }),
];
const perfumesBuilt = [
  perfumeRow('perfumes-build', AVENTUS, 'Aventus — Creed', [{ label: 'Fragrantica votes', value: '21804' }], { preview: { path: `perfumes/data/out/markdown/${AVENTUS}.md`, format: 'markdown' } }),
];
const withRows = (over, inputs, outputs) => ({ ...over, inputs, outputs, inputTotal: inputs.length, outputTotal: outputs.length });
const perfumesStageIo = {
  'perfumes-find-url': portsIo('perfumes-find-url', withRows({ outputArtifacts: [perfumesUrls], outputsUnchanged: 44 }, [], perfumesFound)),
  'perfumes-fetch': portsIo('perfumes-fetch', withRows({
    predecessorJobs: ['perfumes-find-url'], inputArtifacts: [asInput(perfumesUrls, 'urls')], outputArtifacts: [perfumesPages],
  }, perfumesFound, perfumesFetched)),
  'perfumes-parse': portsIo('perfumes-parse', withRows({
    predecessorJobs: ['perfumes-fetch'], inputArtifacts: [asInput(perfumesPages, 'pages')], outputArtifacts: [perfumesData],
  }, [perfumesFetched[0]], perfumesParsed)),
  'perfumes-build': portsIo('perfumes-build', withRows({
    // Two inputs from two different stages: the parsed data, and the URLs from stage 1.
    predecessorJobs: ['perfumes-find-url', 'perfumes-parse'],
    inputArtifacts: [asInput(perfumesData, 'data'), asInput(perfumesUrls, 'urls')], outputArtifacts: [perfumesProfiles],
  }, perfumesParsed, perfumesBuilt)),
};
const perfumesStageIoOverall = portsIo('__overall__', withRows({
  predecessorJobs: ['perfumes-find-url'], outputJobs: ['perfumes-build'], outputArtifacts: [perfumesProfiles],
}, perfumesFound, perfumesBuilt));
const perfumesGates = [
  { key: 'fragrantica-urls', producer: 'perfumes-find-url', consumer: 'perfumes-fetch', state: 'passed' },
  { key: 'fragrantica-pages', producer: 'perfumes-fetch', consumer: 'perfumes-parse', state: 'passed' },
  { key: 'fragrantica-data', producer: 'perfumes-parse', consumer: 'perfumes-build', state: 'passed' },
  { key: 'fragrantica-urls', producer: 'perfumes-find-url', consumer: 'perfumes-build', state: 'passed' },
];

// vault-sync — single stage: vault-sync-export (the second-brain vault mirror).
const vaultSyncMembers = [{ job_name: 'vault-sync-export', depends_on: [] }];
const vaultSyncWorkflowRun = workflowRun({ id: 'vault-sync-run', workflow_name: 'vault-sync' });
const vaultSyncRunJobs = vaultSyncMembers.map((m, i) => run({
  id: `vault-sync-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'vault-sync-run',
}));
// A ports stage whose output is what it did to the vault (inline), plus the files it copied.
const vaultSyncIo = singleOutputIo('vault-sync-export', [portsArtifact({
  job: 'vault-sync-export', port: 'result', artifactKey: 'vault-export-result', storage: 'inline',
  description: 'What this run did to the vault: how many files were copied in, and how many were already up to date.',
  summary: '1 copied, 2954 unchanged', inline: { synced: 1, unchanged: 2954, failed: 0 }, bytes: 44,
})], [
  { id: 'vault-sync-export:plex-profiles-build::movie:10123', jobName: 'vault-sync-export', itemKey: 'plex-profiles-build::movie:10123', status: 'success', title: '10 Cloverfield Lane (2016)', fields: [{ label: 'In the vault', value: 'Plex/Movies/10 Cloverfield Lane (2016).md' }], preview: { path: 'plex-profiles/data/out/movies/10123-10-cloverfield-lane.md', format: 'markdown' } },
]);
const vaultSyncStageIo = vaultSyncIo.stage;
const vaultSyncStageIoOverall = vaultSyncIo.overall;

// plex-library-guard — single stage: plex-library-guard-scan (daily per-file snapshot + deletion alerts).
const plexLibraryGuardMembers = [{ job_name: 'plex-library-guard-scan', depends_on: [] }];
const plexLibraryGuardWorkflowRun = workflowRun({ id: 'plex-library-guard-run', workflow_name: 'plex-library-guard' });
const plexLibraryGuardRunJobs = plexLibraryGuardMembers.map((m, i) => run({
  id: `plex-library-guard-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'plex-library-guard-run',
}));
// A ports stage with two declared outputs and no display rows: the per-run report, and
// the baseline snapshot whose declared format picks the searchable inventory viewer.
const plexLibraryGuardArtifacts = [
  portsArtifact({
    job: 'plex-library-guard-scan', port: 'report', artifactKey: 'plex-guard-report',
    description: 'What this run found: the library\'s size and file count, anything missing since the last run, and whether an alert went out.',
    summary: '14201 file(s), 17.5 TB, 2 missing, 0 added, ALERTED', itemCount: 2, bytes: 1_480,
    preview: { path: 'plex-library-guard/data/out/guard-report.json', format: 'json' },
    sample: [{ id: 'part:1', title: 'A Missing Film (2019)', status: 'failed', fields: [{ label: 'Kind', value: 'movie' }, { label: 'File', value: '/Volumes/Share A/Movies/A Missing Film (2019)/A Missing Film (2019).mkv' }] }],
  }),
  portsArtifact({
    job: 'plex-library-guard-scan', port: 'snapshot', artifactKey: 'plex-library-snapshot', format: 'library-snapshot',
    description: 'The full per-file inventory of the library, and the baseline the next run is compared with.',
    summary: '14201 file(s), 17.5 TB', itemCount: 14201, bytes: 10_400_000,
    preview: { path: 'plex-library-guard/data/out/library-snapshot.json', format: 'library-snapshot' },
  }),
];
const plexLibraryGuardIo = singleOutputIo('plex-library-guard-scan', plexLibraryGuardArtifacts);
const plexLibraryGuardStageIo = plexLibraryGuardIo.stage;
const plexLibraryGuardStageIoOverall = plexLibraryGuardIo.overall;
// The GET .../output(-items) response body for `plexLibraryGuardOutput` — a real
// GuardReportFile JSON string (an alerted run with missing files) so the generic
// json OutputRenderer has realistic content to paint in the View popover.
const plexLibraryGuardOutputFixture = {
  found: true, job: 'plex-library-guard-scan', key: '2026-06-15', format: 'json',
  file: '/abs/data/out/guard-report.json', bytes: 640, truncated: false,
  content: JSON.stringify({
    generatedAt: NOW, firstRun: false,
    totalBytes: 19_216_842_162_176, totalHuman: '17.5 TB', fileCount: 14201,
    prev: { generatedAt: '2026-06-14T10:30:00.000Z', totalBytes: 19_223_284_596_736, fileCount: 14203 },
    dropBytes: 6_442_434_560, dropExceeds: true, thresholdGb: 0,
    missingCount: 2,
    missing: [
      { key: '1001::501', ratingKey: '1001', type: 'movie', title: 'A Deleted Movie (2018)', file: '/movies/a-deleted-movie.mkv', bytes: 5_368_709_120 },
      { key: '2002::701', ratingKey: '2002', type: 'episode', title: 'Some Show — S02E04 — Gone', file: '/tv/some-show-s02e04.mkv', bytes: 1_073_725_440 },
    ],
    addedCount: 0, suspectPartialRead: false, alerted: true,
  }),
};
// The GET .../output(-items) response body for the guard's STABLE 'snapshot' item —
// a real (miniature) LibrarySnapshotFile so the 'library-snapshot' renderer's
// searchable file list has realistic rows to paint.
const plexLibraryGuardSnapshotFixture = {
  found: true, job: 'plex-library-guard-scan', key: 'snapshot', format: 'library-snapshot',
  file: '/abs/data/out/library-snapshot.json', bytes: 2048, truncated: false,
  content: JSON.stringify({
    generatedAt: NOW, movieSection: '4', tvSection: '5',
    totalBytes: 19_223_284_596_736, totalHuman: '17.5 TB', fileCount: 5,
    files: [
      { key: '1001::501', ratingKey: '1001', type: 'movie', title: 'A Very Long Movie Title That Might Wrap On Narrow Screens (2019)', file: '/movies/A Very Long Movie Title/A.Very.Long.Movie.Title.2019.2160p.WEB.H265-GROUP.mkv', bytes: 42_949_672_960 },
      { key: '1002::502', ratingKey: '1002', type: 'movie', title: 'Another Movie (2021)', file: '/movies/another-movie.mkv', bytes: 12_884_901_888 },
      { key: '2001::701', ratingKey: '2001', type: 'episode', title: 'A Great TV Show — S01E01 — Pilot', file: '/tv/a-great-tv-show/s01e01.mkv', bytes: 3_221_225_472 },
      { key: '2001::702', ratingKey: '2001', type: 'episode', title: 'A Great TV Show — S01E02 — The Second One', file: '/tv/a-great-tv-show/s01e02.mkv', bytes: 3_221_225_472 },
      { key: '3001::801', ratingKey: '3001', type: 'movie', title: 'No Path Movie (2011)', file: null, bytes: 1_073_741_824 },
    ],
  }),
};

// plex-rename — discover -> plan -> verify -> apply (mutating, quota'd) -> confirm.
const plexRenameMembers = [
  { job_name: 'plex-rename-discover', depends_on: [] },
  { job_name: 'plex-rename-plan', depends_on: ['plex-rename-discover'] },
  // verify, apply and confirm each read the discover rows as well as the stage before them.
  { job_name: 'plex-rename-verify', depends_on: ['plex-rename-discover', 'plex-rename-plan'] },
  { job_name: 'plex-rename-apply', depends_on: ['plex-rename-discover', 'plex-rename-verify'] },
  { job_name: 'plex-rename-confirm', depends_on: ['plex-rename-discover', 'plex-rename-apply'] },
];
const plexRenameWorkflowRun = workflowRun({ id: 'plex-rename-run', workflow_name: 'plex-rename' });
const plexRenameRunJobs = plexRenameMembers.map((m, i) => run({
  id: `plex-rename-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'plex-rename-run',
}));
const MOB = 'Mob Psycho 100 — s02e05';
const MOB_FROM = '/volume1/Share/TV/[Erai-raws] Mob Psycho 100 II - 05.mkv';
const MOB_TO = '/volume1/Share/TV/Mob Psycho 100 (2016) {tvdb-307375}/Season 02/Mob Psycho 100 (2016) - s02e05.mkv';
// On ports, with the data in the ledger. discover's total is far above its list length,
// which exercises the paged "X of Y" heading and the in-list load-more (the 27k-item fix).
const plexRenamePorts = ledgerPipelineFixtures([
  { job: 'plex-rename-discover', port: 'files', key: 'plex-rename-discover', description: 'Every physical library file (movie or episode) as Plex sees it: path, size, ids and naming metadata. One ledger row per file, re-recorded every run.', summary: '27251 file(s)', count: 27251, outputTotal: 27251,
    rows: [{ itemKey: '1001::part501', title: MOB, fields: [{ label: 'Kind', value: 'episode' }, { label: 'File', value: MOB_FROM }] }] },
  { job: 'plex-rename-plan', port: 'plan', key: 'plex-rename-plan', description: 'Each file\'s decision: rename (with the exact from and to), already canonical, or skip. One ledger row per file.', summary: '27251 decision(s), 312 to rename', count: 27251, deps: ['plex-rename-discover'],
    rows: [{ itemKey: '1001::part501', title: MOB, fields: [{ label: 'Decision', value: 'rename' }, { label: 'To', value: MOB_TO }] }] },
  { job: 'plex-rename-verify', port: 'verdicts', key: 'plex-rename-verify', description: 'Each rename candidate checked against the local disk: eligible or not, with the verified size and the sidecar files that move with it.', summary: '312 verdict(s), 301 eligible', count: 312, deps: ['plex-rename-discover', 'plex-rename-plan'],
    rows: [{ itemKey: '1001::part501', title: MOB, fields: [{ label: 'Eligible', value: 'yes' }] }] },
  { job: 'plex-rename-apply', port: 'applied', key: 'plex-rename-apply', description: 'Every file that has been moved to its canonical path and checksum-verified, with its final path and hash. A file is moved once, ever.', summary: '26004 file(s) moved', count: 26004, deps: ['plex-rename-discover', 'plex-rename-verify'],
    rows: [{ itemKey: '1001::part501', title: MOB, fields: [{ label: 'Now at', value: MOB_TO }] }] },
  { job: 'plex-rename-confirm', port: 'confirmed', key: 'plex-rename-confirm', description: 'Each moved file that Plex has been confirmed to see at its new path. One ledger row per confirmed file.', summary: '25990 confirmed', count: 25990, deps: ['plex-rename-discover', 'plex-rename-apply'],
    rows: [{ itemKey: '1001::part501', title: `${MOB} — confirmed` }] },
], { product: 'plex-rename-apply' });
const plexRenameStageIo = plexRenamePorts.stageIo;
const plexRenameStageIoOverall = plexRenamePorts.overall;

// mount-keeper — single stage: mount-keeper-check (hourly NAS SMB share remounter).
const mountKeeperMembers = [{ job_name: 'mount-keeper-check', depends_on: [] }];
const mountKeeperWorkflowRun = workflowRun({ id: 'mount-keeper-run', workflow_name: 'mount-keeper' });
const mountKeeperRunJobs = mountKeeperMembers.map((m, i) => run({
  id: `mount-keeper-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'mount-keeper-run',
}));
// A ports stage with one INLINE output: the state of every share after the run.
const mountKeeperIo = singleOutputIo('mount-keeper-check', [portsArtifact({
  job: 'mount-keeper-check', port: 'status', artifactKey: 'mount-status', storage: 'inline',
  description: 'Every configured network share after this run: already mounted, remounted, or failed.',
  summary: '1 healthy, 1 remounted, 0 failed', itemCount: 2, bytes: 410,
  inline: { checkedAt: '2026-06-22T09:45:03.000Z', healthy: 1, remounted: 1, failed: 0 },
  sample: [
    { id: '/Volumes/Share A', title: 'Share A', status: 'success', fields: [{ label: 'Mount point', value: '/Volumes/Share A' }, { label: 'Action', value: 'already-mounted' }, { label: 'Was', value: 'healthy' }] },
    { id: '/Volumes/Share B', title: 'Share B', status: 'success', fields: [{ label: 'Mount point', value: '/Volumes/Share B' }, { label: 'Action', value: 'remounted' }, { label: 'Was', value: 'absent' }] },
  ],
})]);
const mountKeeperStageIo = mountKeeperIo.stage;
const mountKeeperStageIoOverall = mountKeeperIo.overall;

// media-reviews — four INDEPENDENT single-stage members (books/movies/tv/albums),
// no dependsOn edges: exercises a 4-node, zero-edge DAG render.
const mediaReviewsMembers = [
  { job_name: 'media-reviews-books', depends_on: [] },
  { job_name: 'media-reviews-movies', depends_on: [] },
  { job_name: 'media-reviews-tv', depends_on: [] },
  { job_name: 'media-reviews-albums', depends_on: [] },
];
const mediaReviewsWorkflowRun = workflowRun({ id: 'media-reviews-run', workflow_name: 'media-reviews' });
const mediaReviewsRunJobs = mediaReviewsMembers.map((m, i) => run({
  id: `media-reviews-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'media-reviews-run',
}));
// Four independent ports stages, each with its own cumulative folder of reviews.
const mediaReviewsCats = { books: ['Norwegian Wood (Haruki Murakami)', 'book-0001-aaaa', 212], movies: ['Stalker (1979)', 'movie-0001-cccc', 431], tv: ['Severance', 'tv-0001-dddd', 118], albums: ['In Rainbows (Radiohead)', 'album-0001-bbbb', 97] };
const mediaReviewsStageIo = Object.fromEntries(Object.entries(mediaReviewsCats).map(([cat, [title, key, n]]) => {
  const job = `media-reviews-${cat}`;
  return [job, portsIo(job, {
    outputArtifacts: [portsArtifact({ job, port: 'reviews', artifactKey: 'media-reviews', storage: 'dir', format: 'markdown', description: 'One markdown file per review in this category, mirrored from the website\'s table.', summary: `${n} review(s)`, itemCount: n })],
    outputs: cat === 'books' || cat === 'albums' ? [{ id: `${job}:${key}`, jobName: job, itemKey: key, status: 'success', title, fields: [], preview: { path: `media-reviews/data/out/${cat}/${key}.md`, format: 'markdown' } }] : [],
    outputTotal: cat === 'books' || cat === 'albums' ? 1 : 0,
  })];
}));
const mediaReviewsStageIoOverall = portsIo('__overall__', {
  outputJobs: Object.keys(mediaReviewsStageIo),
  outputArtifacts: Object.values(mediaReviewsStageIo).flatMap((io) => io.outputArtifacts),
  outputs: Object.values(mediaReviewsStageIo).flatMap((io) => io.outputs), outputTotal: 2,
});

// Map an /api/* pathname (+ optional search params) to a fixture body.
/**
 * The stage-io wire shape carries EXPLICIT display rows (`title`, `fields`,
 * `preview`) that the server builds. Most fixtures in this file were written as
 * raw ledger rows (`{ jobName, itemKey, status, detail }`), which is what a
 * LEGACY (pre-ports) run looks like before the server maps it. This applies the
 * same frozen legacy mapping the API does (`legacyRow` in src/engine/reporting.ts),
 * so those fixtures stay honest: title from `detail.name`, up to four scalar
 * keys as fields, preview from `detail.markdown` / `detail.path`. A fixture that
 * already declares `mode` (a ports fixture) passes through untouched.
 */
function legacyStageIoWire(body) {
  if (!body || body.mode) return body;
  const humanize = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
  const skip = new Set(['name', 'markdown', 'path', 'format', 'attempts']);
  const row = (it) => {
    if (it.title !== undefined) return it;
    const d = it.detail && typeof it.detail === 'object' ? it.detail : null;
    const fields = [];
    for (const k of Object.keys(d ?? {})) {
      if (fields.length >= 4) break;
      const v = d[k];
      if (skip.has(k) || v == null || !['string', 'number', 'boolean'].includes(typeof v)) continue;
      fields.push({ label: humanize(k), value: String(v).slice(0, 80) });
    }
    const format = d && typeof d.format === 'string' && d.format ? d.format : 'markdown';
    const path = d ? (format === 'markdown' ? (d.markdown ?? d.path) : (d.path ?? d.markdown)) : undefined;
    return {
      id: `${it.jobName}:${it.itemKey}`, jobName: it.jobName, itemKey: it.itemKey, status: it.status,
      title: (d && typeof d.name === 'string' && d.name) || it.itemKey, fields,
      ...(typeof path === 'string' && path ? { preview: { path, format } } : {}),
    };
  };
  return { mode: 'legacy', inputArtifacts: [], outputArtifacts: [], outputsUnchanged: 0, ...body, inputs: (body.inputs ?? []).map(row), outputs: (body.outputs ?? []).map(row) };
}

/**
 * A preview fetched by recorded path (GET /api/output-file): how every row and
 * artifact preview on the run page is loaded. Returns the SAME content fixtures
 * the per-item output endpoint serves, chosen by the declared format, so each
 * renderer (markdown, json, the size table, the library snapshot browser) is
 * still exercised through the run page.
 */
function outputFileFixture(searchParams) {
  const format = searchParams?.get('format') || 'markdown';
  const path = searchParams?.get('path') ?? '';
  const as = (fixture) => ({ ...fixture, format, file: path });
  if (format === 'size-table') return as(plexSpaceSaverOutputFixture);
  if (format === 'library-snapshot') return as(plexLibraryGuardSnapshotFixture);
  if (format === 'json' && path.startsWith('plex-library-guard/')) return as(plexLibraryGuardOutputFixture);
  if (format === 'json') return /^(tv-recs|movies)\//.test(path)
    ? { found: true, format, file: path, bytes: 64, truncated: false, content: JSON.stringify({ generatedAt: '2026-06-01T09:00:00Z', recommendations: [{ tmdbId: 111110, title: 'ONE PIECE', year: 2023 }] }) }
    : as(placesJsonOutputFixture);
  if (format === 'text') return { found: true, format, file: path, bytes: 32, truncated: false, content: 'Fragrantica page capture…\nTop notes: bergamot' };
  return { found: true, format: 'markdown', file: path, bytes: 1234, truncated: false, content: '---\nname: A Resolved Place\n---\n\n# A Resolved Place\n\nA short synthetic profile body for the output preview popover.\n\n| Ticker | Account | Quantity |\n| --- | --- | --- |\n| AAPL | invest | 10 |\n| VUSA | isa | 5 |\n' };
}

export function fixtureFor(pathname, searchParams) {
  if (pathname === '/api/output-file') return outputFileFixture(searchParams);
  if (pathname.endsWith('/stage-io')) return legacyStageIoWire(fixtureForRaw(pathname, searchParams));
  return fixtureForRaw(pathname, searchParams);
}

function fixtureForRaw(pathname, searchParams) {

  if (pathname === '/api/stuck') return { stuck: [stuckItem(), stuckItem({ item_key: LONG + '-2' })] };
  if (pathname === '/api/ignored') return { ignored: [stuckItem({ item_key: LONG + '-ign' })] };
  if (pathname === '/api/workflows') return { workflows: [
    // T398: claude-warmer FIRST on purpose -- reproduces the real dashboard's card-height bug,
    // where the very first .panel card in the Overview grid had no `.panel + .panel` sibling
    // margin, so grid's stretch alignment compressed every other (non-first) card instead.
    workflow({ name: 'claude-warmer', category: 'regular-maintenance', schedule: '*/30 * * * *', jobs: singleStageMembers, stuck: 0 }),
    // T498: `places` is certified by default (see the `workflow()` factory) — exercises the
    // 🏅 badge on both the Workflows list and its detail page; `perfumes` stays un-certified
    // below so both states render.
    workflow(),
    workflow({ name: 'perfumes', enabled: 0, effective_notify_enabled: false, certified: 0 }),
    workflow({ name: 'movie-recommendations', category: 'recommendations', stuck: 0 }),
    workflow({ name: 'missing-movies', category: 'recommendations', stuck: 0 }),
    workflow({ name: 'workouts-sync', category: 'regular-maintenance', stuck: 0 }),
    workflow({ name: 'legacy-job', category: 'uncategorized', stuck: 0 }),
  ] };
  if (pathname === '/api/workflow-runs') return { runs: [workflowRun(), workflowRun({ id: '2', status: 'failed' })] };
  if (pathname === '/api/movie-recs') return movieRecs;
  if (pathname === '/api/tv-recs') return tvRecs;
  if (pathname === '/api/movie-gaps') return movieGaps;
  if (pathname === '/api/missing-seasons') return missingSeasons;
  // Sub-routes must precede the generic `/api/workflow-runs/<id>` catch-all below.
  if (pathname.includes('/gates/') && pathname.startsWith('/api/workflow-runs/')) return gateInspection;
  if (pathname.includes('/gates/') && pathname.startsWith('/api/workflows/')) return structuralGateDetail;
  if (pathname === '/api/workflow-runs/skipped') return { run: workflowRunSkipped, jobs: membersSkipped, logs, gates: [] };
  // A failed run (it offers "Resume from here"), and the run that resumed it: its
  // first stage was reused rather than run again.
  if (pathname === '/api/workflow-runs/failed-run') {
    return { run: workflowRun({ id: 'failed-run', status: 'failed' }), jobs: members.map((m, i) => run({
      id: `failed-${i}`, job_name: m.job_name, workflow_run_id: 'failed-run', cycle: 1,
      status: i === 0 ? 'success' : i === 1 ? 'failed' : 'skipped',
      outcome_reason: i > 1 ? 'upstream-skipped' : null,
      error: i === 1 ? 'Error: upstream returned 503 for every attempt' : i > 1 ? `skipped: upstream ${members[1].job_name} did not succeed (failed)` : null,
    })), logs, gates: [] };
  }
  if (pathname === '/api/workflow-runs/resumed-run') {
    return { run: workflowRun({ id: 'resumed-run', resumed_from: 'failed-run' }), jobs: members.map((m, i) => run({
      id: `resumed-${i}`, job_name: m.job_name, workflow_run_id: 'resumed-run', cycle: 1, status: 'success',
      outcome_reason: i === 0 ? 'resumed' : null, duration_ms: i === 0 ? 0 : 12_300,
      progress_msg: i === 0 ? 'reused from run failed-run' : '',
    })), logs, gates: [] };
  }
  if (pathname === '/api/workflow-runs/movie-recs-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return movieRecsStageIoOverall;
    const job = searchParams?.get('job');
    return movieRecsStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/movie-recs-run') return { run: movieRecsWorkflowRun, jobs: movieRecsRunJobs, logs, gates: movieRecsGates };
  if (pathname === '/api/workflow-runs/missing-movies-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return missingMoviesStageIoOverall;
    const job = searchParams?.get('job');
    return missingMoviesStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/missing-movies-run') return { run: missingMoviesWorkflowRun, jobs: missingMoviesRunJobs, logs, gates: missingMoviesPorts.gates };
  if (pathname === '/api/workflow-runs/stocks/stage-io') {
    if (searchParams?.get('overall') === 'true') return stocksStageIoOverall;
    const job = searchParams?.get('job');
    return stocksStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/stocks') return { run: stocksWorkflowRun, jobs: stocksRunJobs, logs, gates: stocksGates };
  if (pathname === '/api/workflow-runs/stock-digest-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return stockDigestStageIoOverall;
    const job = searchParams?.get('job');
    return stockDigestStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/stock-digest-run') return { run: stockDigestWorkflowRun, jobs: stockDigestRunJobs, logs, gates: stockDigestGates };
  if (pathname === '/api/workflow-runs/1/stage-io') {
    if (searchParams?.get('overall') === 'true') return placesStageIoOverall;
    const job = searchParams?.get('job');
    return placesStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/claude-warmer-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return singleStageStageIoOverall;
    const job = searchParams?.get('job');
    return singleStageStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/claude-warmer-run') return { run: singleStageWorkflowRun, jobs: singleStageRunJobs, logs, gates: [] };
  if (pathname === '/api/workflow-runs/missing-tv-seasons-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return missingTvSeasonsStageIoOverall;
    const job = searchParams?.get('job');
    return missingTvSeasonsStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/missing-tv-seasons-run') return { run: missingTvSeasonsWorkflowRun, jobs: missingTvSeasonsRunJobs, logs, gates: missingTvSeasonsPorts.gates };
  if (pathname === '/api/workflow-runs/workouts-sync-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return workoutsSyncStageIoOverall;
    const job = searchParams?.get('job');
    return workoutsSyncStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/workouts-sync-run') return { run: workoutsSyncWorkflowRun, jobs: workoutsSyncRunJobs, logs, gates: workoutsSyncPorts.gates };
  if (pathname === '/api/workflow-runs/listening-digest-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return listeningDigestStageIoOverall;
    const job = searchParams?.get('job');
    return listeningDigestStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/listening-digest-run') return { run: listeningDigestWorkflowRun, jobs: listeningDigestRunJobs, logs, gates: [] };
  if (pathname === '/api/workflow-runs/projects-sync-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return projectsSyncStageIoOverall;
    const job = searchParams?.get('job');
    return projectsSyncStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/projects-sync-run') return { run: projectsSyncWorkflowRun, jobs: projectsSyncRunJobs, logs, gates: projectsSyncPorts.gates };
  if (pathname === '/api/workflow-runs/plex-space-saver-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return plexSpaceSaverStageIoOverall;
    const job = searchParams?.get('job');
    return plexSpaceSaverStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/plex-space-saver-run') return { run: plexSpaceSaverWorkflowRun, jobs: plexSpaceSaverRunJobs, logs, gates: [] };
  if (pathname === '/api/workflow-runs/plex-language-fix-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return plexLanguageFixStageIoOverall;
    const job = searchParams?.get('job');
    return plexLanguageFixStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/plex-language-fix-run') return { run: plexLanguageFixWorkflowRun, jobs: plexLanguageFixRunJobs, logs, gates: plexLanguageFixGates };
  if (pathname === '/api/workflow-runs/plex-profiles-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return plexProfilesStageIoOverall;
    const job = searchParams?.get('job');
    return plexProfilesStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/plex-profiles-run') return { run: plexProfilesWorkflowRun, jobs: plexProfilesRunJobs, logs, gates: [] };
  if (pathname === '/api/workflow-runs/vercel-daily-redeploy-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return vercelDailyRedeployStageIoOverall;
    const job = searchParams?.get('job');
    return vercelDailyRedeployStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/vercel-daily-redeploy-run') return { run: vercelDailyRedeployWorkflowRun, jobs: vercelDailyRedeployRunJobs, logs, gates: [] };
  if (pathname === '/api/workflow-runs/tv-recommendations-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return tvRecommendationsStageIoOverall;
    const job = searchParams?.get('job');
    return tvRecommendationsStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (/^\/api\/workflow-runs\/(tv-recommendations-run|movie-recs-run)\/artifact-items$/.test(pathname)) {
    // The full item list of one artifact, paged on demand (here: the library snapshot).
    const movies = pathname.includes('movie-recs-run');
    const offset = Number(searchParams?.get('offset') ?? 0);
    const items = Array.from({ length: 100 }, (_, i) => ({ id: String(offset + i + 1), title: `${movies ? 'Film' : 'Show'} ${offset + i + 1}`, fields: [{ label: 'Year', value: String(1990 + ((offset + i) % 35)) }] }));
    return { found: true, items, total: movies ? 812 : 650, changedSinceRun: false, sampleOnly: false, limit: 100 };
  }
  if (pathname === '/api/workflow-runs/tv-recommendations-run') return { run: tvRecommendationsWorkflowRun, jobs: tvRecommendationsRunJobs, logs, gates: tvRecommendationsGates };
  if (pathname === '/api/workflow-runs/perfumes-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return perfumesStageIoOverall;
    const job = searchParams?.get('job');
    return perfumesStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/perfumes-run') return { run: perfumesWorkflowRun, jobs: perfumesRunJobs, logs, gates: perfumesGates };
  if (pathname === '/api/workflow-runs/vault-sync-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return vaultSyncStageIoOverall;
    const job = searchParams?.get('job');
    return vaultSyncStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/vault-sync-run') return { run: vaultSyncWorkflowRun, jobs: vaultSyncRunJobs, logs, gates: [] };
  if (pathname === '/api/workflow-runs/plex-library-guard-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return plexLibraryGuardStageIoOverall;
    const job = searchParams?.get('job');
    return plexLibraryGuardStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/plex-library-guard-run') return { run: plexLibraryGuardWorkflowRun, jobs: plexLibraryGuardRunJobs, logs, gates: [] };
  if (pathname === '/api/workflow-runs/plex-rename-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return plexRenameStageIoOverall;
    const job = searchParams?.get('job');
    return plexRenameStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/plex-rename-run') return { run: plexRenameWorkflowRun, jobs: plexRenameRunJobs, logs, gates: plexRenamePorts.gates };
  if (pathname === '/api/workflow-runs/media-reviews-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return mediaReviewsStageIoOverall;
    const job = searchParams?.get('job') ?? '';
    return mediaReviewsStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/media-reviews-run') return { run: mediaReviewsWorkflowRun, jobs: mediaReviewsRunJobs, logs, gates: [] };
  if (pathname === '/api/workflow-runs/mount-keeper-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return mountKeeperStageIoOverall;
    const job = searchParams?.get('job');
    return mountKeeperStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/mount-keeper-run') return { run: mountKeeperWorkflowRun, jobs: mountKeeperRunJobs, logs, gates: [] };
  if (pathname.includes('/output') && pathname.startsWith('/api/workflow-runs/')) {
    if (searchParams?.get('key') === PLACES_JSON_ITEM_KEY) return placesJsonOutputFixture;
    if (searchParams?.get('job') === 'plex-space-saver-scan') return plexSpaceSaverOutputFixture;
    if (searchParams?.get('job') === 'plex-library-guard-scan') {
      return searchParams?.get('key') === 'snapshot' ? plexLibraryGuardSnapshotFixture : plexLibraryGuardOutputFixture;
    }
    return { found: true, job: 'places-enrich-with-llm', key: 'place:x', file: '/abs/data/out/x.md', bytes: 1234, truncated: false, content: '---\nname: A Resolved Place\n---\n\n# A Resolved Place\n\nA short synthetic profile body for the output preview popover.\n\n| Ticker | Account | Quantity |\n| --- | --- | --- |\n| AAPL | invest | 10 |\n| VUSA | isa | 5 |\n' };
  }
  if (pathname.startsWith('/api/workflow-runs/')) {
    return {
      run: workflowRun(),
      // places-resolve has TWO runs (an earlier failed attempt, then the latest
      // success) so the "N earlier attempt(s)" expandable row (T417) has real
      // data to show; places-enrich stays single-run (the common case).
      jobs: [
        run({ id: '3', job_name: 'places-resolve', status: 'failed', error: 'Timed out resolving CID', finished_at: NOW }),
        run({ id: '4', job_name: 'places-resolve', status: 'success' }),
        run(),
        run({ id: '2', job_name: 'places-enrich', status: 'failed' }),
      ],
      logs,
      gates,
    };
  }
  if (pathname === '/api/workflows/movie-recommendations') {
    return { workflow: workflow({ name: 'movie-recommendations', category: 'recommendations', jobs: movieRecsMembers, gates: [] }) };
  }
  if (pathname === '/api/workflows/missing-movies') {
    return { workflow: workflow({ name: 'missing-movies', category: 'recommendations', jobs: missingMoviesMembers, gates: [] }) };
  }
  if (pathname === '/api/workflows/stocks-sync') {
    return { workflow: workflow({ name: 'stocks-sync', category: 'regular-maintenance', jobs: stocksMembers, gates: [] }) };
  }
  if (pathname === '/api/workflows/stock-digest') {
    return { workflow: workflow({ name: 'stock-digest', category: 'regular-maintenance', jobs: stockDigestMembers, gates: [] }) };
  }
  if (pathname === '/api/workflows/claude-warmer') {
    return { workflow: workflow({ name: 'claude-warmer', category: 'regular-maintenance', jobs: singleStageMembers, gates: [] }) };
  }
  if (pathname === '/api/workflows/missing-tv-seasons') {
    return { workflow: workflow({ name: 'missing-tv-seasons', category: 'recommendations', jobs: missingTvSeasonsMembers, gates: [] }) };
  }
  if (pathname === '/api/workflows/workouts-sync') {
    return { workflow: workflow({ name: 'workouts-sync', category: 'regular-maintenance', jobs: workoutsSyncMembers, gates: [] }) };
  }
  if (pathname === '/api/workflows/listening-digest') {
    return { workflow: workflow({ name: 'listening-digest', category: 'regular-maintenance', jobs: listeningDigestMembers, gates: [] }) };
  }
  if (pathname === '/api/workflows/projects-sync') {
    return { workflow: workflow({ name: 'projects-sync', category: 'regular-maintenance', jobs: projectsSyncMembers, gates: [] }) };
  }
  if (pathname === '/api/workflows/plex-space-saver') {
    return { workflow: workflow({ name: 'plex-space-saver', category: 'regular-maintenance', jobs: plexSpaceSaverMembers, gates: [] }) };
  }
  if (pathname === '/api/workflows/plex-language-fix') {
    return { workflow: workflow({ name: 'plex-language-fix', category: 'regular-maintenance', jobs: plexLanguageFixMembers, gates: plexLanguageFixGates }) };
  }
  if (pathname === '/api/workflows/plex-profiles') {
    return { workflow: workflow({ name: 'plex-profiles', category: 'second-brain', jobs: plexProfilesMembers, gates: [] }) };
  }
  if (pathname === '/api/workflows/vercel-daily-redeploy') {
    return { workflow: workflow({ name: 'vercel-daily-redeploy', category: 'regular-maintenance', jobs: vercelDailyRedeployMembers, gates: [] }) };
  }
  if (pathname === '/api/workflows/tv-recommendations') {
    return { workflow: workflow({ name: 'tv-recommendations', category: 'recommendations', jobs: tvRecommendationsMembers, gates: [] }) };
  }
  if (pathname === '/api/workflows/perfumes') {
    return { workflow: workflow({ name: 'perfumes', category: 'second-brain', jobs: perfumesMembers, gates: perfumesGates.map(({ state, ...g }) => g) }) };
  }
  if (pathname === '/api/workflows/vault-sync') {
    return { workflow: workflow({ name: 'vault-sync', category: 'second-brain', jobs: vaultSyncMembers, gates: [], after: ['places', 'perfumes', 'plex-profiles', 'listening-digest', 'workouts-sync', 'media-reviews'] }) };
  }
  if (pathname === '/api/workflows/plex-library-guard') {
    return { workflow: workflow({ name: 'plex-library-guard', category: 'regular-maintenance', jobs: plexLibraryGuardMembers, gates: [] }) };
  }
  if (pathname === '/api/workflows/plex-rename') {
    return { workflow: workflow({ name: 'plex-rename', category: 'regular-maintenance', jobs: plexRenameMembers, gates: plexRenamePorts.gates.map(({ state, ...g }) => g) }) };
  }
  if (pathname === '/api/workflows/mount-keeper') {
    return { workflow: workflow({ name: 'mount-keeper', category: 'regular-maintenance', schedule: '45 * * * *', jobs: mountKeeperMembers, gates: [] }) };
  }
  if (pathname === '/api/workflows/media-reviews') {
    return { workflow: workflow({ name: 'media-reviews', category: 'second-brain', schedule: '0 4 * * *', jobs: mediaReviewsMembers, gates: [] }) };
  }
  if (pathname.endsWith('/output-items')) {
    if (pathname === '/api/workflows/places/output-items') {
      return {
        items: [
          { jobName: 'places-enrich-with-llm', itemKey: 'place:ChIJ' + LONG, name: 'A Resolved Place', hasMarkdown: true, viewable: true, updatedAt: NOW },
          { jobName: 'places-enrich-with-llm', itemKey: 'place:second', name: null, hasMarkdown: false, viewable: false, updatedAt: NOW },
          // T458/T616: a real T262 format+path (JSON) item — no detail.markdown, so
          // `hasMarkdown: false`, but `viewable: true` since it carries detail.format +
          // detail.path. Exercises the JSON "View" button + the json OutputRenderer path.
          { jobName: 'places-enrich-with-llm', itemKey: PLACES_JSON_ITEM_KEY, name: 'Enrichment summary (JSON)', hasMarkdown: false, viewable: true, updatedAt: NOW },
        ],
        terminalJobs: ['places-enrich-with-llm'],
      };
    }
    // T617: plex-space-saver is a ports workflow, so its Output section shows the
    // breakdown as an artifact card ("View file" opens the size-table renderer).
    if (pathname === '/api/workflows/plex-space-saver/output-items') {
      return { items: [], total: 0, terminalJobs: ['plex-space-saver-scan'], artifacts: [{ ...plexSpaceSaverArtifact, workflowRunId: 'plex-space-saver-run' }] };
    }
    // plex-library-guard is a ports workflow: its Output section shows the report and
    // the baseline snapshot as artifact cards ("View file" opens each in its viewer).
    if (pathname === '/api/workflows/plex-library-guard/output-items') {
      return { items: [], total: 0, terminalJobs: ['plex-library-guard-scan'], artifacts: plexLibraryGuardArtifacts.map((a) => ({ ...a, workflowRunId: 'plex-library-guard-run' })) };
    }
    // A PORTS workflow: the Output section shows the latest artifact its product
    // stage committed (a card, with which run wrote it) above the produced items.
    if (pathname === '/api/workflows/perfumes/output-items') {
      return {
        items: [
          { jobName: 'perfumes-build', itemKey: AVENTUS, name: 'Aventus — Creed', hasMarkdown: true, viewable: true, updatedAt: NOW },
          { jobName: 'perfumes-build', itemKey: HALFETI, name: 'Halfeti — Penhaligon\'s', hasMarkdown: true, viewable: true, updatedAt: NOW },
        ],
        total: 45,
        terminalJobs: ['perfumes-build'],
        artifacts: [{ ...perfumesProfiles, workflowRunId: 'perfumes-run' }],
      };
    }
    return { items: [], terminalJobs: [], artifacts: [] };
  }
  // T282: GET /api/workflows/:name/output?job=&key= — the unified Output section's
  // (not-run-scoped) artifact fetch, dispatched by the item's declared `format`
  // (T262). Reuses the same synthetic markdown body as the run-scoped fixture above.
  if (pathname.endsWith('/output') && pathname.startsWith('/api/workflows/')) {
    if (searchParams?.get('key') === PLACES_JSON_ITEM_KEY) return placesJsonOutputFixture;
    if (pathname === '/api/workflows/plex-space-saver/output') return plexSpaceSaverOutputFixture;
    if (pathname === '/api/workflows/plex-library-guard/output') {
      return searchParams?.get('key') === 'snapshot' ? plexLibraryGuardSnapshotFixture : plexLibraryGuardOutputFixture;
    }
    return { found: true, job: 'places-enrich-with-llm', key: 'place:ChIJ' + LONG, format: 'markdown', file: '/abs/data/out/x.md', bytes: 1234, truncated: false, content: '---\nname: A Resolved Place\n---\n\n# A Resolved Place\n\nA short synthetic profile body for the output preview popover.\n\n| Ticker | Account | Quantity |\n| --- | --- | --- |\n| AAPL | invest | 10 |\n| VUSA | isa | 5 |\n' };
  }
  if (pathname.startsWith('/api/workflows/')) return { workflow: workflow() };
  if (pathname.endsWith('/runs') && pathname.startsWith('/api/jobs/')) return { runs: [run(), run({ id: '2', status: 'failed' })] };
  if (pathname.startsWith('/api/jobs/')) return { job: job() };
  if (pathname.startsWith('/api/runs/')) return { run: run(), logs };
  if (pathname === '/api/cache') return { counts: [{ service_name: 'gemini', count: 12 }, { service_name: 'google-places', count: 4 }] };
  // T611: individual service_cache rows for the admin page's per-service "Browse" expand.
  if (pathname === '/api/cache/rows') {
    return {
      rows: [
        { service_name: 'gemini', cache_key: 'gemini:summarize:place:ChIJ' + LONG, cached_at: NOW, response_json: JSON.stringify({ summary: 'A short synthetic Gemini response.', tokens: 128 }), live: true },
        { service_name: 'gemini', cache_key: 'gemini:summarize:place:second', cached_at: '2024-01-01T00:00:00.000Z', response_json: JSON.stringify({ summary: 'An older, expired cached response.' }), live: false },
      ],
    };
  }
  if (pathname === '/api/cache/clear') return { ok: true, cleared: 16 };
  if (pathname === '/api/services') return { services: [service(), service({ name: 'gemini', paid: 1 }), service({ name: 'fragrantica', category: 'website-scrape', paid: 0, daily_cap: null, monthly_cap: null }), service({ name: 'claude-cli', category: 'cli-tool', paid: 0, rate_per_minute: null, daily_cap: null, monthly_cap: null }), service({ name: 'legacy-service', category: 'uncategorized', paid: 0, rate_per_minute: null, daily_cap: null, monthly_cap: null }), service({ name: 'plex', category: 'api', paid: 0, rate_per_minute: null, daily_cap: null, monthly_cap: null, timeout_ms: 8000, limits_overridden: 0, rate_limit_source: 'Local Plex server on the LAN — no external rate limit; timeout guards against a DHCP-stale host hanging a request.' })] };
  if (pathname.startsWith('/api/services/') && pathname.endsWith('/consumers')) return { consumers: [{ workflow_name: 'places', jobs: [{ job_name: 'places-enrich', last_used: NOW }, { job_name: 'places-enrich-with-llm', last_used: NOW }] }, { workflow_name: 'perfumes', jobs: [{ job_name: 'perfumes-build', last_used: NOW }] }] };
  if (pathname === '/api/workflows/reset-output-all') return {
    ok: true,
    totalWorkflows: 2,
    resetCount: 1,
    skippedCount: 1,
    results: [
      { name: 'places', status: 'reset', itemsDeleted: 42, runsDeleted: 12, wfRunsDeleted: 3, filesRemoved: 18, outDir: '/abs/data/out' },
      { name: 'movie-recommendations', status: 'skipped', reason: 'workflow has an active run' },
    ],
  };
  if (pathname === '/api/workflows/run-all') return {
    ok: true,
    totalWorkflows: 3,
    startedCount: 2,
    skippedCount: 1,
    limit: 3,
    results: [
      { name: 'places', status: 'started', limited: true, limit: 3 },
      { name: 'claude-warmer', status: 'started', limited: false, limit: null },
      { name: 'movie-recommendations', status: 'skipped', reason: 'workflow has an active run' },
    ],
  };
  if (pathname === '/api/logs') {
    const allLogs = [
      { id: 6, ts: NOW, level: 'error', message: 'Places API returned 429 — quota exceeded for the day', source: 'job', jobName: 'places-enrich', workflowName: null, runId: '1', workflowRunId: null },
      { id: 5, ts: NOW, level: 'warn', message: 'Gate check found 2 rows missing an expected field', source: 'workflow', jobName: null, workflowName: 'places', runId: null, workflowRunId: '1' },
      { id: 4, ts: NOW, level: 'info', message: 'Resolved place_id for CID 12345', source: 'job', jobName: 'places-resolve', workflowName: null, runId: '1', workflowRunId: null },
      { id: 3, ts: NOW, level: 'error', message: 'TMDB lookup failed for tmdbId 300 — connection reset', source: 'job', jobName: 'tv-rec-merge', workflowName: null, runId: '2', workflowRunId: null },
      { id: 2, ts: NOW, level: 'info', message: 'Workflow run started (trigger: schedule)', source: 'workflow', jobName: null, workflowName: 'movie-recommendations', runId: null, workflowRunId: '2' },
      { id: 1, ts: NOW, level: 'warn', message: 'Service quota at 80% of monthly cap', source: 'job', jobName: 'places-enrich-with-llm', workflowName: null, runId: '1', workflowRunId: null },
    ];
    const levelParam = searchParams?.get('level');
    const wantedLevels = levelParam ? levelParam.split(',').filter(Boolean) : null;
    const logs = wantedLevels ? allLogs.filter((l) => wantedLevels.includes(l.level)) : allLogs;
    return { logs, nextCursor: null };
  }
  return {};
}

// ── Page list ───────────────────────────────────────────────────────────────
// One representative URL per distinct dashboard route. `[id]`/`[name]` are real
// Next.js dynamic routes — the path value (e.g. `1`, `places`) is arbitrary because
// the API is mocked, so any value renders the page against the fixtures above.
//
// Optional per-page fields (read by visual-check.mjs; mobile-check.mjs ignores them):
//   waitFor  — CSS selectors to await VISIBLE before settling (covers async/post-mount
//              renders like the DAG's layout useEffect). Stable selectors confirmed in
//              DagFlow.tsx: stage node `.dag-node.rf-dag-node`, gate padlock `.dag-gate-lock`.
//   settleMs — per-page settle delay override (defaults to VISUAL_SETTLE_MS).
export const PAGES = [
  { name: 'overview',                path: '/' },
  { name: 'workflows',               path: '/workflows' },
  { name: 'workflow',                path: '/workflows/places',               waitFor: ['.rf-dag-node'] },
  { name: 'workflow-movie-recs',     path: '/workflows/movie-recommendations', waitFor: ['.rf-dag-node'] },
  { name: 'workflow-missing-movies', path: '/workflows/missing-movies',        waitFor: ['.rf-dag-node'] },
  { name: 'workflow-empty-output',   path: '/workflows/workouts-sync',         waitFor: ['.rf-dag-node'] },
  { name: 'workflow-tv-recs',        path: '/workflows/tv-recommendations',    waitFor: ['.rf-dag-node'] },
  // A failed run offers "Resume from here"; the run that resumed it marks the reused stage.
  { name: 'workflow-run-failed-resumable', path: '/workflow-runs/failed-run',  waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-resumed',    path: '/workflow-runs/resumed-run',       waitFor: ['.rf-dag-node'] },
  // A ports workflow's page: its Output section leads with the product artifact card.
  { name: 'workflow-perfumes-ports-output', path: '/workflows/perfumes',       waitFor: ['.rf-dag-node', '.stage-io-artifact'] },
  { name: 'workflow-missing-tv-seasons', path: '/workflows/missing-tv-seasons', waitFor: ['.rf-dag-node'] },
  // A workflow that waits for others (`after`): its "Waits for" row.
  { name: 'workflow-vault-sync-waits-for', path: '/workflows/vault-sync',   waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run',            path: '/workflow-runs/1',                waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-movie-recs', path: '/workflow-runs/movie-recs-run',   waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-missing-movies', path: '/workflow-runs/missing-movies-run', waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-skipped',    path: '/workflow-runs/skipped',          waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-stocks-io',  path: '/workflow-runs/stocks',           waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-stock-digest', path: '/workflow-runs/stock-digest-run', waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-claude-warmer', path: '/workflow-runs/claude-warmer-run', waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-missing-tv-seasons', path: '/workflow-runs/missing-tv-seasons-run', waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-workouts-sync',      path: '/workflow-runs/workouts-sync-run',      waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-listening-digest',   path: '/workflow-runs/listening-digest-run',   waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-projects-sync',      path: '/workflow-runs/projects-sync-run',      waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-plex-space-saver',   path: '/workflow-runs/plex-space-saver-run',   waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-plex-language-fix',  path: '/workflow-runs/plex-language-fix-run',  waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-plex-profiles',      path: '/workflow-runs/plex-profiles-run',      waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-vercel-daily-redeploy', path: '/workflow-runs/vercel-daily-redeploy-run', waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-tv-recommendations', path: '/workflow-runs/tv-recommendations-run', waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-perfumes',           path: '/workflow-runs/perfumes-run',           waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-vault-sync',         path: '/workflow-runs/vault-sync-run',         waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-plex-library-guard', path: '/workflow-runs/plex-library-guard-run', waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-plex-rename',        path: '/workflow-runs/plex-rename-run',        waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-mount-keeper',       path: '/workflow-runs/mount-keeper-run',       waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-media-reviews',      path: '/workflow-runs/media-reviews-run',      waitFor: ['.rf-dag-node'] },
  { name: 'gate-run-scoped',         path: '/workflow-runs/1/gates/places-resolve/resolved.json' },
  { name: 'gate-definition-scoped',  path: '/workflows/places/gates/places-resolve/resolved.json' },
  { name: 'job',                     path: '/jobs/places-enrich' },
  { name: 'run',                     path: '/runs/1' },
  { name: 'services',                path: '/integrations' },
  { name: 'logs',                    path: '/logs' },
  { name: 'admin',                   path: '/admin' },
];

// ── Interaction flows ─────────────────────────────────────────────────────────
// visual-check captures a baseline screenshot of every PAGES entry. FLOWS add EXTRA
// screenshots of states that only appear after an INTERACTION — a collapsed section
// expanded, a popover/menu opened, a tab switched — so a reviewer can see UI that the
// default render hides. Each flow:
//   name     — the screenshot file (`<name>.png`) AND its label (keep it unique).
//   path     — the route to load.
//   waitFor  — selectors to await visible before interacting (optional).
//   actions  — async (page) => {…}: drive the real Playwright `page` (click/hover/
//              evaluate) to set up the state. Then visual-check settles + screenshots.
//   settleMs — optional settle override after the actions (default VISUAL_SETTLE_MS).
// ⚠️ LIVING ARTIFACT: when a UI change adds/removes an interactive state worth seeing
// (a new collapsible section, a new menu), add/adjust a flow here in the SAME change.
export const FLOWS = [
  {
    // Ports run page: the fan-in stage's Inputs are one ARTIFACT CARD per branch
    // plus the snapshot, its Output the recommendations artifact. Nothing here is
    // a ledger row written for display.
    name: 'workflow-run-ports-fan-in-stage',
    path: '/workflow-runs/tv-recommendations-run',
    waitFor: ['.io-job-filter-chip'],
    actions: async (page) => {
      await page.click('.io-job-filter-chip:has-text("tv-rec-merge")');
      await page.waitForSelector('.stage-io-artifact', { timeout: 5000 });
    },
  },
  {
    // A branch stage reports the SAMPLE of its input it actually used (40 of 650
    // shows), shown inside the snapshot's input card.
    name: 'workflow-run-ports-used-sample',
    path: '/workflow-runs/tv-recommendations-run',
    waitFor: ['.io-job-filter-chip'],
    actions: async (page) => {
      await page.click('.io-job-filter-chip:has-text("tv-rec-canon")');
      await page.waitForSelector('.stage-io-artifact-used', { timeout: 5000 });
    },
  },
  {
    // "Browse N items" on an artifact card opens its full item list, paged from
    // the server on demand (never the whole artifact up front).
    name: 'workflow-run-ports-browse-artifact-items',
    path: '/workflow-runs/tv-recommendations-run',
    waitFor: ['.stage-io-artifact'],
    actions: async (page) => {
      await page.click('button:has-text("Browse 650 items")');
      await page.waitForSelector('.db-modal .stage-io-list-tall .stage-io-item', { timeout: 5000 });
    },
  },
  {
    // A ports ITEM PIPELINE (perfumes): the fetch stage's tab shows the cumulative
    // store it was handed and the one it adds to as cards, and under them only the
    // items THIS run touched, including a failed one with what came back.
    name: 'workflow-run-ports-item-pipeline-fetch',
    path: '/workflow-runs/perfumes-run',
    waitFor: ['.io-job-filter-chip'],
    actions: async (page) => {
      await page.click('.io-job-filter-chip:has-text("perfumes-fetch")');
      await page.waitForSelector('.stage-io-artifact', { timeout: 5000 });
    },
  },
  {
    // The same pipeline's last stage takes TWO inputs from two different stages
    // (the parsed data from parse, the URLs from find-url).
    name: 'workflow-run-ports-item-pipeline-build',
    path: '/workflow-runs/perfumes-run',
    waitFor: ['.io-job-filter-chip'],
    actions: async (page) => {
      await page.click('.io-job-filter-chip:has-text("perfumes-build")');
      await page.waitForSelector('.stage-io-artifact', { timeout: 5000 });
    },
  },
  {
    // Stage-I/O lazy paging (2026-08): the plex-rename-discover tab's fixture
    // reports outputTotal 27251 against a 1-row list, so this shot paints the
    // paged "1 of 27251" column heading + the in-list "Load more" sentinel —
    // the fix for the 27k-item run page that used to freeze the tab.
    name: 'workflow-run-stage-io-load-more',
    path: '/workflow-runs/plex-rename-run',
    waitFor: ['.io-job-filter-chip'],
    actions: async (page) => {
      await page.click('.io-job-filter-chip:has-text("plex-rename-discover")');
      await page.waitForSelector('.stage-io-load-more', { timeout: 5000 });
    },
  },
  {
    // T611: admin page's Cached responses panel — clicking "Browse" on a service
    // row expands its individual service_cache rows (cache_key/cached_at/Live-Stale
    // pill), then expanding a row's <details> shows the pretty-printed response_json.
    name: 'admin-cache-browse-expanded',
    path: '/admin',
    waitFor: ['button:has-text("Browse")'],
    actions: async (page) => {
      await page.click('button:has-text("Browse")');
      await page.waitForSelector('summary:has-text("view")', { timeout: 5000 });
      await page.click('summary:has-text("view")');
      await page.waitForTimeout(200);
    },
  },
  {
    // T282: the workflow-detail page's unified Output section (WorkflowOutputSection)
    // now dispatches its popover renderer by the item's declared `format` (T262) —
    // confirms the 'markdown' form still renders identically via this new dispatch.
    name: 'workflow-output-section-popover',
    path: '/workflows/places',
    viewport: true,
    waitFor: ['.output-section button.btn.btn-sm'],
    actions: async (page) => {
      await page.click('.output-section button.btn.btn-sm');
      await page.waitForSelector('.db-modal', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('.md-body', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);
    },
  },
  {
    // plex-library-guard's Output section popover for the STABLE 'snapshot' item —
    // confirms the 'library-snapshot' OutputRenderer paints the searchable per-file
    // inventory (summary line, filter box, file rows), not a raw JSON dump.
    name: 'workflow-output-section-library-snapshot',
    path: '/workflows/plex-library-guard',
    waitFor: ['.output-section .stage-io-item-link'],
    actions: async (page) => {
      await page.click('.stage-io-artifact:has-text("plex-library-snapshot") .stage-io-item-link:has-text("View file")');
      await page.waitForSelector('.db-modal', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('.snapshot-search', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);
    },
  },
  {
    // T617: plex-space-saver's Output section popover — confirms the 'size-table'
    // OutputRenderer draws a proportional horizontal bar chart, not a raw JSON dump.
    name: 'workflow-output-section-size-table',
    path: '/workflows/plex-space-saver',
    viewport: true,
    waitFor: ['.output-section .stage-io-item-link'],
    actions: async (page) => {
      await page.click('.output-section .stage-io-item-link:has-text("View file")');
      await page.waitForSelector('.db-modal', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('.size-bar-list', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);
    },
  },
  {
    // T617: same 'size-table' bar chart, but via the run-scoped Stage I/O popover
    // (StageIoLists) rather than the workflow-definition Output section — confirms
    // both call sites of `renderOutputBody` paint it identically.
    name: 'stage-io-size-table',
    path: '/workflow-runs/plex-space-saver-run',
    viewport: true,
    waitFor: ['.stage-io-item-link'],
    actions: async (page) => {
      await page.click('.stage-io-item-link:has-text("View file")');
      await page.waitForSelector('.db-modal', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('.size-bar-list', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);
    },
  },
  {
    // T360: confirms react-markdown + remark-gfm actually renders a GFM pipe
    // table as a real <table>, not raw `| a | b |` text — the bug this fixes.
    // T386 follow-up: the markdown-preview affordance now lives on StageIoPanel's
    // `.stage-io-item-link` (its default "Overall" tab already shows the terminal
    // stage's markdown output), not the old IoPanel's `.out-meta-link`.
    name: 'workflow-run-output-table',
    path: '/workflow-runs/1',
    viewport: true,
    waitFor: ['.stage-io-item-link'],
    actions: async (page) => {
      await page.click('.stage-io-item-link');
      await page.waitForSelector('.db-modal', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('.md-body table', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);
    },
  },
  {
    // T417: expand a stage's "N earlier attempt(s)" toggle in the Member runs
    // table — confirms the earlier (failed) attempt row renders with its own
    // status badge/timestamp/duration/logs-link once expanded.
    name: 'workflow-run-earlier-attempts-expanded',
    path: '/workflow-runs/1',
    waitFor: ['.rf-dag-node'],
    actions: async (page) => {
      await page.click('button:has-text("earlier attempt")');
      await page.waitForTimeout(200);
    },
  },
  {
    // Logs page with the 'error' level pill active — shows the level filter
    // narrowed to just error-level lines (the redundant 'Errors only' chip was
    // removed since this pill alone already produces the same state, T330).
    name: 'logs-errors-only',
    path: '/logs',
    actions: async (page) => {
      await page.click('.io-filter-chip:has-text("error")');
      await page.waitForTimeout(200);
    },
  },
  {
    // Movie-recs table sorted by Lens (click the Lens header) — shows same-lens rows clustered.
    name: 'movie-recs-sorted-by-lens',
    path: '/workflows/movie-recommendations',
    waitFor: ['table th.sort-th'],
    actions: async (page) => {
      // Click the Lens header to sort by lens (default is TMDB desc; one click → lens desc)
      await page.click('table th.sort-th:has-text("Lens")');
      await page.waitForTimeout(200);
    },
  },
  {
    // TV-recs table sorted by TMDB descending (the default, confirmed in screenshot).
    name: 'tv-recs-default-sort',
    path: '/workflows/tv-recommendations',
    waitFor: ['table th.sort-th-active'],
  },
  {
    // TV-recs EMPTY state (no run yet) — a page-level route override (takes precedence over
    // the context-level routeApi) makes /api/tv-recs return generatedAt: null just for this
    // capture, so the boxed empty-state panel (T345) is actually screenshotted.
    name: 'tv-recs-empty',
    path: '/workflows/tv-recommendations',
    settleMs: 1200,
    actions: async (page) => {
      await page.route('**/api/tv-recs', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ generatedAt: null, pooled: 0, recommendations: [] }) });
      });
      await page.reload({ waitUntil: 'networkidle' });
    },
  },
  {
    // T595: the Workflows list page's transient "Starting…" indicator — shown while a
    // limited manual run has claimed the workflow (startingWorkflows, in-process) but
    // its workflow_runs row doesn't exist yet (a slow root-stage inputKeys() crawl, e.g.
    // plex-language-fix's discoverInputKeys()). Overrides /api/workflows so the 'places'
    // row carries `starting: true` for this capture.
    name: 'workflows-list-starting',
    path: '/workflows',
    settleMs: 1200,
    actions: async (page) => {
      await page.route('**/api/workflows', async (route) => {
        const body = JSON.stringify({ workflows: [
          workflow({ name: 'claude-warmer', category: 'regular-maintenance', schedule: '*/30 * * * *', jobs: singleStageMembers, stuck: 0 }),
          workflow({ starting: true }),
          workflow({ name: 'perfumes', enabled: 0, effective_notify_enabled: false, certified: 0 }),
        ] });
        await route.fulfill({ status: 200, contentType: 'application/json', body });
      });
      await page.reload({ waitUntil: 'networkidle' });
    },
  },
  {
    // T595: the same "Starting…" indicator on the workflow DETAIL page's header + Run
    // button, driven by /api/workflows/:name's `starting` field.
    name: 'workflow-detail-starting',
    path: '/workflows/places',
    waitFor: ['.rf-dag-node'],
    settleMs: 1200,
    actions: async (page) => {
      await page.route('**/api/workflows/places', async (route) => {
        const body = JSON.stringify({ workflow: workflow({ starting: true }) });
        await route.fulfill({ status: 200, contentType: 'application/json', body });
      });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('.rf-dag-node', { timeout: 5000 });
    },
  },
  {
    // The service detail modal, opened by clicking a service name on the Services page.
    // Shows both the "Rate limit provenance" section and the "Consumers of …" list.
    // viewport: true — the modal backdrop covers only the viewport.
    name: 'service-consumers-modal',
    path: '/integrations',
    viewport: true,
    actions: async (page) => {
      // Click the first service button to open the consumers modal.
      await page.click('button.btn.secondary:has-text("google-places")');
      await page.waitForSelector('.db-modal', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);
    },
  },
  {
    // T351: the edit-mode Save/Cancel row on the Services page — verifies the
    // action column has room and the buttons wrap instead of clipping ("Cal…").
    name: 'services-edit-limits-row',
    path: '/integrations',
    viewport: true,
    actions: async (page) => {
      await page.click('button:has-text("Edit limits")');
      await page.waitForSelector('button:has-text("Save")', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);
    },
  },
  {
    // `places` (a strictly-linear multi-stage workflow) — clicking a per-stage
    // chip on StageIoPanel re-scopes the view to that ONE stage's own decoupled
    // inputs/outputs.
    name: 'stage-io-job-scoped-places',
    path: '/workflow-runs/1',
    waitFor: ['.io-job-filter-bar'],
    actions: async (page) => {
      // :text-is() for an EXACT match — "places-enrich-with-llm" also contains the
      // substring "places-enrich", so a has-text() selector would match both chips.
      await page.click('.io-job-filter-chip:text-is("places-enrich")');
      await page.waitForTimeout(400);
    },
  },
  {
    // T382 follow-up: StageIoPanel's chip bar defaults to the FIRST stage (not
    // "All stages") to avoid the busy stacked view — click "All stages" to confirm
    // that alternate (all 3 blocks stacked) state still renders cleanly.
    name: 'stage-io-all-stages',
    path: '/workflow-runs/stock-digest-run',
    waitFor: ['.io-job-filter-bar'],
    actions: async (page) => {
      await page.click('.io-job-filter-chip:text-is("All stages")');
      await page.waitForTimeout(400);
    },
  },
  {
    // T385: StageIoPanel now defaults to the "Overall" tab (workflow-wide root-wave
    // inputs / terminal-wave outputs) — click a per-stage chip to confirm the
    // original single-stage view still renders correctly alongside the new default.
    name: 'stage-io-per-stage-tab',
    path: '/workflow-runs/stock-digest-run',
    waitFor: ['.io-job-filter-bar'],
    actions: async (page) => {
      await page.click('.io-job-filter-chip:text-is("stock-digest-build")');
      await page.waitForSelector('.stage-io-artifact', { timeout: 5000 });
    },
  },
  {
    // T386: `places` and `claude-warmer` (linear multi-stage and single-stage shapes)
    // now render StageIoPanel; its default "Overall" tab shows the workflow-wide
    // root-wave inputs / terminal-wave outputs — confirm the single-stage case (where
    // the root wave AND terminal wave are the SAME job) renders sensibly, not blank
    // or duplicated.
    name: 'stage-io-single-stage-overall',
    path: '/workflow-runs/claude-warmer-run',
    waitFor: ['.io-job-filter-bar'],
  },
  {
    // T387: movie-recommendations is a PARALLEL FAN-OUT: 8 rec-* branches all depend on
    // the SAME movie-snapshot predecessor. Clicking one branch's chip (rec-auteur) must
    // show ONLY the artifacts it was handed (the shared snapshot and taste profile) and
    // the one suggestions file it committed, not any sibling branch's.
    name: 'stage-io-fan-out-branch-auteur',
    path: '/workflow-runs/movie-recs-run',
    waitFor: ['.io-job-filter-bar'],
    actions: async (page) => {
      await page.click('.io-job-filter-chip:text-is("rec-auteur")');
      await page.waitForTimeout(400);
    },
  },
  {
    // T387: same fan-out, a DIFFERENT sibling branch (rec-canon). The screenshot should
    // visibly differ from rec-auteur's (a different suggestions file), proving branches
    // don't bleed into each other.
    name: 'stage-io-fan-out-branch-canon',
    path: '/workflow-runs/movie-recs-run',
    waitFor: ['.io-job-filter-bar'],
    actions: async (page) => {
      await page.click('.io-job-filter-chip:text-is("rec-canon")');
      await page.waitForTimeout(400);
    },
  },
  {
    // T607: the DAG's genuine root stage (no predecessors at all, and it recorded no input
    // rows this run either) must still show "No inputs — this is the root stage."
    name: 'stage-io-root-stage-empty-inputs',
    path: '/workflow-runs/missing-movies-run',
    waitFor: ['.io-job-filter-bar'],
    actions: async (page) => {
      await page.click('.io-job-filter-chip:text-is("plex-movie-snapshot")');
      await page.waitForTimeout(400);
    },
  },
  {
    // A ports audit's last stage: the gaps it was handed (an input card), the report and
    // digest it committed, and the gap it announced. (This used to be the T607 "non-root
    // stage with no inputs" case; on ports a non-root stage always shows what it was handed.)
    name: 'stage-io-audit-notify-stage',
    path: '/workflow-runs/missing-movies-run',
    waitFor: ['.io-job-filter-bar'],
    actions: async (page) => {
      await page.click('.io-job-filter-chip:text-is("movie-gaps-notify")');
      await page.waitForSelector('.stage-io-artifact', { timeout: 5000 });
    },
  },
  {
    // stocks-sync's product is its portfolio snapshot (the stage is marked `product`),
    // not its final notify stage: the "Overall" tab shows the portfolio and its report
    // as the workflow's outputs. (Before ports this was the `outputJob` override.)
    name: 'stage-io-product-stage-overall',
    path: '/workflow-runs/stocks',
    waitFor: ['.io-job-filter-bar'],
  },
  {
    // T308: the theme/font/mode picker popover was replaced by a single sun/moon
    // toggle button — click it and capture the resulting (opposite-of-default)
    // data-mode so the toggled look is visible in a screenshot.
    name: 'overview-theme-toggle',
    path: '/',
    actions: async (page) => {
      const before = await page.evaluate(() => document.documentElement.getAttribute('data-mode'));
      await page.click('.theme-trigger');
      await page.waitForFunction(
        (prev) => document.documentElement.getAttribute('data-mode') !== prev,
        before,
        { timeout: 5000 },
      );
    },
  },
  {
    // T344: reintroduces the "System" mode on top of T308's binary toggle — the
    // header button now CYCLES dark → light → system on each click. A fresh/
    // default (untouched) load already resolves to 'system' (no localStorage
    // choice), so this clicks through the full 3-state cycle (up to 3 clicks) to
    // land back on 'system' regardless of the starting icon, guaranteeing the
    // 🖥️ icon is visibly present in a screenshot (T344's living-artifact rule).
    name: 'overview-theme-system',
    path: '/',
    actions: async (page) => {
      for (let i = 0; i < 3; i++) {
        const isSystem = await page.evaluate(
          () => document.querySelector('.theme-trigger')?.textContent?.includes('🖥️'),
        );
        if (isSystem) break;
        await page.click('.theme-trigger');
        await page.waitForTimeout(50);
      }
      await page.waitForFunction(
        () => document.querySelector('.theme-trigger')?.textContent?.includes('🖥️'),
        { timeout: 5000 },
      );
    },
  },
  {
    // T375: the cron tooltip is now portaled to document.body so it escapes a `.panel`'s
    // `overflow: hidden` clipping — this captures it open on the workflow DETAIL page's
    // Schedule row (the originally reported clipped location).
    name: 'cron-tooltip-workflow-detail',
    path: '/workflows/places',
    viewport: true,
    waitFor: ['.cron-help'],
    actions: async (page) => {
      await page.hover('.cron-help');
      await page.waitForSelector('.cron-tooltip', { state: 'visible', timeout: 5000 });
    },
  },
  {
    // T375: same fix, verified on the Workflows LIST page's Schedule column (the other
    // page confirmed clipped before the portal fix).
    name: 'cron-tooltip-workflows-list',
    path: '/workflows',
    viewport: true,
    waitFor: ['.cron-help'],
    actions: async (page) => {
      await page.hover('.cron-help');
      await page.waitForSelector('.cron-tooltip', { state: 'visible', timeout: 5000 });
    },
  },
  {
    // T458: the Stage I/O popover now dispatches by the item's declared `format` via the
    // shared OutputRenderer instead of always forcing content through MarkdownModal —
    // opens the JSON-format item's popover and confirms it renders as indented, monospace
    // JSON (not one collapsed paragraph).
    name: 'stage-io-json-output-popover',
    path: '/workflow-runs/1',
    viewport: true,
    waitFor: ['.stage-io-item-link'],
    actions: async (page) => {
      await page.locator('.stage-io-item-link', { hasText: 'Enrichment summary (JSON)' }).click();
      await page.waitForSelector('.db-modal', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('.db-modal-body pre', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);
    },
  },
  {
    // T458: same JSON-format renderer, exercised via the OTHER I/O surface — the
    // workflow definition page's unified Output section (WorkflowOutputSection), whose
    // dispatch/renderer table now lives in the same shared OutputRenderer module.
    name: 'workflow-output-section-json-popover',
    path: '/workflows/places',
    viewport: true,
    waitFor: ['.output-section button.btn.btn-sm'],
    actions: async (page) => {
      await page.locator('tr', { hasText: 'Enrichment summary (JSON)' }).locator('button').click();
      await page.waitForSelector('.db-modal', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('.db-modal-body pre', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);
    },
  },
  {
    // T548: the five detail pages used to destructure only `data` from usePoll and
    // discard `error`, leaving a permanently-blank skeleton when the daemon is down —
    // unlike the list pages, which already show '⚠ Cannot reach the daemon API (…)'.
    // Fails the workflow-detail fetch (GET /api/workflows/places) and confirms the
    // same message now renders here too.
    //
    // Deliberately does NOT use page.route()+fulfill(status:500): that still runs the
    // request through Chromium's real network stack, which logs a "Failed to load
    // resource: the server responded with a status of 500" console error — and
    // visual-check treats ANY console error as a hard failure, unrelated to whether the
    // page itself rendered correctly. `failDaemonFetch` instead monkey-patches
    // `window.fetch` in-page (via addInitScript, before the reload) to reject the ONE
    // targeted path with a synthetic Response built via `new Response(...)` — a pure
    // JS-level rejection with no real HTTP resource load, so nothing hits the Network
    // domain and nothing is logged.
    name: 'daemon-down-workflow-detail',
    path: '/workflows/places',
    actions: async (page) => {
      await failDaemonFetch(page, '/api/workflows/places');
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('text=Cannot reach the daemon API', { state: 'visible', timeout: 5000 });
    },
  },
  {
    // T548: fails the workflow-run fetch (GET /api/workflow-runs/1) that backs both
    // the run-detail page and its two dependent gate pages.
    name: 'daemon-down-workflow-run-detail',
    path: '/workflow-runs/1',
    actions: async (page) => {
      await failDaemonFetch(page, '/api/workflow-runs/1?');
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('text=Cannot reach the daemon API', { state: 'visible', timeout: 5000 });
    },
  },
  {
    // T548: fails the job-detail fetch (GET /api/jobs/places-enrich).
    name: 'daemon-down-job-detail',
    path: '/jobs/places-enrich',
    actions: async (page) => {
      await failDaemonFetch(page, '/api/jobs/places-enrich');
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('text=Cannot reach the daemon API', { state: 'visible', timeout: 5000 });
    },
  },
  {
    // T548: the run-scoped gate detail page reads the same workflow-run fetch as the
    // run-detail page above; fail it here too on the gate route directly.
    name: 'daemon-down-gate-run-scoped',
    path: '/workflow-runs/1/gates/places-resolve/resolved.json',
    actions: async (page) => {
      await failDaemonFetch(page, '/api/workflow-runs/1?');
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('text=Cannot reach the daemon API', { state: 'visible', timeout: 5000 });
    },
  },
  {
    // T548: the definition-scoped gate detail page's own primary fetch
    // (GET /api/workflows/places/gates/places-resolve/resolved.json).
    name: 'daemon-down-gate-definition-scoped',
    path: '/workflows/places/gates/places-resolve/resolved.json',
    actions: async (page) => {
      await failDaemonFetch(page, '/api/workflows/places/gates/places-resolve/resolved.json');
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('text=Cannot reach the daemon API', { state: 'visible', timeout: 5000 });
    },
  },
];

// ── Harness helpers ─────────────────────────────────────────────────────────

/** Poll a URL until the dashboard responds (OK or 404 — the server is up either way). */
export async function waitForServer(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dashboard did not come up at ${url} within ${timeoutMs}ms`);
}

/** Spawn a production `next start` of the dashboard on the given port. Returns the
 *  child process — the caller is responsible for `server.kill('SIGTERM')`. */
export function startDashboard(port) {
  const server = spawn('npx', ['next', 'start', '-p', String(port)], {
    cwd: DASHBOARD_DIR, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.env.DEBUG && console.error(String(d)));
  return server;
}

/** Serve every `/api/**` call from the synthetic fixtures — fully hermetic, no daemon. */
export async function routeApi(ctx) {
  await ctx.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtureFor(url.pathname, url.searchParams)) });
  });
}

/** Pre-seed the dashboard's mode localStorage key BEFORE first paint, so a
 *  screenshot can be taken in a deterministic light/dark mode. The pre-paint
 *  inline script in dashboard/app/layout.tsx reads this key and sets the
 *  `data-mode` html attribute. Omitted = left unset (the dashboard falls back
 *  to following the OS `prefers-color-scheme`). */
export async function seedTheme(ctx, { mode } = {}) {
  await ctx.addInitScript(
    ([m]) => {
      try {
        const L = window.localStorage;
        if (m) L.setItem('localjobs.mode', m);
      } catch { /* ignore */ }
    },
    [mode],
  );
}

/**
 * Make `window.fetch` reject the given path with a synthetic 500 Response, so a
 * `usePoll`-driven page's `error` state populates the same way it would if the daemon
 * API were actually unreachable. Used by the daemon-down FLOWS above (T548).
 *
 * Deliberately monkey-patches `fetch` in-page rather than using Playwright's
 * `page.route()` + `route.fulfill({status: 500})`: a routed 500 still travels through
 * Chromium's real network stack, which logs a "Failed to load resource: the server
 * responded with a status of 500" console error — and visual-check.mjs treats ANY
 * console error as a hard failure, which would make a deliberately-modeled failure
 * state indistinguishable from a real bug. Building the failing `Response` purely in
 * JS (via `new Response(...)`) never touches the network layer, so nothing is logged.
 *
 * `pathPrefix` matches by `startsWith` against the request URL's pathname+search, so
 * pass a trailing `?` to match a path regardless of query-string value (e.g.
 * `/api/workflow-runs/1?`) without also matching a longer sibling path
 * (`/api/workflow-runs/1/stage-io`).
 */
export async function failDaemonFetch(page, pathPrefix) {
  await page.addInitScript((prefix) => {
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes(prefix)) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'daemon unreachable' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return realFetch(input, init);
    };
  }, pathPrefix);
}
