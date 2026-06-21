import {
  recordServiceCall,
  serviceCallsThisMonth,
  serviceCallsToday,
  tryReserveMinInterval,
  tryReserveServiceSlot,
} from '../db/store.js';
import { getServiceDefinition } from '../jobs/registry.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const def = getServiceDefinition(name);
  if (!def) return fn();

  // ── quota (long window) → soft-fail ──
  if (def.monthlyCap != null) {
    const m = serviceCallsThisMonth(name);
    if (m >= def.monthlyCap) throw new QuotaExceededError(name, 'monthly', m, def.monthlyCap);
  }
  if (def.dailyCap != null) {
    const d = serviceCallsToday(name);
    if (d >= def.dailyCap) throw new QuotaExceededError(name, 'daily', d, def.dailyCap);
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
  if (def.ratePerMinute != null && def.ratePerMinute > 0) {
    const start = Date.now();
    const maxWait = opts.maxWaitMs ?? 300_000;
    let waited = false;
    while (!tryReserveServiceSlot(name, def.ratePerMinute)) {
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
