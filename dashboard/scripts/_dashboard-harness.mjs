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
            debugFile: '/Users/x/Development/local-jobs/src/jobs/perfumes/data/debug/' + LONG + '.html',
            finalUrl: LONG_URL, textLength: 1234, httpStatus: 403 },
  updated_at: NOW, ...over,
});

const workflow = (over) => ({
  name: 'places', description: 'A worked-example workflow: ' + LONG, schedule: '0 3 * * 1-5',
  category: 'second-brain',
  enabled: 1, effective_notify_enabled: true, created_at: NOW, last_run: workflowRun(), next_run: NOW, jobs: members,
  stuck: 2, runs: [workflowRun(), workflowRun({ id: '2', status: 'partial' })],
  gates: structuralGates, ...over,
});

const service = (over) => ({
  name: 'google-places', description: 'Google Places API — ' + LONG, category: 'api', rate_per_minute: 60,
  daily_cap: 100, monthly_cap: 3000, paid: 1, limits_overridden: 1,
  used_today: 42, used_month: 123456, rate_last_min: 12, ...over,
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

// Input → Output mapping rows for a workflow run (the IoPanel on the run detail page).
// A places-style fan-out: a CID input resolves to a place_id whose terminal stage
// produces a markdown profile. Exercises the markdown-output "View" affordance.
const ioRow = (over) => ({
  inputJob: 'places-resolve', inputKey: 'cid:' + LONG, inputStatus: 'success',
  inputDetail: { name: 'A Resolved Place With A Long Name' },
  outputJob: 'places-enrich-with-llm', outputKey: 'place:ChIJ' + LONG, outputStatus: 'success',
  outputDetail: { name: 'A Resolved Place With A Long Name', markdown: '/abs/data/out/' + LONG + '.md' },
  ...over,
});
const workflowIo = {
  io: [
    ioRow(),
    ioRow({ inputKey: 'cid:second-place', outputKey: 'place:second', outputStatus: 'failed',
            outputDetail: { name: 'A Place That Failed Enrichment' } }),
    ioRow({ inputKey: 'cid:third-place', inputStatus: 'failed', outputJob: null, outputKey: null,
            outputStatus: null, outputDetail: null, inputDetail: { name: 'A Place That Failed To Resolve' } }),
  ],
  firstWave: ['places-resolve'],
  lastWave: ['places-enrich-with-llm'],
  scoped: true,
  emptyReason: null,
  note: '',
  selectedJob: null,
  scopedProducerJobs: [],
  scopedConsumerJobs: [],
};

// Job-scoped IO view (T314): `?job=places-enrich` re-scopes the mapping to that ONE
// stage's own pairing (input = its predecessor's ledger row, output = its own ledger
// row) — deliberately DIFFERENT rows/statuses from `workflowIo` above so a screenshot
// visibly differs when a job pill is selected.
const workflowIoScopedToEnrich = {
  io: [
    ioRow({ outputJob: 'places-enrich', outputKey: 'place:ChIJ' + LONG, outputStatus: 'success',
            outputDetail: { name: 'A Resolved Place With A Long Name — enriched fields only' } }),
    ioRow({ inputKey: 'cid:second-place', outputJob: 'places-enrich', outputKey: 'place:second',
            outputStatus: 'success', outputDetail: { name: 'A Place Successfully Enriched (not yet LLM-summarized)' } }),
    ioRow({ inputKey: 'cid:fourth-place', outputJob: 'places-enrich', outputKey: 'place:fourth',
            outputStatus: 'failed', outputDetail: { name: 'Enrichment failed for this place' } }),
  ],
  firstWave: ['places-resolve'],
  lastWave: ['places-enrich-with-llm'],
  scoped: true,
  emptyReason: null,
  note: '',
  selectedJob: 'places-enrich',
  scopedProducerJobs: ['places-resolve'],
  scopedConsumerJobs: ['places-enrich'],
};

// A run/stage that did no work (T258 noop detection) — settles 'skipped' instead of
// 'success' so the dashboard reads "nothing to do", not a misleading green success.
// Exercises T281's distinct skipped pill/label + the IO panel's "processed no new
// items" empty state (no rows freshly shown as succeeded).
const workflowRunSkipped = workflowRun({
  id: 'skipped', status: 'skipped', progress: 100, progress_msg: 'nothing to do',
});
const membersSkipped = members.map((m, i) => run({
  id: `skipped-${i}`, job_name: m.job_name, status: 'skipped', workflow_run_id: 'skipped',
}));
const workflowIoSkipped = {
  io: [], firstWave: ['places-resolve'], lastWave: ['places-enrich-with-llm'],
  scoped: true, emptyReason: null, note: '',
  selectedJob: null, scopedProducerJobs: [], scopedConsumerJobs: [],
};

// T350: a stocks-sync-shaped IO row — `detail.currentPrice`/`detail.averageBuyPrice`
// (no `markdown`), landing on the INPUT side since `stocks-snapshot` is the DAG's first
// wave. Exercises the generic price-pair rendering in the IO panel (distinct from every
// other fixture above, which is places-shaped `{ name, markdown }`).
const stocksMembers = [
  { job_name: 'stocks-snapshot', depends_on: [] },
  { job_name: 'stocks-watch', depends_on: ['stocks-snapshot'] },
  { job_name: 'stocks-notify', depends_on: ['stocks-watch'] },
];
const stocksWorkflowRun = workflowRun({ id: 'stocks', workflow_name: 'stocks-sync' });
const stocksRunJobs = stocksMembers.map((m, i) => run({
  id: `stocks-${i}`, job_name: m.job_name, status: 'success', workflow_run_id: 'stocks',
}));
const workflowIoStocks = {
  io: [
    ioRow({
      inputJob: 'stocks-snapshot', inputKey: 'invest:AAPL', inputStatus: 'success',
      inputDetail: { name: 'AAPL', currentPrice: 198.32, averageBuyPrice: 150.0 },
      outputJob: 'stocks-notify', outputKey: 'invest:AAPL', outputStatus: 'success',
      outputDetail: null,
    }),
    ioRow({
      inputJob: 'stocks-snapshot', inputKey: 'isa:VUSA', inputStatus: 'success',
      inputDetail: { name: 'VUSA', currentPrice: 82.1, averageBuyPrice: 90.5 },
      outputJob: 'stocks-notify', outputKey: 'isa:VUSA', outputStatus: 'success',
      outputDetail: null,
    }),
  ],
  firstWave: ['stocks-snapshot'],
  lastWave: ['stocks-notify'],
  scoped: true,
  emptyReason: null,
  note: '',
  selectedJob: null,
  scopedProducerJobs: [],
  scopedConsumerJobs: [],
};

const tasks = [
  // T001 is a standalone ready pending task (no longer anyone's dependency) — a valid "Ready" example
  // with no unmet deps at all (shows the "🤖 buildable" pill, not a "needs:" pill).
  // T294: T001 also carries prior build-attempt failure history, exercising the amber
  // "⚠ N failed attempt(s)" pill alongside the "🤖 buildable" pill in the Ready section.
  { id: 'T001', title: 'Foundation task — ' + LONG, status: 'pending', gate: null, dependsOn: [],
    tags: ['infra'], do: 'Set up the thing. ' + LONG, doneWhen: 'It is set up.',
    buildFailures: { count: 2, latestKind: 'agent-blocked', latestDetail: 'scope excludes a needed file', latestAt: '2026-06-30T12:00:00Z' } },
  // T002 depends on T001 (buildable, unmet, non-human) — T293 follow-up to T283: a task blocked
  // solely by an ordinary buildable dependency now shows in READY (not hidden), with a "needs: T001"
  // pill instead of the "🤖 buildable" pill.
  { id: 'T002', title: 'Depends on a buildable task — ' + LONG, status: 'pending', gate: null,
    dependsOn: ['T001'], tags: ['infra'], do: 'Build on top of the foundation. ' + LONG, doneWhen: 'Done.' },
  // T098 is a needs-human blocker — T040 depends on it (unmet + human-gated) so T040 appears in
  // Waiting with a "needs:" pill pointing only at T098.
  { id: 'T098', title: 'A human-gated blocker', status: 'pending', gate: 'needs-human', dependsOn: [],
    tags: ['infra'], do: 'Do a thing a human must do. ' + LONG, doneWhen: 'A human did it.' },
  // T040 depends on T098 (unmet + human-gated, → Waiting section pill) AND T050 (done, → expanded-body
  // dep link). This exercises both pill dep-click (T098) and cross-section dep navigation (T050 in Done).
  { id: 'T040', title: 'Mobile dashboard styling pass — ' + LONG, status: 'pending', gate: null,
    dependsOn: ['T098', 'T050'], tags: ['dashboard', 'ui', 'testing'], model: 'claude-opus-4-8',
    effort: 'high', do: 'Make the dashboard responsive on mobile. ' + LONG, doneWhen: 'It passes. ' + LONG },
  // T041 depends ONLY on T040 (gate:null, not itself human-gated) — but T040 is transitively blocked
  // by T098. Exercises the TRANSITIVE walk: T041 must land in Waiting (not Ready) with its "needs:"
  // pill pointing at T098 (the actual upstream human blocker), not T040 (its direct, non-human dep).
  { id: 'T041', title: 'Transitively blocked by a human gate — ' + LONG, status: 'pending', gate: null,
    dependsOn: ['T040'], tags: ['dashboard'], do: 'Depends on T040. ' + LONG, doneWhen: 'Done.' },
  { id: 'T099', title: 'A human-gated task', status: 'pending', gate: 'needs-human', dependsOn: [],
    tags: ['infra'], do: 'Do a thing a human must do. ' + LONG, doneWhen: 'A human did it.' },
  // A done task (exercises the "Mark failed" button) and a done task already marked
  // failed (exercises the red "failed" pill + "Undo fail" button) — manual-fail-signal.
  // T050 is intentionally a dep target from T040 above, exercising cross-section dep navigation.
  { id: 'T050', title: 'A finished task — ' + LONG, status: 'done', gate: null, dependsOn: [],
    tags: ['ui'], reviewed: true },
  { id: 'T051', title: 'A finished task the owner marked failed', status: 'failed', gate: null,
    dependsOn: [], tags: ['ui'], reviewed: true, failed: true, failReason: 'padlock never renders on the DAG' },
];

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
  ],
};

// T332: the real movie-recommendations 9-node fan-out (movie-snapshot → 8 rec-* branches +
// franchise-gaps → rec-merge → movie-gaps-notify — see src/jobs/movies/movies.workflow.ts).
// Modeled as a RUN-scoped view (statusByJob + gates populated, mirroring a completed run) so
// visual-check can actually reproduce/confirm the run-view-only rec-auteur/franchise-gaps
// spacing bug (T332), which never showed up under the generic 3-node `workflowRun`/`gates`
// fixture the `workflow-run` PAGES entry uses.
const movieRecsMembers = [
  { job_name: 'movie-snapshot', depends_on: [] },
  { job_name: 'franchise-gaps', depends_on: ['movie-snapshot'] },
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
  { job_name: 'movie-gaps-notify', depends_on: ['franchise-gaps', 'rec-merge'] },
];
const movieRecsWorkflowRun = workflowRun({ id: 'movie-recs-run', workflow_name: 'movie-recommendations' });
const movieRecsStatusByJob = Object.fromEntries(movieRecsMembers.map((m) => [m.job_name, 'success']));
const movieRecsRunIdByJob = Object.fromEntries(movieRecsMembers.map((m) => [m.job_name, 'movie-recs-run']));
// One passed gate per movie-snapshot → wave-1 node edge (the movieSnapshotContract gate every
// franchise-gaps AND rec-* branch consumes), plus the rec-merge/notify boundaries.
const movieRecsGates = [
  ...movieRecsMembers.filter((m) => m.depends_on.includes('movie-snapshot')).map((m) => ({
    key: 'snapshot.json', producer: 'movie-snapshot', consumer: m.job_name, state: 'passed',
    description: 'produces — snapshot.json is a non-empty per-movie library snapshot · consumes — every branch reads the same snapshot',
  })),
  { key: 'gaps.json', producer: 'franchise-gaps', consumer: 'movie-gaps-notify', state: 'passed', description: 'produces — franchise gap candidates · consumes — the notify stage reads them' },
  { key: 'recommendations.json', producer: 'rec-merge', consumer: 'movie-gaps-notify', state: 'passed', description: 'produces — merged, TMDB-verified recommendations · consumes — the notify stage reads them' },
];
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

// Map an /api/* pathname (+ optional search params) to a fixture body.
export function fixtureFor(pathname, searchParams) {
  if (pathname === '/api/stuck') return { stuck: [stuckItem(), stuckItem({ item_key: LONG + '-2' })] };
  if (pathname === '/api/ignored') return { ignored: [stuckItem({ item_key: LONG + '-ign' })] };
  if (pathname === '/api/workflows') return { workflows: [
    workflow(),
    workflow({ name: 'perfumes', enabled: 0, effective_notify_enabled: false }),
    workflow({ name: 'movie-recommendations', category: 'recommendations', stuck: 0 }),
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
  if (pathname === '/api/workflow-runs/skipped/io') return workflowIoSkipped;
  if (pathname === '/api/workflow-runs/skipped') return { run: workflowRunSkipped, jobs: membersSkipped, logs, gates: [] };
  if (pathname === '/api/workflow-runs/movie-recs-run/io') return workflowIoSkipped;
  if (pathname === '/api/workflow-runs/movie-recs-run') return { run: movieRecsWorkflowRun, jobs: movieRecsRunJobs, logs, gates: movieRecsGates };
  if (pathname === '/api/workflow-runs/stocks/io') return workflowIoStocks;
  if (pathname === '/api/workflow-runs/stocks') return { run: stocksWorkflowRun, jobs: stocksRunJobs, logs, gates: [] };
  if (pathname.endsWith('/io') && pathname.startsWith('/api/workflow-runs/')) {
    const job = searchParams?.get('job');
    if (job === 'places-enrich') return workflowIoScopedToEnrich;
    return workflowIo;
  }
  if (pathname.includes('/output') && pathname.startsWith('/api/workflow-runs/')) return { found: true, job: 'places-enrich-with-llm', key: 'place:x', file: '/abs/data/out/x.md', bytes: 1234, truncated: false, content: '---\nname: A Resolved Place\n---\n\n# A Resolved Place\n\nA short synthetic profile body for the output preview popover.\n\n| Ticker | Account | Quantity |\n| --- | --- | --- |\n| AAPL | invest | 10 |\n| VUSA | isa | 5 |\n' };
  if (pathname.startsWith('/api/workflow-runs/')) return { run: workflowRun(), jobs: [run(), run({ id: '2', job_name: 'places-enrich', status: 'failed' })], logs, gates };
  if (pathname === '/api/workflows/movie-recommendations') {
    return { workflow: workflow({ name: 'movie-recommendations', category: 'recommendations', jobs: movieRecsMembers, gates: [] }) };
  }
  if (pathname === '/api/workflows/stocks-sync') {
    return { workflow: workflow({ name: 'stocks-sync', category: 'regular-maintenance', jobs: stocksMembers, gates: [] }) };
  }
  if (pathname.endsWith('/output-items')) {
    if (pathname === '/api/workflows/places/output-items') {
      return {
        items: [
          { jobName: 'places-enrich-with-llm', itemKey: 'place:ChIJ' + LONG, name: 'A Resolved Place', hasMarkdown: true, updatedAt: NOW },
          { jobName: 'places-enrich-with-llm', itemKey: 'place:second', name: null, hasMarkdown: false, updatedAt: NOW },
        ],
        terminalJobs: ['places-enrich-with-llm'],
      };
    }
    return { items: [], terminalJobs: [] };
  }
  if (pathname.startsWith('/api/workflows/')) return { workflow: workflow() };
  if (pathname.endsWith('/runs') && pathname.startsWith('/api/jobs/')) return { runs: [run(), run({ id: '2', status: 'failed' })] };
  if (pathname.startsWith('/api/jobs/')) return { job: job() };
  if (pathname.startsWith('/api/runs/')) return { run: run(), logs };
  if (pathname === '/api/services') return { services: [service(), service({ name: 'gemini', paid: 1 }), service({ name: 'fragrantica', category: 'website-scrape', paid: 0, daily_cap: null, monthly_cap: null }), service({ name: 'claude-cli', category: 'cli-tool', paid: 0, rate_per_minute: null, daily_cap: null, monthly_cap: null }), service({ name: 'legacy-service', category: 'uncategorized', paid: 0, rate_per_minute: null, daily_cap: null, monthly_cap: null })] };
  if (pathname.startsWith('/api/services/') && pathname.endsWith('/consumers')) return { consumers: [{ workflow_name: 'places', jobs: [{ job_name: 'places-enrich', last_used: NOW }, { job_name: 'places-enrich-with-llm', last_used: NOW }] }, { workflow_name: 'perfumes', jobs: [{ job_name: 'perfumes-build', last_used: NOW }] }] };
  if (pathname === '/api/backlog') return { tasks };
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
  { name: 'workflow-empty-output',   path: '/workflows/workouts-sync',         waitFor: ['.rf-dag-node'] },
  { name: 'workflow-tv-recs',        path: '/workflows/tv-recommendations',    waitFor: ['.rf-dag-node'] },
  { name: 'workflow-missing-tv-seasons', path: '/workflows/missing-tv-seasons', waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run',            path: '/workflow-runs/1',                waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-movie-recs', path: '/workflow-runs/movie-recs-run',   waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-skipped',    path: '/workflow-runs/skipped',          waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-stocks-io',  path: '/workflow-runs/stocks',           waitFor: ['.rf-dag-node'] },
  { name: 'gate-run-scoped',         path: '/workflow-runs/1/gates/places-resolve/resolved.json' },
  { name: 'gate-definition-scoped',  path: '/workflows/places/gates/places-resolve/resolved.json' },
  { name: 'job',                     path: '/jobs/places-enrich' },
  { name: 'run',                     path: '/runs/1' },
  { name: 'services',                path: '/integrations' },
  { name: 'backlog',                 path: '/backlog' },
  { name: 'logs',                    path: '/logs' },
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
    // T360: confirms react-markdown + remark-gfm actually renders a GFM pipe
    // table as a real <table>, not raw `| a | b |` text — the bug this fixes.
    name: 'workflow-run-output-table',
    path: '/workflow-runs/1',
    viewport: true,
    waitFor: ['.out-meta-link'],
    actions: async (page) => {
      await page.click('.out-meta-link');
      await page.waitForSelector('.db-modal', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('.md-body table', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);
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
    // The Backlog "Done" section is collapsed by default — expand every <details> so the
    // done rows (and their reviewed/done/failed chips + buttons) are visible.
    name: 'backlog-expanded',
    path: '/backlog',
    actions: async (page) => {
      await page.evaluate(() =>
        document.querySelectorAll('details:not([open])').forEach((d) => d.setAttribute('open', '')),
      );
    },
  },
  {
    // Clickable dep ids — two interactions:
    // 1. Click T098 link in T040's "needs:" pill (Waiting section) → scrolls to T098 in Needs a human.
    // 2. Expand T040 and click T050 in its "depends on:" body line → Done section opens + T050 expands.
    name: 'backlog-dep-click',
    path: '/backlog',
    settleMs: 1200,
    actions: async (page) => {
      // Step 1: click T098 in the Waiting-section pill — T098 is in Needs a human (already open via
      // <details open>), should expand.
      await page.waitForSelector('.dep-id-link', { state: 'visible', timeout: 5000 });
      await page.click('.dep-id-link:has-text("T098")');
      await page.waitForSelector('#task-T098', { state: 'visible', timeout: 3000 });
      await page.waitForTimeout(300);

      // Step 2: expand T040 (click on its row) to reveal the "depends on:" body with T050 link.
      await page.click('#task-T040 .done-row');
      await page.waitForSelector('#task-T040 .task-expand-body', { state: 'visible', timeout: 3000 });

      // Step 3: click T050 dep link in the body → Done section (collapsed) should open + T050 highlighted.
      await page.click('#task-T040 .dep-id-link:has-text("T050")');
      await page.waitForSelector('#task-T050', { state: 'visible', timeout: 3000 });
      await page.waitForTimeout(500);
    },
  },
  {
    // The "Consumers of …" modal, opened by clicking a service name on the Services page.
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
    // T314: clicking a per-stage job pill on the workflow-run IO panel re-fetches
    // (server-side, via ?job=) that ONE stage's own input→output pairing, relabels
    // the column headers, and resets the state-filter pills back to 'all'.
    name: 'io-panel-job-scoped',
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
    // T329: the workflow-run IoPanel table headers are now sortable — click the
    // "State" header to sort the currently-filtered rows and show the ▲/▼ marker.
    name: 'io-panel-sorted-by-state',
    path: '/workflow-runs/1',
    waitFor: ['table th.sort-th'],
    actions: async (page) => {
      await page.click('table th.sort-th:has-text("State")');
      await page.waitForSelector('table th.sort-th-active', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(200);
    },
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
