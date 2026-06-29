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
  enabled: 1, created_at: NOW, last_run: workflowRun(), next_run: NOW, jobs: members,
  stuck: 2, runs: [workflowRun(), workflowRun({ id: '2', status: 'partial' })], ...over,
});

const service = (over) => ({
  name: 'google-places', description: 'Google Places API — ' + LONG, rate_per_minute: 60,
  daily_cap: 100, monthly_cap: 3000, paid: 1, limits_overridden: 1,
  used_today: 42, used_month: 1234, rate_last_min: 12, ...over,
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

const gates = [
  { key: 'resolved.json', producer: 'places-resolve', consumer: 'places-enrich', state: 'passed', description: 'produces — resolved.json is a non-empty array of place_ids · consumes — every row has a place_id' },
  { key: 'enriched.json', producer: 'places-enrich', consumer: 'places-enrich-with-llm', state: 'failed', failureRunId: '1', description: 'produces — enriched.json has name + address fields' },
];

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

const tasks = [
  { id: 'T040', title: 'Mobile dashboard styling pass — ' + LONG, status: 'pending', gate: null,
    dependsOn: ['T001', 'T002', 'T003'], tags: ['dashboard', 'ui', 'testing'], model: 'claude-opus-4-8',
    effort: 'high', do: 'Make the dashboard responsive on mobile. ' + LONG, doneWhen: 'It passes. ' + LONG },
  { id: 'T099', title: 'A human-gated task', status: 'pending', gate: 'needs-human', dependsOn: [],
    tags: ['infra'], do: 'Do a thing a human must do. ' + LONG, doneWhen: 'A human did it.' },
  // A done task (exercises the "Mark failed" button) and a done task already marked
  // failed (exercises the red "failed" pill + "Undo fail" button) — manual-fail-signal.
  { id: 'T050', title: 'A finished task — ' + LONG, status: 'done', gate: null, dependsOn: [],
    tags: ['ui'], reviewed: true },
  { id: 'T051', title: 'A finished task the owner marked failed', status: 'done', gate: null,
    dependsOn: [], tags: ['ui'], reviewed: true, failed: true, failReason: 'padlock never renders on the DAG' },
];

// Map an /api/* pathname to a fixture body.
export function fixtureFor(pathname) {
  if (pathname === '/api/stuck') return { stuck: [stuckItem(), stuckItem({ item_key: LONG + '-2' })] };
  if (pathname === '/api/ignored') return { ignored: [stuckItem({ item_key: LONG + '-ign' })] };
  if (pathname === '/api/workflows') return { workflows: [workflow(), workflow({ name: 'perfumes' })] };
  if (pathname === '/api/workflow-runs') return { runs: [workflowRun(), workflowRun({ id: '2', status: 'failed' })] };
  // Sub-routes must precede the generic `/api/workflow-runs/<id>` catch-all below.
  if (pathname.endsWith('/io') && pathname.startsWith('/api/workflow-runs/')) return workflowIo;
  if (pathname.includes('/output') && pathname.startsWith('/api/workflow-runs/')) return { found: true, job: 'places-enrich-with-llm', key: 'place:x', file: '/abs/data/out/x.md', bytes: 1234, truncated: false, content: '---\nname: A Resolved Place\n---\n\n# A Resolved Place\n\nA short synthetic profile body for the output preview popover.' };
  if (pathname.startsWith('/api/workflow-runs/')) return { run: workflowRun(), jobs: [run(), run({ id: '2', job_name: 'places-enrich', status: 'failed' })], logs, gates };
  if (pathname.startsWith('/api/workflows/')) return { workflow: workflow() };
  if (pathname.endsWith('/runs') && pathname.startsWith('/api/jobs/')) return { runs: [run(), run({ id: '2', status: 'failed' })] };
  if (pathname.startsWith('/api/jobs/')) return { job: job() };
  if (pathname.startsWith('/api/runs/')) return { run: run(), logs };
  if (pathname === '/api/services') return { services: [service(), service({ name: 'gemini', paid: 1 }), service({ name: 'fragrantica', paid: 0, daily_cap: null, monthly_cap: null })] };
  if (pathname === '/api/backlog') return { tasks };
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
  { name: 'overview',      path: '/' },
  { name: 'workflows',     path: '/workflows' },
  { name: 'workflow',      path: '/workflows/places',  waitFor: ['.rf-dag-node'] },
  { name: 'workflow-run',  path: '/workflow-runs/1',   waitFor: ['.rf-dag-node'] },
  { name: 'job',           path: '/jobs/places-enrich' },
  { name: 'run',           path: '/runs/1' },
  { name: 'services',      path: '/services' },
  { name: 'backlog',       path: '/backlog' },
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
    // The 🎨 theme/font/mode picker popover, opened from the header.
    name: 'overview-theme-picker',
    path: '/',
    actions: async (page) => {
      await page.click('.theme-trigger');
      await page.waitForSelector('.theme-modal', { state: 'visible', timeout: 5000 });
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

/** Pre-seed the dashboard's theme/font/mode/motion localStorage keys BEFORE first
 *  paint, so a screenshot can be taken in a deterministic theme. The pre-paint inline
 *  script in dashboard/app/layout.tsx reads these keys and sets the `data-*` html
 *  attributes. Omitted keys are left unset (the dashboard falls back to its defaults:
 *  default theme, system mode, system font, OS reduced-motion). */
export async function seedTheme(ctx, { theme, mode, font, motion } = {}) {
  await ctx.addInitScript(
    ([t, m, f, mo]) => {
      try {
        const L = window.localStorage;
        if (t) L.setItem('localjobs.theme', t);
        if (m) L.setItem('localjobs.mode', m);
        if (f) L.setItem('localjobs.font', f);
        if (mo) L.setItem('localjobs.motion', mo);
      } catch { /* ignore */ }
    },
    [theme, mode, font, motion],
  );
}
