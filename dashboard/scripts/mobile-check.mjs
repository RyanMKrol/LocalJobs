// Mobile responsive check for the dashboard.
//
// Loads every dashboard page in a headless Chromium at an iPhone-17-class viewport
// (402px wide) and asserts basic mobile styling holds:
//   1. no horizontal overflow      — document does not scroll sideways
//   2. no text crossing boundaries — no element with `overflow-x: visible`
//      has content wider than its own box (i.e. nothing spills its container)
//
// The hermetic harness (the `next start` spawn, the synthetic `/api/**` fixtures, and
// the page list) lives in `_dashboard-harness.mjs`, shared with visual-check.mjs — so
// NO daemon, NO real SQLite, and NO paid API calls are touched, and there is ONE place
// to keep the page list + fixtures current.
//
// This is a LOCAL dev check — it is NOT part of CI and not a unit test. Run with:
//   node dashboard/scripts/mobile-check.mjs
// Exits non-zero if any page fails an assertion.

import { chromium } from 'playwright';
import { PAGES, waitForServer, startDashboard, routeApi } from './_dashboard-harness.mjs';

const PORT = Number(process.env.MOBILE_CHECK_PORT ?? 4799);
const BASE = `http://localhost:${PORT}`;
const VIEWPORT = { width: 402, height: 874 }; // iPhone-17-class logical width

// ── In-browser measurement ──────────────────────────────────────────────────
function measure() {
  const vw = window.innerWidth;
  const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  const offenders = [];
  // An element with `overflow-x: visible` and excess scrollWidth is only a REAL,
  // visible spill if the excess actually paints outside the viewport. If a nearer
  // ancestor (up to <body>) already clips horizontally (overflow-x hidden/auto/
  // scroll) AND that ancestor itself isn't already off-screen, the descendant's
  // excess is invisible — clipped away, not painted. Without this, React Flow's
  // internal `.react-flow__renderer`/`.react-flow__pane` layers (which report a
  // large scrollWidth from their unzoomed canvas coordinate space but sit two
  // levels inside a `.react-flow`/`.dag-flow-wrap` ancestor that clips with
  // `overflow: hidden`) were flagged as false-positive boundary-crossing spills
  // even though nothing ever crosses the visible page. Do not remove this check.
  function isClippedByAncestor(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const ncs = getComputedStyle(node);
      if (ncs.overflowX !== 'visible') {
        const nr = node.getBoundingClientRect();
        if (nr.right <= vw) return true;
      }
      node = node.parentElement;
    }
    return false;
  }
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
      if (spill > 1 && !isClippedByAncestor(el)) {
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
async function main() {
  console.log(`Starting dashboard (next start -p ${PORT})…`);
  const server = startDashboard(PORT);

  let browser;
  const results = [];
  try {
    await waitForServer(BASE);
    console.log('Dashboard up. Launching Chromium…\n');
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    // Serve every API call from fixtures — fully hermetic, no daemon.
    await routeApi(ctx);

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
