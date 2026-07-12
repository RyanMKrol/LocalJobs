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
const membersSkipped = members.map((m, i) => run({
  id: `skipped-${i}`, job_name: m.job_name, status: 'skipped', workflow_run_id: 'skipped',
}));

const stocksMembers = [
  { job_name: 'stocks-snapshot', depends_on: [] },
  { job_name: 'stocks-watch', depends_on: ['stocks-snapshot'] },
  { job_name: 'stocks-notify', depends_on: ['stocks-watch'] },
];
const stocksWorkflowRun = workflowRun({ id: 'stocks', workflow_name: 'stocks-sync' });
const stocksRunJobs = stocksMembers.map((m, i) => run({
  id: `stocks-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'stocks',
}));

// stock-digest — exercises StageIoPanel (decoupled inputs/outputs, T382 follow-up).
// StageIoPanel is now (T386) the default for EVERY workflow's run-detail page, so this
// fixture set proves the genuine fan-in shape it was originally built for.
// A 3-stage fan-in DAG: stock-portfolio-snapshot -> both stock-sector-lookup AND
// stock-digest-build. stock-sector-lookup's fixture deliberately has 3 output rows
// (one failed) so the "no root_key collapsing" behaviour is actually visible.
const stockDigestMembers = [
  { job_name: 'stock-portfolio-snapshot', depends_on: [] },
  { job_name: 'stock-sector-lookup', depends_on: ['stock-portfolio-snapshot'] },
  { job_name: 'stock-digest-build', depends_on: ['stock-portfolio-snapshot', 'stock-sector-lookup'] },
];
const stockDigestWorkflowRun = workflowRun({ id: 'stock-digest-run', workflow_name: 'stock-digest' });
const stockDigestRunJobs = stockDigestMembers.map((m, i) => run({
  id: `stock-digest-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'stock-digest-run',
}));
const stockDigestSnapshotOutput = {
  jobName: 'stock-portfolio-snapshot', itemKey: '2026-W27', status: 'success',
  detail: { name: 'Portfolio snapshot — Week 27, 2026', positionCount: 9, totalValue: 307129.77, resolvedCount: 9 },
};
const stockDigestSectorOutputs = [
  { jobName: 'stock-sector-lookup', itemKey: 'AMD_US_EQ', status: 'success', detail: { name: 'AMD_US_EQ', industry: 'Semiconductors', queriedSymbol: 'AMD' } },
  { jobName: 'stock-sector-lookup', itemKey: 'AMZN_US_EQ', status: 'success', detail: { name: 'AMZN_US_EQ', industry: 'Retail', queriedSymbol: 'AMZN' } },
  { jobName: 'stock-sector-lookup', itemKey: 'BRK_B_US_EQ', status: 'failed', detail: { name: 'BRK_B_US_EQ', queriedSymbol: 'BRK/B', error: 'Finnhub returned no finnhubIndustry field' } },
];
const stockDigestStageIo = {
  'stock-portfolio-snapshot': { inputs: [], outputs: [stockDigestSnapshotOutput], predecessorJobs: [], job: 'stock-portfolio-snapshot' },
  'stock-sector-lookup': { inputs: [stockDigestSnapshotOutput], outputs: stockDigestSectorOutputs, predecessorJobs: ['stock-portfolio-snapshot'], job: 'stock-sector-lookup' },
  'stock-digest-build': {
    inputs: [stockDigestSnapshotOutput, ...stockDigestSectorOutputs],
    outputs: [{ jobName: 'stock-digest-build', itemKey: '2026-W27', status: 'success', detail: { name: 'Stock digest — Week 27, 2026', markdown: '/abs/data/out/stock-digest-2026-W27.md' } }],
    predecessorJobs: ['stock-portfolio-snapshot', 'stock-sector-lookup'],
    job: 'stock-digest-build',
  },
};
// T385: the `overall=true` mode (T384) — root-wave inputs (stock-portfolio-snapshot's
// own output, since it has no predecessor) and effective terminal-wave outputs
// (stock-digest-build's report), independent of any single stage tab.
const stockDigestStageIoOverall = {
  inputs: [stockDigestSnapshotOutput],
  outputs: [{ jobName: 'stock-digest-build', itemKey: '2026-W27', status: 'success', detail: { name: 'Stock digest — Week 27, 2026', markdown: '/abs/data/out/stock-digest-2026-W27.md' } }],
  predecessorJobs: ['stock-portfolio-snapshot'],
  outputJobs: ['stock-digest-build'],
  job: '__overall__',
};

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
const singleStageOutput = { jobName: 'claude-warm', itemKey: NOW, status: 'success', detail: { name: 'Warm ping sent' } };
const singleStageStageIo = {
  'claude-warm': { inputs: [], outputs: [singleStageOutput], predecessorJobs: [], job: 'claude-warm' },
};
const singleStageStageIoOverall = {
  inputs: [], outputs: [singleStageOutput], predecessorJobs: [], outputJobs: ['claude-warm'], job: '__overall__',
};

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
    depends_on: ['rec-random-1', 'rec-random-2', 'rec-random-3', 'rec-auteur', 'rec-canon', 'rec-thin-genre', 'rec-older-era', 'rec-world-cinema'],
  },
  { job_name: 'movie-recs-notify', depends_on: ['rec-merge'] },
];
const movieRecsWorkflowRun = workflowRun({ id: 'movie-recs-run', workflow_name: 'movie-recommendations' });
const movieRecsStatusByJob = Object.fromEntries(movieRecsMembers.map((m) => [m.job_name, 'success']));
const movieRecsRunIdByJob = Object.fromEntries(movieRecsMembers.map((m) => [m.job_name, 'movie-recs-run']));
// One passed gate per movie-snapshot → wave-1 node edge (the movieSnapshotContract gate every
// rec-* branch consumes), plus the rec-merge/notify boundary.
const movieRecsGates = [
  ...movieRecsMembers.filter((m) => m.depends_on.includes('movie-snapshot')).map((m) => ({
    key: 'snapshot.json', producer: 'movie-snapshot', consumer: m.job_name, state: 'passed',
    description: 'produces — snapshot.json is a non-empty per-movie library snapshot · consumes — every branch reads the same snapshot',
  })),
  { key: 'recommendations.json', producer: 'rec-merge', consumer: 'movie-recs-notify', state: 'passed', description: 'produces — merged, TMDB-verified recommendations · consumes — the notify stage reads them' },
];
const movieRecsRunJobs = movieRecsMembers.map((m, i) => run({
  id: `movie-recs-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'movie-recs-run',
}));

// T387: StageIoPanel fixtures for the movie-recommendations PARALLEL FAN-OUT shape — one
// stage (movie-snapshot) with 8 sibling rec-* branches in the same wave, each producing its
// OWN distinct output. Proves each branch's stage tab shows only ITS OWN inputs/outputs, not
// every sibling branch's rows bleeding together (the failure mode this task guards against).
const movieSnapshotOutput = {
  jobName: 'movie-snapshot', itemKey: 'snapshot-2026-06', status: 'success',
  detail: { name: 'Library snapshot — June 2026', movieCount: 812 },
};
const movieRecBranchOutput = {
  'rec-random-1': { jobName: 'rec-random-1', itemKey: '100', status: 'success', detail: { name: 'Inception', lens: 'random' } },
  'rec-random-2': { jobName: 'rec-random-2', itemKey: '101', status: 'success', detail: { name: 'Arrival', lens: 'random' } },
  'rec-random-3': { jobName: 'rec-random-3', itemKey: '103', status: 'success', detail: { name: 'Mad Max: Fury Road', lens: 'random' } },
  'rec-auteur': { jobName: 'rec-auteur', itemKey: '104', status: 'success', detail: { name: 'The Grand Budapest Hotel', lens: 'auteur' } },
  'rec-canon': { jobName: 'rec-canon', itemKey: '105', status: 'success', detail: { name: 'Spirited Away', lens: 'canon' } },
  'rec-thin-genre': { jobName: 'rec-thin-genre', itemKey: '108', status: 'success', detail: { name: 'Whiplash', lens: 'thin-genre' } },
  'rec-older-era': { jobName: 'rec-older-era', itemKey: '107', status: 'success', detail: { name: 'The Third Man', lens: 'older-era' } },
  'rec-world-cinema': { jobName: 'rec-world-cinema', itemKey: '106', status: 'success', detail: { name: 'City of God', lens: 'world-cinema' } },
};
// franchiseGapsOutput/movieGapsNotifyOutput belong to the SEPARATE `missing-movies` workflow
// (T468/T469) — see the missingMoviesStageIo fixtures below, which reuse these two.
const franchiseGapsOutput = {
  jobName: 'franchise-gaps', itemKey: '600', status: 'success', detail: { name: 'The Bourne Supremacy' },
};
const recMergeOutput = {
  jobName: 'rec-merge', itemKey: 'movie-recs-merged-2026-06', status: 'success',
  detail: { name: 'Merged recommendations — June 2026', count: 15 },
};
const movieGapsNotifyOutput = {
  jobName: 'movie-gaps-notify', itemKey: '2026-06', status: 'success',
  detail: { name: 'Movie franchise gaps digest — June 2026' },
};
const movieRecsNotifyOutput = {
  jobName: 'movie-recs-notify', itemKey: '2026-06', status: 'success',
  detail: { name: 'Movie recommendations digest — June 2026' },
};
const movieRecsStageIo = {
  'movie-snapshot': { inputs: [], outputs: [movieSnapshotOutput], predecessorJobs: [], job: 'movie-snapshot' },
  ...Object.fromEntries(
    Object.keys(movieRecBranchOutput).map((branch) => [
      branch,
      { inputs: [movieSnapshotOutput], outputs: [movieRecBranchOutput[branch]], predecessorJobs: ['movie-snapshot'], job: branch },
    ]),
  ),
  'rec-merge': {
    inputs: Object.values(movieRecBranchOutput),
    outputs: [recMergeOutput],
    predecessorJobs: Object.keys(movieRecBranchOutput),
    job: 'rec-merge',
  },
  'movie-recs-notify': {
    inputs: [recMergeOutput],
    outputs: [movieRecsNotifyOutput],
    predecessorJobs: ['rec-merge'],
    job: 'movie-recs-notify',
  },
};
const movieRecsStageIoOverall = {
  inputs: [movieSnapshotOutput],
  outputs: [movieRecsNotifyOutput],
  predecessorJobs: ['movie-snapshot'],
  outputJobs: ['movie-recs-notify'],
  job: '__overall__',
};

// T387: `stocks-sync` StageIoPanel fixtures — proves the dashboard renders the `outputJob`
// manifest-override (T348/T384) end to end: the DAG's true terminal stage `stocks-notify`
// never records `work_items` rows (pure notify-trigger), so the "Overall" tab must show
// `stocks-snapshot`'s ledger rows as Outputs, NOT an empty result from `stocks-notify`.
const stocksSnapshotOutputs = [
  { jobName: 'stocks-snapshot', itemKey: 'invest:AAPL', status: 'success', detail: { name: 'AAPL', currentPrice: 198.32, averageBuyPrice: 150.0 } },
  { jobName: 'stocks-snapshot', itemKey: 'isa:VUSA', status: 'success', detail: { name: 'VUSA', currentPrice: 82.1, averageBuyPrice: 90.5 } },
];
const stocksWatchOutputs = [
  { jobName: 'stocks-watch', itemKey: 'invest:AAPL', status: 'success', detail: { name: 'AAPL', gainPct: 32.2 } },
  { jobName: 'stocks-watch', itemKey: 'isa:VUSA', status: 'success', detail: { name: 'VUSA', gainPct: -9.3 } },
];
const stocksNotifyOutputs = [
  { jobName: 'stocks-notify', itemKey: 'invest:AAPL', status: 'success', detail: { name: 'AAPL — fresh breach notified' } },
];
const stocksStageIo = {
  'stocks-snapshot': { inputs: [], outputs: stocksSnapshotOutputs, predecessorJobs: [], job: 'stocks-snapshot' },
  'stocks-watch': { inputs: stocksSnapshotOutputs, outputs: stocksWatchOutputs, predecessorJobs: ['stocks-snapshot'], job: 'stocks-watch' },
  'stocks-notify': { inputs: stocksWatchOutputs, outputs: stocksNotifyOutputs, predecessorJobs: ['stocks-watch'], job: 'stocks-notify' },
};
// `outputJob: 'stocks-snapshot'` (T348) — the Overall tab's outputs come from
// stocks-snapshot, NOT the true terminal stocks-notify.
const stocksStageIoOverall = {
  inputs: stocksSnapshotOutputs,
  outputs: stocksSnapshotOutputs,
  predecessorJobs: ['stocks-snapshot'],
  outputJobs: ['stocks-snapshot'],
  job: '__overall__',
};

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
const missingTvSeasonsSnapshotOutput = { jobName: 'plex-tv-snapshot', itemKey: 'tmdb:1399::S8', status: 'success', detail: { name: 'Game of Thrones — highest owned season 7' } };
const missingTvSeasonsCheckOutput = { jobName: 'tmdb-season-check', itemKey: 'tmdb:1399::S8', status: 'success', detail: { name: 'Game of Thrones — season 8 fully aired, missing' } };
const missingTvSeasonsNotifyOutput = { jobName: 'plex-seasons-notify', itemKey: 'tmdb:1399::S8', status: 'success', detail: { name: 'Game of Thrones — season 8 notified' } };
const missingTvSeasonsStageIo = {
  'plex-tv-snapshot': { inputs: [], outputs: [missingTvSeasonsSnapshotOutput], predecessorJobs: [], job: 'plex-tv-snapshot' },
  'tmdb-season-check': { inputs: [missingTvSeasonsSnapshotOutput], outputs: [missingTvSeasonsCheckOutput], predecessorJobs: ['plex-tv-snapshot'], job: 'tmdb-season-check' },
  'plex-seasons-notify': { inputs: [missingTvSeasonsCheckOutput], outputs: [missingTvSeasonsNotifyOutput], predecessorJobs: ['tmdb-season-check'], job: 'plex-seasons-notify' },
};
const missingTvSeasonsStageIoOverall = {
  inputs: [missingTvSeasonsSnapshotOutput], outputs: [missingTvSeasonsNotifyOutput],
  predecessorJobs: ['plex-tv-snapshot'], outputJobs: ['plex-seasons-notify'], job: '__overall__',
};

// workouts-sync — hevy-sync -> workouts-progress (linear, 2 stages).
const workoutsSyncMembers = [
  { job_name: 'hevy-sync', depends_on: [] },
  { job_name: 'workouts-progress', depends_on: ['hevy-sync'] },
];
const workoutsSyncWorkflowRun = workflowRun({ id: 'workouts-sync-run', workflow_name: 'workouts-sync' });
const workoutsSyncRunJobs = workoutsSyncMembers.map((m, i) => run({
  id: `workouts-sync-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'workouts-sync-run',
}));
const workoutsSyncSyncOutput = { jobName: 'hevy-sync', itemKey: 'workout:2026-06-15-abc123', status: 'success', detail: { name: 'Push day — 2026-06-15' } };
const workoutsSyncProgressOutput = { jobName: 'workouts-progress', itemKey: '2026-06', status: 'success', detail: { name: 'Progress report — June 2026', markdown: '/abs/data/out/workouts-progress.md' } };
const workoutsSyncStageIo = {
  'hevy-sync': { inputs: [], outputs: [workoutsSyncSyncOutput], predecessorJobs: [], job: 'hevy-sync' },
  'workouts-progress': { inputs: [workoutsSyncSyncOutput], outputs: [workoutsSyncProgressOutput], predecessorJobs: ['hevy-sync'], job: 'workouts-progress' },
};
const workoutsSyncStageIoOverall = {
  inputs: [workoutsSyncSyncOutput], outputs: [workoutsSyncProgressOutput],
  predecessorJobs: ['hevy-sync'], outputJobs: ['workouts-progress'], job: '__overall__',
};

// listening-digest — single stage: lastfm-digest.
const listeningDigestMembers = [{ job_name: 'lastfm-digest', depends_on: [] }];
const listeningDigestWorkflowRun = workflowRun({ id: 'listening-digest-run', workflow_name: 'listening-digest' });
const listeningDigestRunJobs = listeningDigestMembers.map((m, i) => run({
  id: `listening-digest-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'listening-digest-run',
}));
const listeningDigestOutput = { jobName: 'lastfm-digest', itemKey: '2026-06', status: 'success', detail: { name: 'Listening digest — June 2026', markdown: '/abs/data/out/listening-digest-2026-06.md' } };
const listeningDigestStageIo = {
  'lastfm-digest': { inputs: [], outputs: [listeningDigestOutput], predecessorJobs: [], job: 'lastfm-digest' },
};
const listeningDigestStageIoOverall = {
  inputs: [], outputs: [listeningDigestOutput], predecessorJobs: [], outputJobs: ['lastfm-digest'], job: '__overall__',
};

// projects-sync — github-sync -> project-summarize (linear, 2 stages).
const projectsSyncMembers = [
  { job_name: 'github-sync', depends_on: [] },
  { job_name: 'project-summarize', depends_on: ['github-sync'] },
];
const projectsSyncWorkflowRun = workflowRun({ id: 'projects-sync-run', workflow_name: 'projects-sync' });
const projectsSyncRunJobs = projectsSyncMembers.map((m, i) => run({
  id: `projects-sync-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'projects-sync-run',
}));
const projectsSyncSyncOutput = { jobName: 'github-sync', itemKey: '123456', status: 'success', detail: { name: 'local-jobs', pushedAt: NOW } };
const projectsSyncSummarizeOutput = { jobName: 'project-summarize', itemKey: '123456', status: 'success', detail: { name: 'local-jobs', markdown: '/abs/data/out/local-jobs.md' } };
const projectsSyncStageIo = {
  'github-sync': { inputs: [], outputs: [projectsSyncSyncOutput], predecessorJobs: [], job: 'github-sync' },
  'project-summarize': { inputs: [projectsSyncSyncOutput], outputs: [projectsSyncSummarizeOutput], predecessorJobs: ['github-sync'], job: 'project-summarize' },
};
const projectsSyncStageIoOverall = {
  inputs: [projectsSyncSyncOutput], outputs: [projectsSyncSummarizeOutput],
  predecessorJobs: ['github-sync'], outputJobs: ['project-summarize'], job: '__overall__',
};

// plex-space-saver — single stage: plex-space-saver-scan.
const plexSpaceSaverMembers = [{ job_name: 'plex-space-saver-scan', depends_on: [] }];
const plexSpaceSaverWorkflowRun = workflowRun({ id: 'plex-space-saver-run', workflow_name: 'plex-space-saver' });
const plexSpaceSaverRunJobs = plexSpaceSaverMembers.map((m, i) => run({
  id: `plex-space-saver-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'plex-space-saver-run',
}));
const plexSpaceSaverOutput = { jobName: 'plex-space-saver-scan', itemKey: '2026-W25', status: 'success', detail: { name: 'Disk-size breakdown — Week 25, 2026', path: '/abs/data/out/size-breakdown-2026-W25.json', format: 'size-table' } };
const plexSpaceSaverStageIo = {
  'plex-space-saver-scan': { inputs: [], outputs: [plexSpaceSaverOutput], predecessorJobs: [], job: 'plex-space-saver-scan' },
};
const plexSpaceSaverStageIoOverall = {
  inputs: [], outputs: [plexSpaceSaverOutput], predecessorJobs: [], outputJobs: ['plex-space-saver-scan'], job: '__overall__',
};

// plex-language-fix — discover -> resolve -> evaluate (fan-in on discover+resolve) -> apply.
const plexLanguageFixMembers = [
  { job_name: 'plex-language-discover', depends_on: [] },
  { job_name: 'plex-language-resolve', depends_on: ['plex-language-discover'] },
  { job_name: 'plex-language-evaluate', depends_on: ['plex-language-discover', 'plex-language-resolve'] },
  { job_name: 'plex-language-apply', depends_on: ['plex-language-evaluate'] },
];
const plexLanguageFixWorkflowRun = workflowRun({ id: 'plex-language-fix-run', workflow_name: 'plex-language-fix' });
const plexLanguageFixRunJobs = plexLanguageFixMembers.map((m, i) => run({
  id: `plex-language-fix-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'plex-language-fix-run',
}));
const plexLanguageFixDiscoverOutput = { jobName: 'plex-language-discover', itemKey: 'file:12345', status: 'success', detail: { name: 'Amélie — /movies/Amelie.mkv' } };
const plexLanguageFixResolveOutput = { jobName: 'plex-language-resolve', itemKey: 'tmdb:194', status: 'success', detail: { name: 'Amélie', originalLanguage: 'fr' } };
const plexLanguageFixEvaluateOutput = { jobName: 'plex-language-evaluate', itemKey: 'file:12345', status: 'success', detail: { name: 'Amélie — audio should be French, currently English' } };
const plexLanguageFixApplyOutput = { jobName: 'plex-language-apply', itemKey: 'file:12345', status: 'success', detail: { name: 'Amélie — audio track switched to French' } };
const plexLanguageFixStageIo = {
  'plex-language-discover': { inputs: [], outputs: [plexLanguageFixDiscoverOutput], predecessorJobs: [], job: 'plex-language-discover' },
  'plex-language-resolve': { inputs: [plexLanguageFixDiscoverOutput], outputs: [plexLanguageFixResolveOutput], predecessorJobs: ['plex-language-discover'], job: 'plex-language-resolve' },
  'plex-language-evaluate': {
    inputs: [plexLanguageFixDiscoverOutput, plexLanguageFixResolveOutput],
    outputs: [plexLanguageFixEvaluateOutput],
    predecessorJobs: ['plex-language-discover', 'plex-language-resolve'],
    job: 'plex-language-evaluate',
  },
  'plex-language-apply': { inputs: [plexLanguageFixEvaluateOutput], outputs: [plexLanguageFixApplyOutput], predecessorJobs: ['plex-language-evaluate'], job: 'plex-language-apply' },
};
const plexLanguageFixStageIoOverall = {
  inputs: [plexLanguageFixDiscoverOutput], outputs: [plexLanguageFixApplyOutput],
  predecessorJobs: ['plex-language-discover'], outputJobs: ['plex-language-apply'], job: '__overall__',
};

// plex-profiles — single stage: plex-profiles-build.
const plexProfilesMembers = [{ job_name: 'plex-profiles-build', depends_on: [] }];
const plexProfilesWorkflowRun = workflowRun({ id: 'plex-profiles-run', workflow_name: 'plex-profiles' });
const plexProfilesRunJobs = plexProfilesMembers.map((m, i) => run({
  id: `plex-profiles-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'plex-profiles-run',
}));
const plexProfilesOutput = { jobName: 'plex-profiles-build', itemKey: 'tmdb:1399', status: 'success', detail: { name: 'Game of Thrones', markdown: '/abs/data/out/game-of-thrones.md' } };
const plexProfilesStageIo = {
  'plex-profiles-build': { inputs: [], outputs: [plexProfilesOutput], predecessorJobs: [], job: 'plex-profiles-build' },
};
const plexProfilesStageIoOverall = {
  inputs: [], outputs: [plexProfilesOutput], predecessorJobs: [], outputJobs: ['plex-profiles-build'], job: '__overall__',
};

// vercel-daily-redeploy — single stage: vercel-redeploy.
const vercelDailyRedeployMembers = [{ job_name: 'vercel-redeploy', depends_on: [] }];
const vercelDailyRedeployWorkflowRun = workflowRun({ id: 'vercel-daily-redeploy-run', workflow_name: 'vercel-daily-redeploy' });
const vercelDailyRedeployRunJobs = vercelDailyRedeployMembers.map((m, i) => run({
  id: `vercel-daily-redeploy-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'vercel-daily-redeploy-run',
}));
const vercelDailyRedeployOutput = { jobName: 'vercel-redeploy', itemKey: '2026-07-10', status: 'success', detail: { name: 'ryankrol.co.uk — production redeploy triggered' } };
const vercelDailyRedeployStageIo = {
  'vercel-redeploy': { inputs: [], outputs: [vercelDailyRedeployOutput], predecessorJobs: [], job: 'vercel-redeploy' },
};
const vercelDailyRedeployStageIoOverall = {
  inputs: [], outputs: [vercelDailyRedeployOutput], predecessorJobs: [], outputJobs: ['vercel-redeploy'], job: '__overall__',
};

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
    depends_on: ['tv-rec-random-1', 'tv-rec-random-2', 'tv-rec-random-3', 'tv-rec-creator', 'tv-rec-canon', 'tv-rec-thin-genre', 'tv-rec-older-era', 'tv-rec-world'],
  },
  { job_name: 'tv-recs-notify', depends_on: ['tv-rec-merge'] },
];
const tvRecommendationsWorkflowRun = workflowRun({ id: 'tv-recommendations-run', workflow_name: 'tv-recommendations' });
const tvRecommendationsRunJobs = tvRecommendationsMembers.map((m, i) => run({
  id: `tv-recommendations-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'tv-recommendations-run',
}));
const tvSnapshotOutput = { jobName: 'tv-snapshot', itemKey: 'snapshot-2026-06', status: 'success', detail: { name: 'TV library snapshot — June 2026', showCount: 214 } };
const tvRecBranchOutput = {
  'tv-rec-random-1': { jobName: 'tv-rec-random-1', itemKey: '300', status: 'success', detail: { name: 'Severance', lens: 'random' } },
  'tv-rec-random-2': { jobName: 'tv-rec-random-2', itemKey: '302', status: 'success', detail: { name: 'Dark', lens: 'random' } },
  'tv-rec-random-3': { jobName: 'tv-rec-random-3', itemKey: '306', status: 'success', detail: { name: 'Money Heist', lens: 'random' } },
  'tv-rec-creator': { jobName: 'tv-rec-creator', itemKey: '303', status: 'success', detail: { name: 'Fleabag', lens: 'creator' } },
  'tv-rec-canon': { jobName: 'tv-rec-canon', itemKey: '307', status: 'success', detail: { name: 'The Wire', lens: 'canon' } },
  'tv-rec-thin-genre': { jobName: 'tv-rec-thin-genre', itemKey: '308', status: 'success', detail: { name: 'Atlanta', lens: 'thin-genre' } },
  'tv-rec-older-era': { jobName: 'tv-rec-older-era', itemKey: '312', status: 'success', detail: { name: 'Cheers', lens: 'older-era' } },
  'tv-rec-world': { jobName: 'tv-rec-world', itemKey: '311', status: 'success', detail: { name: 'Babylon Berlin', lens: 'world-cinema' } },
};
const tvRecMergeOutput = { jobName: 'tv-rec-merge', itemKey: 'tv-recs-merged-2026-06', status: 'success', detail: { name: 'Merged TV recommendations — June 2026', count: 12 } };
const tvRecsNotifyOutput = { jobName: 'tv-recs-notify', itemKey: '2026-06', status: 'success', detail: { name: 'TV recs digest — June 2026' } };
const tvRecommendationsStageIo = {
  'tv-snapshot': { inputs: [], outputs: [tvSnapshotOutput], predecessorJobs: [], job: 'tv-snapshot' },
  ...Object.fromEntries(
    Object.keys(tvRecBranchOutput).map((branch) => [
      branch,
      { inputs: [tvSnapshotOutput], outputs: [tvRecBranchOutput[branch]], predecessorJobs: ['tv-snapshot'], job: branch },
    ]),
  ),
  'tv-rec-merge': {
    inputs: Object.values(tvRecBranchOutput), outputs: [tvRecMergeOutput],
    predecessorJobs: Object.keys(tvRecBranchOutput), job: 'tv-rec-merge',
  },
  'tv-recs-notify': { inputs: [tvRecMergeOutput], outputs: [tvRecsNotifyOutput], predecessorJobs: ['tv-rec-merge'], job: 'tv-recs-notify' },
};
const tvRecommendationsStageIoOverall = {
  inputs: [tvSnapshotOutput], outputs: [tvRecsNotifyOutput],
  predecessorJobs: ['tv-snapshot'], outputJobs: ['tv-recs-notify'], job: '__overall__',
};

// missing-movies — the gaps-only workflow (after T468 split movie-recommendations into recs-only + gaps-only).
// Simple linear: movie-snapshot -> franchise-gaps -> movie-gaps-notify (T469).
const missingMoviesMembers = [
  { job_name: 'movie-snapshot', depends_on: [] },
  { job_name: 'franchise-gaps', depends_on: ['movie-snapshot'] },
  { job_name: 'movie-gaps-notify', depends_on: ['franchise-gaps'] },
];
const missingMoviesWorkflowRun = workflowRun({ id: 'missing-movies-run', workflow_name: 'missing-movies' });
const missingMoviesRunJobs = missingMoviesMembers.map((m, i) => run({
  id: `missing-movies-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'missing-movies-run',
}));
// T469: missing-movies StageIoPanel fixtures — linear 3-stage DAG (movie-snapshot -> franchise-gaps -> movie-gaps-notify).
// Reuses franchise gaps data from the movie-recommendations fixtures above.
const missingMoviesStageIo = {
  'movie-snapshot': { inputs: [], outputs: [movieSnapshotOutput], predecessorJobs: [], job: 'movie-snapshot' },
  'franchise-gaps': { inputs: [movieSnapshotOutput], outputs: [franchiseGapsOutput], predecessorJobs: ['movie-snapshot'], job: 'franchise-gaps' },
  'movie-gaps-notify': { inputs: [franchiseGapsOutput], outputs: [movieGapsNotifyOutput], predecessorJobs: ['franchise-gaps'], job: 'movie-gaps-notify' },
};
const missingMoviesStageIoOverall = {
  inputs: [movieSnapshotOutput],
  outputs: [movieGapsNotifyOutput],
  predecessorJobs: ['movie-snapshot'],
  outputJobs: ['movie-gaps-notify'],
  job: '__overall__',
};

// perfumes — find-url -> fetch -> parse -> build (linear, 4 stages).
const perfumesMembers = [
  { job_name: 'perfumes-find-url', depends_on: [] },
  { job_name: 'perfumes-fetch', depends_on: ['perfumes-find-url'] },
  { job_name: 'perfumes-parse', depends_on: ['perfumes-fetch'] },
  { job_name: 'perfumes-build', depends_on: ['perfumes-parse'] },
];
const perfumesWorkflowRun = workflowRun({ id: 'perfumes-run', workflow_name: 'perfumes' });
const perfumesRunJobs = perfumesMembers.map((m, i) => run({
  id: `perfumes-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'perfumes-run',
}));
const perfumesFindUrlOutput = { jobName: 'perfumes-find-url', itemKey: 'p:1', status: 'success', detail: { name: 'Aventus', url: LONG_URL } };
const perfumesFetchOutput = { jobName: 'perfumes-fetch', itemKey: 'p:1', status: 'success', detail: { name: 'Aventus', path: '/abs/data/out/raw/aventus.html', format: 'html' } };
const perfumesParseOutput = { jobName: 'perfumes-parse', itemKey: 'p:1', status: 'success', detail: { name: 'Aventus', path: '/abs/data/out/parsed/aventus.json', format: 'json' } };
const perfumesBuildOutput = { jobName: 'perfumes-build', itemKey: 'p:1', status: 'success', detail: { name: 'Aventus', markdown: '/abs/data/out/aventus.md' } };
const perfumesStageIo = {
  'perfumes-find-url': { inputs: [], outputs: [perfumesFindUrlOutput], predecessorJobs: [], job: 'perfumes-find-url' },
  'perfumes-fetch': { inputs: [perfumesFindUrlOutput], outputs: [perfumesFetchOutput], predecessorJobs: ['perfumes-find-url'], job: 'perfumes-fetch' },
  'perfumes-parse': { inputs: [perfumesFetchOutput], outputs: [perfumesParseOutput], predecessorJobs: ['perfumes-fetch'], job: 'perfumes-parse' },
  'perfumes-build': { inputs: [perfumesParseOutput], outputs: [perfumesBuildOutput], predecessorJobs: ['perfumes-parse'], job: 'perfumes-build' },
};
const perfumesStageIoOverall = {
  inputs: [perfumesFindUrlOutput], outputs: [perfumesBuildOutput],
  predecessorJobs: ['perfumes-find-url'], outputJobs: ['perfumes-build'], job: '__overall__',
};

// Map an /api/* pathname (+ optional search params) to a fixture body.
export function fixtureFor(pathname, searchParams) {
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
  if (pathname === '/api/workflow-runs/missing-movies-run') return { run: missingMoviesWorkflowRun, jobs: missingMoviesRunJobs, logs, gates: [] };
  if (pathname === '/api/workflow-runs/stocks/stage-io') {
    if (searchParams?.get('overall') === 'true') return stocksStageIoOverall;
    const job = searchParams?.get('job');
    return stocksStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/stocks') return { run: stocksWorkflowRun, jobs: stocksRunJobs, logs, gates: [] };
  if (pathname === '/api/workflow-runs/stock-digest-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return stockDigestStageIoOverall;
    const job = searchParams?.get('job');
    return stockDigestStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/stock-digest-run') return { run: stockDigestWorkflowRun, jobs: stockDigestRunJobs, logs, gates: [] };
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
  if (pathname === '/api/workflow-runs/missing-tv-seasons-run') return { run: missingTvSeasonsWorkflowRun, jobs: missingTvSeasonsRunJobs, logs, gates: [] };
  if (pathname === '/api/workflow-runs/workouts-sync-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return workoutsSyncStageIoOverall;
    const job = searchParams?.get('job');
    return workoutsSyncStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/workouts-sync-run') return { run: workoutsSyncWorkflowRun, jobs: workoutsSyncRunJobs, logs, gates: [] };
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
  if (pathname === '/api/workflow-runs/projects-sync-run') return { run: projectsSyncWorkflowRun, jobs: projectsSyncRunJobs, logs, gates: [] };
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
  if (pathname === '/api/workflow-runs/plex-language-fix-run') return { run: plexLanguageFixWorkflowRun, jobs: plexLanguageFixRunJobs, logs, gates: [] };
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
  if (pathname === '/api/workflow-runs/tv-recommendations-run') return { run: tvRecommendationsWorkflowRun, jobs: tvRecommendationsRunJobs, logs, gates: [] };
  if (pathname === '/api/workflow-runs/perfumes-run/stage-io') {
    if (searchParams?.get('overall') === 'true') return perfumesStageIoOverall;
    const job = searchParams?.get('job');
    return perfumesStageIo[job] ?? { inputs: [], outputs: [], predecessorJobs: [], job };
  }
  if (pathname === '/api/workflow-runs/perfumes-run') return { run: perfumesWorkflowRun, jobs: perfumesRunJobs, logs, gates: [] };
  if (pathname.includes('/output') && pathname.startsWith('/api/workflow-runs/')) {
    if (searchParams?.get('key') === PLACES_JSON_ITEM_KEY) return placesJsonOutputFixture;
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
    return { workflow: workflow({ name: 'plex-language-fix', category: 'regular-maintenance', jobs: plexLanguageFixMembers, gates: [] }) };
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
    return { workflow: workflow({ name: 'perfumes', category: 'second-brain', jobs: perfumesMembers, gates: [] }) };
  }
  if (pathname.endsWith('/output-items')) {
    if (pathname === '/api/workflows/places/output-items') {
      return {
        items: [
          { jobName: 'places-enrich-with-llm', itemKey: 'place:ChIJ' + LONG, name: 'A Resolved Place', hasMarkdown: true, updatedAt: NOW },
          { jobName: 'places-enrich-with-llm', itemKey: 'place:second', name: null, hasMarkdown: false, updatedAt: NOW },
          // T458: a JSON-format item (not backed by detail.markdown in real production
          // semantics — `hasMarkdown: true` here is purely a fixture convenience so the
          // synthetic "View" button renders, exercising the json OutputRenderer path).
          { jobName: 'places-enrich-with-llm', itemKey: PLACES_JSON_ITEM_KEY, name: 'Enrichment summary (JSON)', hasMarkdown: true, updatedAt: NOW },
        ],
        terminalJobs: ['places-enrich-with-llm'],
      };
    }
    return { items: [], terminalJobs: [] };
  }
  // T282: GET /api/workflows/:name/output?job=&key= — the unified Output section's
  // (not-run-scoped) artifact fetch, dispatched by the item's declared `format`
  // (T262). Reuses the same synthetic markdown body as the run-scoped fixture above.
  if (pathname.endsWith('/output') && pathname.startsWith('/api/workflows/')) {
    if (searchParams?.get('key') === PLACES_JSON_ITEM_KEY) return placesJsonOutputFixture;
    return { found: true, job: 'places-enrich-with-llm', key: 'place:ChIJ' + LONG, format: 'markdown', file: '/abs/data/out/x.md', bytes: 1234, truncated: false, content: '---\nname: A Resolved Place\n---\n\n# A Resolved Place\n\nA short synthetic profile body for the output preview popover.\n\n| Ticker | Account | Quantity |\n| --- | --- | --- |\n| AAPL | invest | 10 |\n| VUSA | isa | 5 |\n' };
  }
  if (pathname.startsWith('/api/workflows/')) return { workflow: workflow() };
  if (pathname.endsWith('/runs') && pathname.startsWith('/api/jobs/')) return { runs: [run(), run({ id: '2', status: 'failed' })] };
  if (pathname.startsWith('/api/jobs/')) return { job: job() };
  if (pathname.startsWith('/api/runs/')) return { run: run(), logs };
  if (pathname === '/api/cache') return { counts: [{ service_name: 'gemini', count: 12 }, { service_name: 'google-places', count: 4 }] };
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
  { name: 'workflow-missing-tv-seasons', path: '/workflows/missing-tv-seasons', waitFor: ['.rf-dag-node'] },
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
  { name: 'gate-run-scoped',         path: '/workflow-runs/1/gates/places-resolve/resolved.json' },
  { name: 'gate-definition-scoped',  path: '/workflows/places/gates/places-resolve/resolved.json' },
  { name: 'job',                     path: '/jobs/places-enrich' },
  { name: 'run',                     path: '/runs/1' },
  { name: 'services',                path: '/integrations' },
  { name: 'logs',                    path: '/logs' },
  { name: 'admin',                   path: '/admin' },
  { name: 'admin-cache',              path: '/admin-cache' },
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
      await page.click('.io-job-filter-chip:text-is("stock-portfolio-snapshot")');
      await page.waitForTimeout(400);
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
    // T387: movie-recommendations is a PARALLEL FAN-OUT — 8 rec-* branches all depend on
    // the SAME movie-snapshot predecessor. Clicking one branch's chip (rec-auteur) must
    // show ONLY its own input (the shared snapshot) and its own single output — not any
    // sibling branch's rows.
    name: 'stage-io-fan-out-branch-auteur',
    path: '/workflow-runs/movie-recs-run',
    waitFor: ['.io-job-filter-bar'],
    actions: async (page) => {
      await page.click('.io-job-filter-chip:text-is("rec-auteur")');
      await page.waitForTimeout(400);
    },
  },
  {
    // T387: same fan-out, a DIFFERENT sibling branch (rec-canon) — the screenshot should
    // visibly differ from rec-auteur's (a different single output row), proving branches
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
    // T387: stocks-sync's `outputJob` override (T348/T384) — confirms the "Overall" tab
    // (StageIoPanel's default) shows stocks-snapshot's ledger rows as Outputs, not an
    // empty result from the true terminal stocks-notify. This is also the PAGES baseline
    // for /workflow-runs/stocks, captured again explicitly here for clarity.
    name: 'stage-io-outputjob-override-overall',
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
