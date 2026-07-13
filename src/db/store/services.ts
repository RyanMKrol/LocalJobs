import { db } from '../index.js';
import type { ServiceDefinition } from '../../core/types.js';

// ════════════════════════ services (shared rate + quota) ════════════════════════

// On re-sync, code re-seeds the limits ONLY while the user hasn't taken them over.
// Once `limits_overridden = 1` (a dashboard edit, below), the three limit columns
// are preserved from the existing row so code-sync never clobbers a user override
// — the same reconcile the user-owned `enabled` flag gets. description/paid are
// code-owned and always refreshed.
const upsertServiceStmt = db.prepare(`
  INSERT INTO services (name, description, category, rate_per_minute, daily_cap, monthly_cap, timeout_ms, paid, rate_limit_source)
  VALUES (@name, @description, @category, @rate, @daily, @monthly, @timeoutMs, @paid, @rateLimitSource)
  ON CONFLICT(name) DO UPDATE SET
    description       = excluded.description,
    category          = excluded.category,
    paid              = excluded.paid,
    rate_limit_source = excluded.rate_limit_source,
    rate_per_minute = CASE WHEN limits_overridden = 1 THEN rate_per_minute ELSE excluded.rate_per_minute END,
    daily_cap       = CASE WHEN limits_overridden = 1 THEN daily_cap       ELSE excluded.daily_cap       END,
    monthly_cap     = CASE WHEN limits_overridden = 1 THEN monthly_cap     ELSE excluded.monthly_cap     END,
    timeout_ms      = CASE WHEN limits_overridden = 1 THEN timeout_ms      ELSE excluded.timeout_ms      END
`);

export function syncService(def: ServiceDefinition): void {
  upsertServiceStmt.run({
    name: def.name,
    description: def.description ?? '',
    category: def.category ?? 'uncategorized',
    rate: def.ratePerMinute ?? null,
    daily: def.dailyCap ?? null,
    monthly: def.monthlyCap ?? null,
    timeoutMs: def.timeoutMs ?? null,
    paid: def.paid ? 1 : 0,
    rateLimitSource: def.rateLimitSource ?? '',
  });
}

export interface ServiceRow {
  name: string;
  description: string;
  category: string;
  rate_per_minute: number | null;
  daily_cap: number | null;
  monthly_cap: number | null;
  timeout_ms: number | null;
  paid: number;
  limits_overridden: number;
  limits_overridden_at: string | null;
  rate_limit_source: string;
  created_at: string;
}

export function getServiceRow(name: string): ServiceRow | undefined {
  return db.prepare('SELECT * FROM services WHERE name = ?').get(name) as ServiceRow | undefined;
}

export function listServices(): ServiceRow[] {
  return db.prepare('SELECT * FROM services ORDER BY name').all() as ServiceRow[];
}

export interface ServiceLimits {
  rate_per_minute: number | null;
  daily_cap: number | null;
  monthly_cap: number | null;
  timeout_ms: number | null;
}

const updateServiceLimitsStmt = db.prepare(`
  UPDATE services
     SET rate_per_minute = @rate, daily_cap = @daily, monthly_cap = @monthly, timeout_ms = @timeoutMs,
         limits_overridden = 1, limits_overridden_at = datetime('now')
   WHERE name = @name
`);

/**
 * Persist a USER override of a service's limits (from the dashboard). Sets the
 * four limit columns and flips `limits_overridden` so a later code-sync keeps
 * them. A `null` means "no throttle / no cap / no timeout override". Returns the
 * updated row, or undefined if the service doesn't exist (no row touched).
 */
export function updateServiceLimits(name: string, limits: ServiceLimits): ServiceRow | undefined {
  const info = updateServiceLimitsStmt.run({
    name,
    rate: limits.rate_per_minute,
    daily: limits.daily_cap,
    monthly: limits.monthly_cap,
    timeoutMs: limits.timeout_ms,
  });
  if (info.changes === 0) return undefined;
  return getServiceRow(name);
}

export function recordServiceCall(service: string): void {
  db.prepare('INSERT INTO service_usage (service) VALUES (?)').run(service);
}

/**
 * Seed N service_usage rows for a service (one-time backfill when migrating a
 * job's metering from the per-job `job_usage` meter onto the shared service
 * meter). Idempotent topping-up is the caller's job: pass the DIFFERENCE you
 * want to add, not an absolute target. Inserts in a single transaction.
 */
export function backfillServiceUsage(service: string, count: number): void {
  if (count <= 0) return;
  const insert = db.prepare('INSERT INTO service_usage (service) VALUES (?)');
  const tx = db.transaction((n: number) => { for (let i = 0; i < n; i++) insert.run(service); });
  tx(count);
}

export function serviceCallsToday(service: string): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM service_usage WHERE service = ? AND ts >= datetime('now','start of day')",
  ).get(service) as { n: number }).n;
}

export function serviceCallsThisMonth(service: string): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM service_usage WHERE service = ? AND ts >= datetime('now','start of month')",
  ).get(service) as { n: number }).n;
}

export function serviceCallsInLastSeconds(service: string, seconds: number): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM service_usage WHERE service = ? AND ts >= datetime('now', ?)",
  ).get(service, `-${seconds} seconds`) as { n: number }).n;
}

const _countLast60 = db.prepare(
  "SELECT COUNT(*) AS n FROM service_usage WHERE service = ? AND ts >= datetime('now','-60 seconds')",
);
const _insertServiceUsage = db.prepare('INSERT INTO service_usage (service) VALUES (?)');
const _reserveSlotTx = db.transaction((service: string, ratePerMinute: number): boolean => {
  const n = (_countLast60.get(service) as { n: number }).n;
  if (n >= ratePerMinute) return false;
  _insertServiceUsage.run(service);
  return true;
});

/**
 * Atomically try to reserve a per-minute rate slot for a service: counts calls in
 * the trailing 60s and, if under the limit, records one — all in a single IMMEDIATE
 * transaction so concurrent job processes can't both slip through. Returns true if
 * the slot was acquired (caller proceeds), false if the caller should wait + retry.
 */
export function tryReserveServiceSlot(service: string, ratePerMinute: number): boolean {
  return _reserveSlotTx.immediate(service, ratePerMinute) as boolean;
}

const _maxGapMs = db.prepare(
  "SELECT (julianday('now') - julianday(MAX(ts))) * 86400000 AS gap FROM service_usage WHERE service = ?",
);
const _reserveIntervalTx = db.transaction((service: string, minIntervalMs: number): boolean => {
  const row = _maxGapMs.get(service) as { gap: number | null };
  if (row.gap !== null && row.gap < minIntervalMs) return false;
  _insertServiceUsage.run(service);
  return true;
});

/**
 * Atomically reserve a slot that enforces a MINIMUM GAP since the service's last
 * call (fixed spacing, not a burst-y rate). Returns true if at least
 * `minIntervalMs` has elapsed since the last recorded call (and records this one),
 * false if the caller should wait + retry. Single IMMEDIATE transaction so
 * concurrent job processes can't both slip through.
 */
export function tryReserveMinInterval(service: string, minIntervalMs: number): boolean {
  return _reserveIntervalTx.immediate(service, minIntervalMs) as boolean;
}

// ════════════════════════ service consumers (T186) ════════════════════════

const _upsertServiceConsumer = db.prepare(`
  INSERT INTO service_consumers (service_name, job_name, last_used)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(service_name, job_name) DO UPDATE SET last_used = datetime('now')
`);

/** Record that a job called a service. Called from callService() in services.ts. */
export function recordServiceConsumer(serviceName: string, jobName: string): void {
  _upsertServiceConsumer.run(serviceName, jobName);
}

export interface ServiceConsumerRow {
  service_name: string;
  job_name: string;
  workflow_name: string | null;
  last_used: string;
}

/**
 * List all jobs (+ their workflow) that have ever called a service, ordered by
 * workflow then job name. A job not yet in workflow_jobs shows workflow_name = null.
 */
export function listServiceConsumers(serviceName: string): ServiceConsumerRow[] {
  return db.prepare(`
    SELECT sc.service_name, sc.job_name, wj.workflow_name, sc.last_used
    FROM service_consumers sc
    LEFT JOIN workflow_jobs wj ON wj.job_name = sc.job_name
    WHERE sc.service_name = ?
    ORDER BY wj.workflow_name, sc.job_name
  `).all(serviceName) as ServiceConsumerRow[];
}

// ════════════════════ service response cache (T451) ════════════════════

const _getServiceCache = db.prepare(
  'SELECT response_json, cached_at FROM service_cache WHERE service_name = ? AND cache_key = ?',
);

/**
 * Read a cached service response, honoring a TTL. Returns undefined if there is
 * no row or the row is older than `ttlMs`. Used by callService() to short-circuit
 * a real call for an opted-in 'api'-category service.
 */
export function getCachedServiceResponse<T>(
  serviceName: string,
  cacheKey: string,
  ttlMs: number,
): T | undefined {
  const row = _getServiceCache.get(serviceName, cacheKey) as
    | { response_json: string; cached_at: string }
    | undefined;
  if (!row) return undefined;
  if (Date.now() - Date.parse(row.cached_at) > ttlMs) return undefined;
  return JSON.parse(row.response_json) as T;
}

const _setServiceCache = db.prepare(`
  INSERT INTO service_cache (service_name, cache_key, response_json, cached_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(service_name, cache_key) DO UPDATE SET
    response_json = excluded.response_json,
    cached_at     = excluded.cached_at
`);

/** Upsert a service response into the cache. Used by callService() (T451). */
export function setCachedServiceResponse(serviceName: string, cacheKey: string, value: unknown): void {
  _setServiceCache.run(serviceName, cacheKey, JSON.stringify(value), new Date().toISOString());
}

export interface ServiceCacheCount {
  service_name: string;
  count: number;
}

/** Row counts in service_cache, grouped by service, ordered by service name. */
export function serviceCacheCounts(): ServiceCacheCount[] {
  return db.prepare(`
    SELECT service_name, COUNT(*) as count
    FROM service_cache
    GROUP BY service_name
    ORDER BY service_name
  `).all() as ServiceCacheCount[];
}

/**
 * Delete rows from service_cache — all rows if `serviceName` is omitted, else
 * scoped to that one service. Returns the number of rows deleted. This is
 * DELIBERATELY separate from resetWorkflowOutput (T203): the response cache is
 * a service-level concern (T451), not a workflow's output ledger, and clearing
 * it must never happen as a side effect of the "Delete all workflow output"
 * danger-zone action.
 */
export function clearServiceCache(serviceName?: string): number {
  const result = serviceName
    ? db.prepare('DELETE FROM service_cache WHERE service_name = ?').run(serviceName)
    : db.prepare('DELETE FROM service_cache').run();
  return result.changes;
}
