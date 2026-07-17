import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultChromeProfileDir } from '../../core/browser.js';

import { resolveWorkflowDataDir } from '../../config.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolveWorkflowDataDir(resolve(here, 'data'));

export const perfumesConfig = {
  dataDir,
  /** Live source of truth for the perfume backlog (T401) — a DynamoDB table the
   *  owner populates by rating perfumes on their own website. */
  perfumeRatingsTable: process.env.PERFUMES_RATINGS_TABLE ?? 'PerfumeRatings',
  outDir: resolve(dataDir, 'out'),
  urlsFile: resolve(dataDir, 'out', 'fragrantica-urls.json'),
  pagesDir: resolve(dataDir, 'out', 'pages'),
  pagesFailedDir: resolve(dataDir, 'out', 'pages-failed'), // saved block/short pages for debugging
  profileDir: defaultChromeProfileDir, // shared framework profile (data/chrome-profile) — keeps Cloudflare clearance
  fragranticaDir: resolve(dataDir, 'out', 'fragrantica'),
  markdownDir: resolve(dataDir, 'out', 'markdown'),
  /** The output contract — the in-project profile template (self-contained, no
   *  external repo). Override with PERFUMES_TEMPLATE_PATH to point elsewhere. */
  templatePath: process.env.PERFUMES_TEMPLATE_PATH ?? resolve(here, 'profile.template.md'),

  // ── Claude Code CLI (the Ralph-style worker — $0 under the user's plan) ──
  claudeBin: process.env.PERFUMES_CLAUDE_BIN ?? 'claude',
  modelFind: process.env.PERFUMES_MODEL_FIND ?? 'claude-sonnet-4-6',
  modelParse: process.env.PERFUMES_MODEL_PARSE ?? 'claude-sonnet-4-6',
  modelBuild: process.env.PERFUMES_MODEL_BUILD ?? 'claude-opus-4-8',
  claudeTimeoutMs: Number(process.env.PERFUMES_CLAUDE_TIMEOUT_MS ?? 300_000), // 5 min/call

  // ── Fragrantica vs LLM confidence blend (sample-size weighting) ──
  // The build stage down-weights low-vote-count Fragrantica community signal
  // against the LLM's own web research via a continuous weight votes/(votes+k).
  // By default k is calibrated to the scraped corpus's MEDIAN vote count (so the
  // median perfume sits at weight 0.5); set this to pin k to a fixed value.
  confidenceK: process.env.PERFUMES_CONFIDENCE_K ? Number(process.env.PERFUMES_CONFIDENCE_K) : null,

  // ── per-item retry budget (mirrors the other workflows) ──
  maxAttempts: Number(process.env.PERFUMES_MAX_ATTEMPTS ?? 4),
  /** Per-run cap for a single stage (0 = no cap). */
  runLimit: Number(process.env.PERFUMES_RUN_LIMIT ?? 0),

  // ── fetch (real Chrome + persistent profile beats Fragrantica's Cloudflare) ──
  // The block is rate/reputation-based: a persistent profile keeps the CF clearance
  // cookie and generous, jittered pacing avoids tripping the rate limiter.
  fetchChannel: process.env.PERFUMES_FETCH_CHANNEL ?? 'chrome', // real Chrome; '' falls back to bundled chromium
  fetchHeadless: process.env.PERFUMES_FETCH_HEADLESS !== 'false', // headless works; set false to watch it
  fetchDelayMs: Number(process.env.PERFUMES_FETCH_DELAY_MS ?? 12_000),
  fetchJitterMs: Number(process.env.PERFUMES_FETCH_JITTER_MS ?? 6000),
  pageTimeoutMs: Number(process.env.PERFUMES_PAGE_TIMEOUT_MS ?? 45_000),
  /** Wait up to this long for real content to appear (Cloudflare challenge → real page). */
  contentWaitMs: Number(process.env.PERFUMES_CONTENT_WAIT_MS ?? 18_000),
  scrollSteps: Number(process.env.PERFUMES_SCROLL_STEPS ?? 14),

  // ── workflow orchestration ──
  cycleSleepMs: Number(process.env.PERFUMES_CYCLE_SLEEP_MS ?? 5_000),
  rateLimitBackoffMs: Number(process.env.PERFUMES_RATELIMIT_BACKOFF_MS ?? 600_000), // 10 min
  maxCycles: Number(process.env.PERFUMES_MAX_CYCLES ?? 40),

  /** Test mode: skip real Claude calls (fabricate), for harness testing. */
  dryRun: process.env.PERFUMES_DRY_RUN === '1',
};
