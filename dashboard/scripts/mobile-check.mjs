// Mobile responsive check for the dashboard.
//
// Loads every dashboard page in a headless Chromium at an iPhone-17-class viewport
// (402px wide) and asserts basic mobile styling holds:
//   1. no horizontal overflow      — document does not scroll sideways
//   2. no text crossing boundaries — no element with `overflow-x: visible`
//      has content wider than its own box (i.e. nothing spills its container)
//
// It is hermetic: it starts a production `next start` of the dashboard and serves
// every `/api/*` request from synthetic in-process fixtures (Playwright route
// interception), so NO daemon, NO real SQLite, and NO paid API calls are touched.
// The fixtures deliberately include long, adversarial strings (long cron, long
// URLs, long item keys, long errors) to stress the layout.
//
// This is a LOCAL dev check — it is NOT part of CI and not a unit test. Run with:
//   node dashboard/scripts/mobile-check.mjs
// Exits non-zero if any page fails an assertion.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = resolve(__dirname, '..');
const PORT = Number(process.env.MOBILE_CHECK_PORT ?? 4799);
const BASE = `http://localhost:${PORT}`;
const VIEWPORT = { width: 402, height: 874 }; // iPhone-17-class logical width

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

const tasks = [
  { id: 'T040', title: 'Mobile dashboard styling pass — ' + LONG, status: 'pending', gate: null,
    dependsOn: ['T001', 'T002', 'T003'], tags: ['dashboard', 'ui', 'testing'], model: 'claude-opus-4-8',
    effort: 'high', do: 'Make the dashboard responsive on mobile. ' + LONG, doneWhen: 'It passes. ' + LONG },
  { id: 'T099', title: 'A human-gated task', status: 'pending', gate: 'needs-human', dependsOn: [],
    tags: ['infra'], do: 'Do a thing a human must do. ' + LONG, doneWhen: 'A human did it.' },
];

// Map an /api/* pathname to a fixture body.
function fixtureFor(pathname) {
  if (pathname === '/api/stuck') return { stuck: [stuckItem(), stuckItem({ item_key: LONG + '-2' })] };
  if (pathname === '/api/ignored') return { ignored: [stuckItem({ item_key: LONG + '-ign' })] };
  if (pathname === '/api/workflows') return { workflows: [workflow(), workflow({ name: 'perfumes' })] };
  if (pathname === '/api/workflow-runs') return { runs: [workflowRun(), workflowRun({ id: '2', status: 'failed' })] };
  if (pathname.startsWith('/api/workflow-runs/')) return { run: workflowRun(), jobs: [run(), run({ id: '2', job_name: 'places-enrich', status: 'failed' })], logs, gates };
  if (pathname.startsWith('/api/workflows/')) return { workflow: workflow() };
  if (pathname.endsWith('/runs') && pathname.startsWith('/api/jobs/')) return { runs: [run(), run({ id: '2', status: 'failed' })] };
  if (pathname.startsWith('/api/jobs/')) return { job: job() };
  if (pathname.startsWith('/api/runs/')) return { run: run(), logs };
  if (pathname === '/api/services') return { services: [service(), service({ name: 'gemini', paid: 1 }), service({ name: 'fragrantica', paid: 0, daily_cap: null, monthly_cap: null })] };
  if (pathname === '/api/backlog') return { tasks };
  return {};
}

// ── In-browser measurement ──────────────────────────────────────────────────
function measure() {
  const vw = window.innerWidth;
  const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // Content spilling its OWN box while overflow-x is visible == text/elements
    // crossing the element boundary. Scrollable boxes (auto/scroll/hidden) are
    // intentionally clipped/scrolled and not a violation.
    if (cs.overflowX === 'visible') {
      const spill = el.scrollWidth - el.clientWidth;
      if (spill > 1) {
        offenders.push({
          sel: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : ''),
          spill: Math.round(spill),
          text: (el.textContent || '').trim().slice(0, 50),
        });
      }
    }
  }
  // De-dup nested offenders by keeping the deepest (smallest) ones is hard; just
  // cap the report.
  return { vw, docOverflow: Math.round(docOverflow), offenders: offenders.slice(0, 12) };
}

// ── Harness ─────────────────────────────────────────────────────────────────
async function waitForServer(url, timeoutMs = 60000) {
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

const PAGES = [
  { name: 'overview',      path: '/' },
  { name: 'workflows',     path: '/workflows' },
  { name: 'workflow',      path: '/workflows/places' },
  { name: 'workflow-run',  path: '/workflow-runs/1' },
  { name: 'job',           path: '/jobs/places-enrich' },
  { name: 'run',           path: '/runs/1' },
  { name: 'services',      path: '/services' },
  { name: 'backlog',       path: '/backlog' },
];

async function main() {
  console.log(`Starting dashboard (next start -p ${PORT})…`);
  const server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    cwd: DASHBOARD_DIR, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.env.DEBUG && console.error(String(d)));

  let browser;
  const results = [];
  try {
    await waitForServer(BASE);
    console.log('Dashboard up. Launching Chromium…\n');
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    // Serve every API call from fixtures — fully hermetic, no daemon.
    await ctx.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtureFor(url.pathname)) });
    });

    for (const p of PAGES) {
      const page = await ctx.newPage();
      await page.goto(BASE + p.path, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      const m = await page.evaluate(measure);
      const pass = m.docOverflow <= 1 && m.offenders.length === 0;
      results.push({ ...p, ...m, pass });
      await page.close();
    }
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`Viewport: ${VIEWPORT.width}×${VIEWPORT.height} (iPhone-17-class)\n`);
  let failed = 0;
  for (const r of results) {
    const tag = r.pass ? '\x1b[32m✓ PASS\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m';
    console.log(`${tag}  ${r.name.padEnd(13)} ${r.path}`);
    console.log(`        doc horizontal overflow: ${r.docOverflow}px   boundary-crossing elements: ${r.offenders.length}`);
    if (!r.pass) {
      failed++;
      for (const o of r.offenders) console.log(`          ↳ ${o.sel} spills ${o.spill}px — "${o.text}"`);
    }
  }
  console.log('');
  if (failed) {
    console.log(`\x1b[31m✗ ${failed}/${results.length} page(s) failed the mobile check\x1b[0m`);
    process.exit(1);
  }
  console.log(`\x1b[32m✓ all ${results.length} pages pass the mobile check\x1b[0m`);
}

main().catch((e) => { console.error(e); process.exit(1); });
