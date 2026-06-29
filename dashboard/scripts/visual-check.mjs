// Visual confirmation check for the dashboard.
//
// Loads every dashboard page in a headless Chromium at a DESKTOP viewport, waits
// robustly for async/polled content to render, and CAPTURES A SCREENSHOT of each page
// to a gitignored output dir. The screenshots exist so a human OR an agent (the build
// loop's builder + auditor) can SEE what each page renders and judge whether the work
// is visually correct.
//
// This catches the class of bug structural checks can't: an element that is present in
// the DOM but never PAINTED (the T223 gate-padlock bug — visible:false via a zero-width
// bbox — passed tsc, the unit suite, the dashboard build, AND mobile-check, because
// none of them look at pixels).
//
// IMPORTANT: this is NOT golden-image snapshot diffing — there are NO committed baseline
// images and NO pixel comparison, so cross-machine anti-aliasing drift is irrelevant. It
// asserts NO appearance invariants; the visual judgment is done by whoever views the
// PNGs. The script only fails on HARD errors (server didn't start, a page failed to
// load, a wait selector never appeared, or a page logged a console error).
//
// Hermetic, like mobile-check.mjs: it starts a production `next start` and serves all
// `/api/*` calls from synthetic in-process fixtures — NO daemon, NO SQLite, NO paid
// calls. The page list + fixtures are the shared living artifact in
// `_dashboard-harness.mjs`; keep them current when the UI surface changes.
//
// LOCAL/loop-only — NOT part of CI (no browser there). Run with:
//   npm --prefix dashboard run build   # serve a fresh build
//   node dashboard/scripts/visual-check.mjs
// Env: VISUAL_CHECK_PORT (default 4798), VISUAL_SETTLE_MS (default 1500, clamped
// 1000–5000), VISUAL_THEMES (csv of theme families to also capture, e.g.
// "pixel-picnic,sunny-8bit"; default = default theme only).

import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { PAGES, FLOWS, waitForServer, startDashboard, routeApi, seedTheme } from './_dashboard-harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, 'visual-out');
const PORT = Number(process.env.VISUAL_CHECK_PORT ?? 4798);
const BASE = `http://localhost:${PORT}`;
const VIEWPORT = { width: 1440, height: 900 }; // desktop — the appearance/DAG surface
const SETTLE_MS = Math.min(5000, Math.max(1000, Number(process.env.VISUAL_SETTLE_MS ?? 1500)));
const SELECTOR_TIMEOUT_MS = 10000;
// Theme families to capture. The empty string = the DEFAULT theme (no data-theme set).
const EXTRA_THEMES = (process.env.VISUAL_THEMES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const THEMES = ['', ...EXTRA_THEMES];

/**
 * Capture one spec ({ name, path, waitFor?, settleMs?, actions? }) under one theme.
 * For an interaction flow, `actions(page)` runs after the wait + settle and before the
 * screenshot. Returns a result row; throws only on a hard error.
 */
async function capture(ctx, spec, theme) {
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  const suffix = theme ? `.${theme}` : '';
  const file = resolve(OUT_DIR, `${spec.name}${suffix}.png`);
  try {
    await page.goto(BASE + spec.path, { waitUntil: 'networkidle' });
    // Wait for real, post-mount content (e.g. the DAG's layout useEffect) to render
    // before settling — far more robust than a blind fixed delay.
    for (const sel of spec.waitFor ?? []) {
      await page.waitForSelector(sel, { state: 'visible', timeout: SELECTOR_TIMEOUT_MS });
    }
    await page.waitForTimeout(spec.settleMs ?? SETTLE_MS);
    // Interaction flows: drive the page into the state we want to capture, then re-settle.
    if (spec.actions) {
      await spec.actions(page);
      await page.waitForTimeout(spec.settleMs ?? SETTLE_MS);
    }
    const fullPage = !spec.viewport;
    await page.screenshot({ path: file, fullPage, animations: 'disabled' });
    return { name: spec.name, path: spec.path, theme, file, pass: consoleErrors.length === 0, error: consoleErrors[0] ?? null };
  } catch (e) {
    // Still try to capture whatever DID render, so the viewer can see the broken state.
    try { await page.screenshot({ path: file, fullPage: !spec.viewport, animations: 'disabled' }); } catch { /* ignore */ }
    return { name: spec.name, path: spec.path, theme, file, pass: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await page.close();
  }
}

async function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Starting dashboard (next start -p ${PORT})…`);
  const server = startDashboard(PORT);

  let browser;
  const results = [];
  try {
    await waitForServer(BASE);
    console.log('Dashboard up. Launching Chromium…\n');
    browser = await chromium.launch();

    for (const theme of THEMES) {
      const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      // Freeze animations + hide emoji for a stable capture; seed the theme family.
      await seedTheme(ctx, { theme: theme || undefined, motion: 'reduced' });
      await routeApi(ctx);
      for (const p of PAGES) results.push(await capture(ctx, p, theme));
      // Interaction flows run once, under the DEFAULT theme only (bounds cost; the
      // flows capture interaction state, not theme variants).
      if (theme === '') {
        for (const f of FLOWS) results.push(await capture(ctx, f, theme));
      }
      await ctx.close();
    }
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`Viewport: ${VIEWPORT.width}×${VIEWPORT.height} (desktop)   settle: ${SETTLE_MS}ms`);
  console.log(`Screenshots written to: ${OUT_DIR}\n`);
  let failed = 0;
  for (const r of results) {
    const tag = r.pass ? '\x1b[32m✓ PASS\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m';
    const label = r.theme ? `${r.name} [${r.theme}]` : r.name;
    console.log(`${tag}  ${label.padEnd(24)} ${r.path}`);
    console.log(`        ${r.file}`);
    if (!r.pass) { failed++; console.log(`          ↳ ${r.error}`); }
  }
  console.log('');
  console.log('These screenshots are for VISUAL confirmation — open them and check the page renders as intended');
  console.log('(the thing you changed is actually painted/visible, nothing blank, overlapping, or clipped).\n');
  if (failed) {
    console.log(`\x1b[31m✗ ${failed}/${results.length} capture(s) hit a hard error (page load / wait / console error)\x1b[0m`);
    process.exit(1);
  }
  console.log(`\x1b[32m✓ all ${results.length} page(s) captured\x1b[0m`);
}

main().catch((e) => { console.error(e); process.exit(1); });
