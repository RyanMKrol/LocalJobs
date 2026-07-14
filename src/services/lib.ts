import type { ServiceDefinition } from '../core/types.js';

/**
 * Shared spend-cap math for the top-level services.
 *
 * Paid services are governed on a DAILY-scheduled cadence, so the daily spend cap
 * must be the monthly free allowance spread evenly across the month: daily ≈
 * monthly / 30. That way a full month of daily runs exactly fits the monthly
 * ceiling — 30 capped days == the monthly cap — while still draining the backlog
 * steadily, and a single day's run can NEVER blow the month.
 *
 * (Contrast the generic CLAUDE.md "daily = monthly/10" rule, which suits a
 * weekly/manual cadence where you want headroom for a few re-runs per day; a
 * *daily* schedule needs /30.) This math lives WITH the services because a
 * service's quota is the single source of truth for shared spend.
 */
export const DAILY_SPEND_DIVISOR = 30;

/** Default daily cap derived from a monthly cap (floored): monthly / 30. */
export function dailyFromMonthly(monthlyCap: number): number {
  return Math.floor(monthlyCap / DAILY_SPEND_DIVISOR);
}

/**
 * Read an integer env var, failing LOUD at load time instead of silently
 * becoming `NaN` (the historical bug: `Number(process.env.X)` on a poisoned
 * value like `'2,000'` or `''` produces `NaN`, which then flows into rate/quota
 * math as a silent no-op limit). Unset → `fallback`. Set → strictly parsed;
 * empty-string, non-finite, `NaN`, or negative all throw an `Error` naming
 * `varName` so the failure points straight at the bad env var.
 */
export function envInt(varName: string, fallback: number): number {
  const raw = process.env[varName];
  if (raw === undefined) return fallback;
  if (raw.trim() === '') {
    throw new Error(`envInt: ${varName} is set but empty`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    throw new Error(`envInt: ${varName} is not a valid number: "${raw}"`);
  }
  if (parsed < 0) {
    throw new Error(`envInt: ${varName} must not be negative: "${raw}"`);
  }
  return parsed;
}

/**
 * How one numeric field of a `defineService` input resolves:
 * - a plain `number` → an already-resolved literal value, no env lookup at all.
 * - `{ fallback }` → read from the envPrefix-derived var name (e.g. `${envPrefix}_RATE_PER_MIN`).
 * - `{ env, fallback }` → read from an explicit, bespoke env var name (for
 *   services that keep a name that predates this helper, e.g. gemini's
 *   `PLACES_LLM_MONTHLY_CAP`), so the effective limit stays byte-identical.
 */
export type ServiceNumberField<T = number> = number | { fallback: T } | { env: string; fallback: T };

/** `dailyCap` additionally accepts the `'monthly/30'` sentinel (bare, or as a
 *  field's `fallback`), which resolves to `dailyFromMonthly(resolvedMonthlyCap)`. */
export type ServiceDailyCapField = ServiceNumberField<number | 'monthly/30'> | 'monthly/30';

/** Input to {@link defineService} — the declarative ~10-line shape a
 *  `*.service.ts` file should shrink to. `rateLimitSource` is REQUIRED (an
 *  omission is a compile error) so a service can never silently ship without
 *  documenting where its numbers came from. */
export interface DefineServiceInput {
  name: string;
  category?: string;
  description?: string;
  paid?: boolean;
  /** Where the rate/quota numbers came from — see `ServiceDefinition.rateLimitSource`. Required. */
  rateLimitSource: string;
  /** Prefix used to derive an env var name for any field given as `{ fallback }` (e.g.
   *  `envPrefix: 'GEMINI'` + `ratePerMinute: { fallback: 10 }` reads `GEMINI_RATE_PER_MIN`). */
  envPrefix?: string;
  ratePerMinute?: ServiceNumberField;
  dailyCap?: ServiceDailyCapField;
  monthlyCap?: ServiceNumberField;
  minIntervalMs?: ServiceNumberField;
  maxJitterMs?: ServiceNumberField;
  timeoutMs?: ServiceNumberField;
  cacheTtlMs?: ServiceNumberField;
}

function envDefaultName(envPrefix: string | undefined, suffix: string): string {
  if (!envPrefix) {
    throw new Error(
      `defineService: field needs either an envPrefix or an explicit { env } override (suffix ${suffix})`,
    );
  }
  return `${envPrefix}_${suffix}`;
}

function resolveNumberField(
  field: ServiceNumberField | undefined,
  envPrefix: string | undefined,
  suffix: string,
): number | undefined {
  if (field === undefined) return undefined;
  if (typeof field === 'number') return field;
  const varName = 'env' in field ? field.env : envDefaultName(envPrefix, suffix);
  return envInt(varName, field.fallback);
}

function dailyFromMonthlyOrThrow(monthlyCap: number | undefined): number {
  if (monthlyCap === undefined) {
    throw new Error("defineService: dailyCap 'monthly/30' requires monthlyCap to also be set");
  }
  return dailyFromMonthly(monthlyCap);
}

function resolveDailyCapField(
  field: ServiceDailyCapField | undefined,
  envPrefix: string | undefined,
  resolvedMonthlyCap: number | undefined,
): number | undefined {
  if (field === undefined) return undefined;
  if (field === 'monthly/30') return dailyFromMonthlyOrThrow(resolvedMonthlyCap);
  if (typeof field === 'number') return field;
  const varName = 'env' in field ? field.env : envDefaultName(envPrefix, 'DAILY_CAP');
  const fallback = field.fallback === 'monthly/30' ? dailyFromMonthlyOrThrow(resolvedMonthlyCap) : field.fallback;
  return envInt(varName, fallback);
}

/**
 * Build a `ServiceDefinition` declaratively: numeric fields resolve through
 * {@link envInt} (fail-loud, never a silent `NaN`) either from an `envPrefix`-derived
 * name or a bespoke `{ env }` override, so a service that keeps a pre-existing env
 * var name ends up with a byte-identical effective limit to its hand-written
 * predecessor. `rateLimitSource` is required — omitting it is a compile error.
 */
export function defineService(d: DefineServiceInput): ServiceDefinition {
  const resolvedMonthlyCap = resolveNumberField(d.monthlyCap, d.envPrefix, 'MONTHLY_CAP');
  return {
    name: d.name,
    category: d.category,
    description: d.description,
    paid: d.paid,
    rateLimitSource: d.rateLimitSource,
    ratePerMinute: resolveNumberField(d.ratePerMinute, d.envPrefix, 'RATE_PER_MIN'),
    dailyCap: resolveDailyCapField(d.dailyCap, d.envPrefix, resolvedMonthlyCap),
    monthlyCap: resolvedMonthlyCap,
    minIntervalMs: resolveNumberField(d.minIntervalMs, d.envPrefix, 'MIN_INTERVAL_MS'),
    maxJitterMs: resolveNumberField(d.maxJitterMs, d.envPrefix, 'MAX_JITTER_MS'),
    timeoutMs: resolveNumberField(d.timeoutMs, d.envPrefix, 'TIMEOUT_MS'),
    cacheTtlMs: resolveNumberField(d.cacheTtlMs, d.envPrefix, 'CACHE_TTL_MS'),
  };
}
