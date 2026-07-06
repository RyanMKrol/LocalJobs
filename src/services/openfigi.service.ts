import type { ServiceDefinition } from '../core/types.js';

/**
 * OpenFIGI — https://www.openfigi.com/api/documentation — Bloomberg's free
 * ISIN -> ticker mapping API. Used to resolve a broker's ISIN into a current,
 * real-world ticker symbol. Read-only, POST-mapping-only — no mutating calls.
 *
 * Free tier without an API key: 25 requests/minute, 10 jobs (ISINs) per
 * request. With an optional free API key (`X-OPENFIGI-APIKEY` header): 25
 * requests per 6 seconds, 100 jobs per request. `ratePerMinute` defaults
 * conservatively below the no-key ceiling; `dailyCap`/`monthlyCap` are
 * defensive metering only (OpenFIGI is free either way).
 */
const service: ServiceDefinition = {
  name: 'openfigi',
  category: 'api',
  description:
    'OpenFIGI mapping API (https://www.openfigi.com/api/documentation) — read-only ISIN -> ticker ' +
    'symbol resolution.',
  ratePerMinute: Number(process.env.OPENFIGI_RATE_PER_MIN ?? 20),
  dailyCap: Number(process.env.OPENFIGI_DAILY_CAP ?? 2_000),
  monthlyCap: Number(process.env.OPENFIGI_MONTHLY_CAP ?? 20_000),
  paid: false,
  rateLimitSource:
    'Documented in OpenFIGI\'s own API docs (https://www.openfigi.com/api/documentation): 25 ' +
    'requests/minute + 10 jobs/request without an API key, 25 requests/6s + 100 jobs/request with ' +
    'one. ratePerMinute=20 sits just under the documented no-key ceiling; dailyCap/monthlyCap are ' +
    'our own defensive estimates on top (OpenFIGI itself has no daily/monthly cap).',
};

export default service;

// ---------------------------------------------------------------------------
// Mapping fetch (injectable for tests — consuming jobs stub this)
// ---------------------------------------------------------------------------

interface OpenFigiMappingHit {
  ticker?: string;
  [key: string]: unknown;
}

interface OpenFigiMappingSuccess {
  data?: OpenFigiMappingHit[];
}

interface OpenFigiMappingWarning {
  warning?: string;
}

type OpenFigiMappingResult = OpenFigiMappingSuccess & OpenFigiMappingWarning;

/**
 * POST /v3/mapping for a batch of ISINs, returning the resolved ticker (or
 * `null` when OpenFIGI has no mapping) for each input ISIN, in the SAME order
 * as `isins`. An unmapped ISIN comes back as `{ warning: "No identifier found." }`
 * instead of `data` — that's treated as "no resolution", not an error.
 */
export async function fetchOpenFigiTickers(isins: string[], apiKey?: string): Promise<(string | null)[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['X-OPENFIGI-APIKEY'] = apiKey;
  }

  const body = isins.map((isin) => ({ idType: 'ID_ISIN', idValue: isin }));

  const res = await fetch('https://api.openfigi.com/v3/mapping', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`OpenFIGI mapping request failed: HTTP ${res.status}`);
  }

  const results = (await res.json()) as OpenFigiMappingResult[];
  return isins.map((_, i) => results[i]?.data?.[0]?.ticker ?? null);
}
