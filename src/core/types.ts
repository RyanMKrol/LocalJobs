// App-level types. The workflow engine's types (jobs, workflows, runs, gates) live in
// `src/engine/types.ts` and are re-exported here so existing imports keep resolving;
// new code imports them from `src/engine/index.js`.
export * from '../engine/types.js';

// ──────────────────────────────── Services ───────────────────────────────

/** An external dependency with shared, cross-job rate + quota limits. */
export interface ServiceDefinition {
  /** Unique identifier, e.g. 'gemini', 'google-places', 'fragrantica', 'claude-cli'. */
  name: string;
  description?: string;
  /** Throttle: max calls per rolling 60s. Omit for no rate throttle. */
  ratePerMinute?: number;
  /** Minimum gap between consecutive calls (ms) — fixed spacing for things that
   *  must not burst (e.g. a scrape behind Cloudflare). Takes precedence over
   *  ratePerMinute when set. */
  minIntervalMs?: number;
  /** Optional extra random delay (0..maxJitterMs) added after the min-interval. */
  maxJitterMs?: number;
  /** Quota: max calls per calendar day. Omit for no daily cap. */
  dailyCap?: number;
  /** Quota: max calls per calendar month. Omit for no monthly cap. */
  monthlyCap?: number;
  /** Whether calls cost real money (paid APIs get extra care in testing/UI). */
  paid?: boolean;
  /** Grouping label for the Services dashboard page. Controlled values:
   *  'cli-tool' | 'website-scrape' | 'api'. Omit to fall back to 'uncategorized'.
   *  Manifest-owned only — no dashboard edit UI, refreshed from code on every sync. */
  category?: string;
  /** Where this service's rate/quota numbers (ratePerMinute/dailyCap/monthlyCap/minIntervalMs) came
   *  from — a documented API limits page (name + link when one exists), an empirical/observed
   *  estimate from testing, or an explicit conservative guess when nothing is published. Write this
   *  HONESTLY: say "documented at <url>" only when you can point at a real page stating the number;
   *  otherwise say so plainly ("no public rate-limit docs found; empirically tuned" / "no published
   *  limit; conservative estimate"). Manifest-owned only — no dashboard edit UI, refreshed from code
   *  on every sync, exactly like `category`. */
  rateLimitSource?: string;
  /** Code default for this service's per-call request/process timeout (ms). Unlike
   *  ratePerMinute/dailyCap/monthlyCap — enforced generically inside `callService` —
   *  a timeout must actually CANCEL in-flight work, so it is NOT enforced there;
   *  each service's own client code reads the effective value via
   *  `effectiveServiceTimeoutMs(name, fallbackMs)` (`src/core/services.ts`) at its
   *  real request/process-level timeout point. Dashboard-editable + code-reconciled
   *  via the same `limits_overridden` flag as the other limit fields (see
   *  `updateServiceLimits`/`syncService` in `src/db/store.ts`). Omit for "no code
   *  default" — the caller's own fallback then applies. */
  timeoutMs?: number;
  /** Code-level cache TTL (ms) for 'api'-category services opting into response
   *  caching via `cacheKey` in CallServiceOpts. Like `minIntervalMs`/`maxJitterMs`,
   *  this is code-only, not dashboard-editable. Falls back to `SERVICE_CACHE_TTL_MS`
   *  (currently 5 minutes) when unset. Use for services with slower/expensive
   *  operations whose results change infrequently (e.g. Plex library metadata,
   *  TMDB lookups). */
  cacheTtlMs?: number;
}
