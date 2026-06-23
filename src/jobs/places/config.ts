import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resources live alongside the job itself (src/jobs/places/data), not in a
// far-off top-level folder. Paths are resolved relative to this file.
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, 'data');

export const placesConfig = {
  dataDir,
  savedDir: resolve(dataDir, 'raw', 'Saved'),
  outDir: resolve(dataDir, 'out'),
  placesOut: resolve(dataDir, 'out', 'places.json'),
  reportOut: resolve(dataDir, 'out', 'validation-report.json'),
  resolvedOut: resolve(dataDir, 'out', 'resolved.json'),
  enrichedOut: resolve(dataDir, 'out', 'enriched.json'),
  enrichUsageOut: resolve(dataDir, 'out', 'enrich-usage.json'),
  llmOut: resolve(dataDir, 'out', 'llm-enriched.json'),
  markdownDir: resolve(dataDir, 'out', 'markdown'),
};

/**
 * The places workflow runs on a DAILY cron, so the daily spend cap must be the
 * monthly free allowance spread evenly across the month: daily ≈ monthly / 30.
 * That way a daily run can NEVER blow the month — 30 capped days exactly fits the
 * monthly ceiling — while still draining the backlog steadily. (Contrast the
 * generic CLAUDE.md "daily = monthly/10" rule, which suits a weekly/manual cadence
 * where you want headroom for a few re-runs per day; a *daily* schedule needs /30.)
 */
export const DAILY_SPEND_DIVISOR = 30;

const llmMonthlyCap = Number(process.env.PLACES_LLM_MONTHLY_CAP ?? 2000);

/** LLM enrichment (Gemini) knobs. Key from .env (GEMINI_API_KEY). */
export const llmConfig = {
  apiKey: process.env.GEMINI_API_KEY ?? '',
  /** Default to the CHEAPEST model (Flash-Lite); it still supports Google Search
   *  grounding + URL context + thinking (minimal|low|medium|high). Override with
   *  GEMINI_MODEL for a more capable/expensive model when needed. */
  model: process.env.GEMINI_MODEL ?? 'gemini-flash-lite-latest',
  /** Test the harness without calling Gemini (fabricates a result). */
  dryRun: process.env.PLACES_LLM_DRY_RUN === '1',
  /** Max items per run (0 = no cap). */
  runLimit: Number(process.env.PLACES_LLM_RUN_LIMIT ?? 0),
  /**
   * Spend caps (Gemini is paid, ~$0.002/call). Monthly is the real ceiling
   * (~$4/mo at 2000); daily defaults to monthly/30 (≈66) so the daily-scheduled
   * workflow spreads the month's budget evenly and can't blow it. Both enforced;
   * whichever hits first stops.
   */
  monthlyCap: llmMonthlyCap,
  dailyCap: Number(process.env.PLACES_LLM_DAILY_CAP ?? Math.floor(llmMonthlyCap / DAILY_SPEND_DIVISOR)),
  /** Give up on a place after this many failed attempts. */
  maxAttempts: Number(process.env.PLACES_LLM_MAX_ATTEMPTS ?? 4),
  /** Delay between calls, ms (free tier is rate-limited per minute). */
  delayMs: Number(process.env.PLACES_LLM_DELAY_MS ?? 1500),
  /**
   * Gemini 3 thinking depth: minimal | low | medium | high. Flash-Lite defaults
   * to "minimal" (barely thinks) — we raise it so the model actually deliberates
   * and chooses to search + fetch the website for places it doesn't already know.
   */
  thinkingLevel: process.env.GEMINI_THINKING_LEVEL ?? 'high',
};

const enrichMonthlyCap = Number(process.env.PLACES_ENRICH_MONTHLY_CAP ?? 1000);

/** Enrichment knobs. The Places API key comes from .env (GOOGLE_MAPS_API_KEY). */
export const enrichConfig = {
  apiKey: process.env.GOOGLE_MAPS_API_KEY ?? '',
  /**
   * Spend caps. Monthly 1000 = the free Enterprise+Atmosphere tier, so a default
   * run never incurs charges; daily defaults to monthly/30 (≈33) so the
   * daily-scheduled workflow spreads the free allowance evenly and a daily run
   * can never exhaust the month. Both enforced. (The separate Google Cloud daily
   * quota on GetPlaceRequest is an external belt-and-braces.)
   */
  monthlyCap: enrichMonthlyCap,
  dailyCap: Number(process.env.PLACES_ENRICH_DAILY_CAP ?? Math.floor(enrichMonthlyCap / DAILY_SPEND_DIVISOR)),
  /** Max calls in a single run (0 = no per-run cap). */
  runLimit: Number(process.env.PLACES_ENRICH_RUN_LIMIT ?? 0),
  /** Stop retrying a place after this many failed attempts across runs. */
  maxAttempts: Number(process.env.PLACES_ENRICH_MAX_ATTEMPTS ?? 4),
  /** Delay between calls, ms (well within QPM limits; just being polite). */
  delayMs: Number(process.env.PLACES_ENRICH_DELAY_MS ?? 250),
  /** Test the harness without spending quota (fabricates responses). */
  dryRun: process.env.PLACES_ENRICH_DRY_RUN === '1',
  /**
   * Wildcard field mask: fetch EVERYTHING the Place Details (New) endpoint
   * returns (plus any future fields Google adds). We store the full raw response
   * and trim it downstream, so there's no value in enumerating fields here.
   *
   * Cost is unchanged: `*` bills at the highest applicable SKU = Enterprise +
   * Atmosphere, which is exactly the tier we already use. The only field `*`
   * can't return is routingSummaries (needs an origin param; not relevant).
   */
  fieldMask: '*',
};


/** Resolver knobs (overridable via env for testing). */
export const resolveConfig = {
  /** Delay between place lookups, ms (be gentle on Google). */
  delayMs: Number(process.env.PLACES_RESOLVE_DELAY_MS ?? 1500),
  /** Cap how many unresolved places to process this run (0 = no cap). */
  limit: Number(process.env.PLACES_RESOLVE_LIMIT ?? 0),
  /** Per-place navigation/resolve timeout, ms. */
  pageTimeoutMs: Number(process.env.PLACES_RESOLVE_PAGE_TIMEOUT_MS ?? 30000),
  /** Give up retrying a place after this many failed attempts across runs. */
  maxAttempts: Number(process.env.PLACES_RESOLVE_MAX_ATTEMPTS ?? 4),
  /**
   * Caps. Resolving costs no money (local headless browser), so these are
   * generous runaway-guards / politeness limits rather than spend limits.
   * daily = monthly/10.
   */
  monthlyCap: Number(process.env.PLACES_RESOLVE_MONTHLY_CAP ?? 10000),
  dailyCap: Number(process.env.PLACES_RESOLVE_DAILY_CAP ?? 1000),
};

