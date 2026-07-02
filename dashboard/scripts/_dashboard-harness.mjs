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

const movieRecs = {
  generatedAt: NOW, pooled: 12,
  recommendations: [
    rec({ tmdbId: 100, title: 'Inception', year: 2010, lens: 'cerebral', genre: 'Science Fiction', tmdbRating: 8.4 }),
    rec({ tmdbId: 101, title: 'Arrival', year: 2016, lens: 'cerebral', genre: 'Science Fiction', tmdbRating: 7.9 }),
    rec({ tmdbId: 102, title: 'Parasite', year: 2019, lens: 'serendipity', genre: 'Drama', tmdbRating: 8.5, notified: true }),
    rec({ tmdbId: 103, title: 'Mad Max: Fury Road', year: 2015, lens: 'high-octane', genre: 'Action', tmdbRating: 7.8 }),
    rec({ tmdbId: 200, title: 'An Ignored Film', year: 2000, lens: 'serendipity', genre: 'Drama', tmdbRating: 6.0, ignored: true }),
  ],
};

const tvRecs = {
  generatedAt: NOW, pooled: 8,
  recommendations: [
    { tmdbId: 300, title: 'Severance', year: 2022, reason: 'Workplace thriller.', lens: 'cerebral', genre: 'Drama', tmdbRating: 8.7, notified: false, ignored: false },
    { tmdbId: 301, title: 'The Bear', year: 2022, reason: 'Intense kitchen drama.', lens: 'serendipity', genre: 'Drama', tmdbRating: 8.6, notified: true, ignored: false },
    { tmdbId: 302, title: 'Dark', year: 2017, reason: 'Mind-bending time travel.', lens: 'cerebral', genre: 'Science Fiction', tmdbRating: 8.8, notified: false, ignored: false },
    { tmdbId: 400, title: 'An Ignored Show', year: 2010, reason: 'Not interested.', lens: 'serendipity', genre: 'Comedy', tmdbRating: 5.5, notified: false, ignored: true },
  ],
};

// Map an /api/* pathname to a fixture body.
export function fixtureFor(pathname) {
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
  if (pathname === '/api/movie-gaps') return { generatedAt: NOW, gaps: [], collectionsChecked: 0, collectionExamples: {} };
  // Sub-routes must precede the generic `/api/workflow-runs/<id>` catch-all below.
  if (pathname.includes('/gates/') && pathname.startsWith('/api/workflow-runs/')) return gateInspection;
  if (pathname.includes('/gates/') && pathname.startsWith('/api/workflows/')) return structuralGateDetail;
  if (pathname === '/api/workflow-runs/skipped/io') return workflowIoSkipped;
  if (pathname === '/api/workflow-runs/skipped') return { run: workflowRunSkipped, jobs: membersSkipped, logs, gates: [] };
  if (pathname.endsWith('/io') && pathname.startsWith('/api/workflow-runs/')) return workflowIo;
  if (pathname.includes('/output') && pathname.startsWith('/api/workflow-runs/')) return { found: true, job: 'places-enrich-with-llm', key: 'place:x', file: '/abs/data/out/x.md', bytes: 1234, truncated: false, content: '---\nname: A Resolved Place\n---\n\n# A Resolved Place\n\nA short synthetic profile body for the output preview popover.' };
  if (pathname.startsWith('/api/workflow-runs/')) return { run: workflowRun(), jobs: [run(), run({ id: '2', job_name: 'places-enrich', status: 'failed' })], logs, gates };
  if (pathname.startsWith('/api/workflows/')) return { workflow: workflow() };
  if (pathname.endsWith('/runs') && pathname.startsWith('/api/jobs/')) return { runs: [run(), run({ id: '2', status: 'failed' })] };
  if (pathname.startsWith('/api/jobs/')) return { job: job() };
  if (pathname.startsWith('/api/runs/')) return { run: run(), logs };
  if (pathname === '/api/services') return { services: [service(), service({ name: 'gemini', paid: 1 }), service({ name: 'fragrantica', category: 'website-scrape', paid: 0, daily_cap: null, monthly_cap: null }), service({ name: 'claude-cli', category: 'cli-tool', paid: 0, rate_per_minute: null, daily_cap: null, monthly_cap: null }), service({ name: 'legacy-service', category: 'uncategorized', paid: 0, rate_per_minute: null, daily_cap: null, monthly_cap: null })] };
  if (pathname.startsWith('/api/services/') && pathname.endsWith('/consumers')) return { consumers: [{ workflow_name: 'places', jobs: [{ job_name: 'places-enrich', last_used: NOW }, { job_name: 'places-enrich-with-llm', last_used: NOW }] }, { workflow_name: 'perfumes', jobs: [{ job_name: 'perfumes-build', last_used: NOW }] }] };
  if (pathname === '/api/backlog') return { tasks };
  if (pathname === '/api/logs') return {
    logs: [
      { id: 6, ts: NOW, level: 'error', message: 'Places API returned 429 — quota exceeded for the day', source: 'job', jobName: 'places-enrich', workflowName: null, runId: '1', workflowRunId: null },
      { id: 5, ts: NOW, level: 'warn', message: 'Gate check found 2 rows missing an expected field', source: 'workflow', jobName: null, workflowName: 'places', runId: null, workflowRunId: '1' },
      { id: 4, ts: NOW, level: 'info', message: 'Resolved place_id for CID 12345', source: 'job', jobName: 'places-resolve', workflowName: null, runId: '1', workflowRunId: null },
      { id: 3, ts: NOW, level: 'error', message: 'TMDB lookup failed for tmdbId 300 — connection reset', source: 'job', jobName: 'tv-rec-merge', workflowName: null, runId: '2', workflowRunId: null },
      { id: 2, ts: NOW, level: 'info', message: 'Workflow run started (trigger: schedule)', source: 'workflow', jobName: null, workflowName: 'movie-recommendations', runId: null, workflowRunId: '2' },
      { id: 1, ts: NOW, level: 'warn', message: 'Service quota at 80% of monthly cap', source: 'job', jobName: 'places-enrich-with-llm', workflowName: null, runId: '1', workflowRunId: null },
    ],
    nextCursor: null,
  };
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
  { name: 'workflow-tv-recs',        path: '/workflows/tv-recommendations',    waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run',            path: '/workflow-runs/1',                waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run-skipped',    path: '/workflow-runs/skipped',          waitFor: ['.rf-dag-node'] },
  { name: 'gate-run-scoped',         path: '/workflow-runs/1/gates/places-resolve/resolved.json' },
  { name: 'gate-definition-scoped',  path: '/workflows/places/gates/places-resolve/resolved.json' },
  { name: 'job',                     path: '/jobs/places-enrich' },
  { name: 'run',                     path: '/runs/1' },
  { name: 'services',                path: '/services' },
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
    // Logs page with the 'Errors only' quick-toggle active — shows the level filter
    // narrowed to just error-level lines.
    name: 'logs-errors-only',
    path: '/logs',
    actions: async (page) => {
      await page.click('button:has-text("Errors only")');
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
    path: '/services',
    viewport: true,
    actions: async (page) => {
      // Click the first service button to open the consumers modal.
      await page.click('button.btn.secondary:has-text("google-places")');
      await page.waitForSelector('.db-modal', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);
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
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtureFor(url.pathname)) });
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
