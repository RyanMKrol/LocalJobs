import {
  getServiceRow,
  recordServiceCall,
  recordServiceConsumer,
  serviceCallsThisMonth,
  serviceCallsToday,
  tryReserveMinInterval,
  tryReserveServiceSlot,
} from '../db/store.js';
import type { ServiceDefinition } from './types.js';

// Service definitions live here (not imported from the registry) so callService
// has NO dependency on the registry — the registry imports the job modules, which
// import this file, so importing the registry back would be a cycle. The registry
// registers each *.service.ts it discovers via registerService().
const _serviceDefs = new Map<string, ServiceDefinition>();
export function registerService(def: ServiceDefinition): void {
  _serviceDefs.set(def.name, def);
}
export function getServiceDef(name: string): ServiceDefinition | undefined {
  return _serviceDefs.get(name);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The calling job name is passed as process.argv[2] when running as a child
// (src/runJob.ts). We capture it once so each callService() can record the
// (service, job) pair without callers needing to pass it explicitly.
const _callingJobName: string | undefined = process.argv[2] || undefined;

/**
 * Resolve the limits to ENFORCE for a service. When the user has overridden them
 * from the dashboard (`limits_overridden` on the DB row), those win; otherwise the
 * code default from the ServiceDefinition is used. Falls back to the def alone if
 * no row exists yet (e.g. sync hasn't run).
 */
function effectiveLimits(def: ServiceDefinition): {
  ratePerMinute: number | null;
  dailyCap: number | null;
  monthlyCap: number | null;
} {
  const row = getServiceRow(def.name);
  if (row && row.limits_overridden) {
    return {
      ratePerMinute: row.rate_per_minute,
      dailyCap: row.daily_cap,
      monthlyCap: row.monthly_cap,
    };
  }
  return {
    ratePerMinute: def.ratePerMinute ?? null,
    dailyCap: def.dailyCap ?? null,
    monthlyCap: def.monthlyCap ?? null,
  };
}

/** Thrown when a service's day/month quota is exhausted. A retryable soft-fail:
 *  the caller leaves the item un-done and the next run resumes when it resets. */
export class QuotaExceededError extends Error {
  readonly retryable = true;
  constructor(
    public service: string,
    public window: 'daily' | 'monthly',
    public used: number,
    public cap: number,
  ) {
    super(`service "${service}" ${window} quota exhausted (${used}/${cap})`);
    this.name = 'QuotaExceededError';
  }
}

export interface CallServiceOpts {
  /** Max time to wait for a per-minute rate slot before giving up. Default 5 min. */
  maxWaitMs?: number;
  /** Called once if the call had to wait for a rate slot (so callers can log it). */
  onThrottle?: (waitedMs: number) => void;
}

/**
 * Gate an external call behind a service's SHARED, cross-job limits:
 *   • day / month QUOTA exceeded → throw QuotaExceededError (retryable soft-fail);
 *   • per-minute RATE exceeded   → throttle: wait until a slot frees.
 * Records exactly one usage row per call (the rate reservation IS the record for
 * rate-limited services). Coordinated across job processes via the SQLite meter.
 * An undefined service runs ungated, so a missing *.service.ts never blocks work.
 */
export async function callService<T>(
  name: string,
  fn: () => Promise<T>,
  opts: CallServiceOpts = {},
): Promise<T> {
  const def = getServiceDef(name);
  if (!def) return fn();

  // Record that this job used this service (best-effort — never block the call).
  if (_callingJobName) {
    try { recordServiceConsumer(name, _callingJobName); } catch { /* non-fatal */ }
  }

  // Effective limits: a dashboard override (limits_overridden) wins over the code
  // default; otherwise the code default is the source of truth. minIntervalMs /
  // maxJitterMs are code-only (not editable) and always come from the def.
  const { ratePerMinute, dailyCap, monthlyCap } = effectiveLimits(def);

  // ── quota (long window) → soft-fail ──
  if (monthlyCap != null) {
    const m = serviceCallsThisMonth(name);
    if (m >= monthlyCap) throw new QuotaExceededError(name, 'monthly', m, monthlyCap);
  }
  if (dailyCap != null) {
    const d = serviceCallsToday(name);
    if (d >= dailyCap) throw new QuotaExceededError(name, 'daily', d, dailyCap);
  }

  // ── fixed spacing (min-interval) → throttle; takes precedence over rate ──
  if (def.minIntervalMs != null && def.minIntervalMs > 0) {
    const start = Date.now();
    const maxWait = opts.maxWaitMs ?? 300_000;
    let waited = false;
    while (!tryReserveMinInterval(name, def.minIntervalMs)) {
      if (Date.now() - start > maxWait) {
        throw new Error(`service "${name}" min-interval: no slot after ${Math.round(maxWait / 1000)}s`);
      }
      waited = true;
      await sleep(1000);
    }
    if (def.maxJitterMs && def.maxJitterMs > 0) await sleep(Math.floor(Math.random() * def.maxJitterMs));
    if (waited) opts.onThrottle?.(Date.now() - start);
    return fn();
  }

  // ── per-minute rate → throttle (the reservation records the usage row) ──
  if (ratePerMinute != null && ratePerMinute > 0) {
    const start = Date.now();
    const maxWait = opts.maxWaitMs ?? 300_000;
    let waited = false;
    while (!tryReserveServiceSlot(name, ratePerMinute)) {
      if (Date.now() - start > maxWait) {
        throw new Error(`service "${name}" rate limit: no slot after ${Math.round(maxWait / 1000)}s`);
      }
      waited = true;
      await sleep(2000 + Math.floor(Math.random() * 1500));
    }
    if (waited) opts.onThrottle?.(Date.now() - start);
    return fn();
  }

  // ── no rate limit → just meter + run ──
  recordServiceCall(name);
  return fn();
}
