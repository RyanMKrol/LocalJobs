// Proves internal dashboard navigation is genuinely client-side (Next.js `<Link>`
// SPA transitions), not a full browser page reload — the T427 fix.
//
// The check: inject a marker into `window` after the FIRST page load, click an
// internal nav link, then assert the marker SURVIVES. A real full-page reload wipes
// any in-memory JS global, so this only passes when navigation stayed client-side.
//
// Reuses the same hermetic harness as mobile-check.mjs/visual-check.mjs
// (`_dashboard-harness.mjs`): a production `next start` + synthetic `/api/**`
// fixtures — no daemon, no real SQLite, no paid calls.
//
// Self-running (mirrors the src/*.test.ts convention): run directly with
//   npx tsx dashboard/scripts/nav-check.test.ts
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
// @ts-expect-error no type declarations for this local .mjs harness module
import { waitForServer, startDashboard, routeApi } from './_dashboard-harness.mjs';

const PORT = Number(process.env.NAV_CHECK_PORT ?? 4797);
const BASE = `http://localhost:${PORT}`;

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

async function main() {
  console.log(`Starting dashboard (next start -p ${PORT})…`);
  const server = startDashboard(PORT);
  let browser;
  try {
    await waitForServer(BASE);
    console.log('Dashboard up. Launching Chromium…\n');
    browser = await chromium.launch();
    const ctx = await browser.newContext();
    await routeApi(ctx);

    await test('clicking a header nav link does not trigger a full page reload', async () => {
      const page = await ctx.newPage();
      await page.goto(BASE + '/', { waitUntil: 'networkidle' });

      // Plant a marker that only survives if the JS runtime stays alive across
      // the click — a genuine full navigation would wipe it.
      await page.evaluate(() => { (window as unknown as { __t427Marker?: boolean }).__t427Marker = true; });

      await page.click('header.site nav a:has-text("Workflows")');
      await page.waitForURL('**/workflows', { timeout: 5000 });

      const marker = await page.evaluate(() => (window as unknown as { __t427Marker?: boolean }).__t427Marker);
      assert.equal(marker, true, 'window.__t427Marker was wiped — navigation triggered a full page reload');
      assert.ok(page.url().endsWith('/workflows'), 'nav click did not land on /workflows');

      await page.close();
    });

    await test('clicking the brand link navigates client-side back to Overview', async () => {
      const page = await ctx.newPage();
      await page.goto(BASE + '/workflows', { waitUntil: 'networkidle' });
      await page.evaluate(() => { (window as unknown as { __t427Marker?: boolean }).__t427Marker = true; });

      await page.click('header.site .brand');
      await page.waitForURL((u: URL) => u.pathname === '/', { timeout: 5000 });

      const marker = await page.evaluate(() => (window as unknown as { __t427Marker?: boolean }).__t427Marker);
      assert.equal(marker, true, 'window.__t427Marker was wiped — brand link triggered a full page reload');

      await page.close();
    });
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }

  console.log('');
  console.log(process.exitCode ? '\x1b[31m✗ NAV CHECK FAILED\x1b[0m' : `\x1b[32m✓ all ${passed} nav check(s) passed\x1b[0m`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
