// T569: after migrating every *.service.ts definition onto defineService() (R04a),
// this pins the EFFECTIVE limits of all 16 services to a frozen pre-migration snapshot
// — proving the migration changed no runtime behavior. The snapshot values were
// computed from each service's hand-written pre-migration definition (the exact same
// env var names / defaults documented in each file's own doc comment), so a value
// drifting here means the defineService() conversion silently changed a limit.
//
// Also asserts a poisoned numeric env var (the historical `Number(process.env.X)` bug:
// a value like '2,000' silently becomes NaN) now throws LOUD at load time instead —
// proving every numeric read in a migrated service goes through envInt(), not a bare
// Number(...) call.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import claudeCli from './claude-cli.service.js';
import dynamodb from './dynamodb.service.js';
import finnhub from './finnhub.service.js';
import fragrantica from './fragrantica.service.js';
import fsService from './fs.service.js';
import gemini from './gemini.service.js';
import github from './github.service.js';
import googlePlaces from './google-places.service.js';
import hevy from './hevy.service.js';
import lastfm from './lastfm.service.js';
import openfigi from './openfigi.service.js';
import plex from './plex.service.js';
import tmdb from './tmdb.service.js';
import trading212Instruments from './trading212-instruments.service.js';
import trading212 from './trading212.service.js';
import vercel from './vercel.service.js';

type EffectiveLimits = {
  ratePerMinute?: number;
  dailyCap?: number;
  monthlyCap?: number;
  minIntervalMs?: number;
  maxJitterMs?: number;
  timeoutMs?: number;
  cacheTtlMs?: number;
};

function effective(def: {
  ratePerMinute?: number;
  dailyCap?: number;
  monthlyCap?: number;
  minIntervalMs?: number;
  maxJitterMs?: number;
  timeoutMs?: number;
  cacheTtlMs?: number;
}): EffectiveLimits {
  return {
    ratePerMinute: def.ratePerMinute,
    dailyCap: def.dailyCap,
    monthlyCap: def.monthlyCap,
    minIntervalMs: def.minIntervalMs,
    maxJitterMs: def.maxJitterMs,
    timeoutMs: def.timeoutMs,
    cacheTtlMs: def.cacheTtlMs,
  };
}

// Frozen BEFORE-migration values — computed from each hand-written *.service.ts's own
// env-var defaults as they existed immediately prior to the defineService() conversion
// (see the task T569 spec / git history for the pre-migration source of each figure).
const SNAPSHOT: Record<string, EffectiveLimits> = {
  'claude-cli': {},
  dynamodb: { ratePerMinute: 30, dailyCap: 1666, monthlyCap: 50_000, cacheTtlMs: 79_200_000 },
  finnhub: { ratePerMinute: 30, dailyCap: 500, monthlyCap: 5_000, cacheTtlMs: 79_200_000 },
  fragrantica: { minIntervalMs: 12_000, maxJitterMs: 6000 },
  fs: {},
  gemini: { ratePerMinute: 10, dailyCap: 66, monthlyCap: 2000, cacheTtlMs: 79_200_000 },
  github: { ratePerMinute: 30, dailyCap: 200, monthlyCap: 3_000, cacheTtlMs: 79_200_000 },
  'google-places': { ratePerMinute: 30, dailyCap: 33, monthlyCap: 1000, cacheTtlMs: 79_200_000 },
  hevy: { ratePerMinute: 20, dailyCap: 500, monthlyCap: 5_000, cacheTtlMs: 79_200_000 },
  lastfm: { ratePerMinute: 30, cacheTtlMs: 79_200_000 },
  openfigi: { ratePerMinute: 20, dailyCap: 2_000, monthlyCap: 20_000, cacheTtlMs: 79_200_000 },
  plex: { ratePerMinute: 300, timeoutMs: 300_000, cacheTtlMs: 10_800_000 },
  tmdb: { ratePerMinute: 600, cacheTtlMs: 79_200_000 },
  'trading212-instruments': { minIntervalMs: 50_000, dailyCap: 20, monthlyCap: 200, cacheTtlMs: 79_200_000 },
  trading212: { ratePerMinute: 10, dailyCap: 100, monthlyCap: 1_000, cacheTtlMs: 79_200_000 },
  vercel: { dailyCap: 3, monthlyCap: 30 },
};

const SERVICES = {
  'claude-cli': claudeCli,
  dynamodb,
  finnhub,
  fragrantica,
  fs: fsService,
  gemini,
  github,
  'google-places': googlePlaces,
  hevy,
  lastfm,
  openfigi,
  plex,
  tmdb,
  'trading212-instruments': trading212Instruments,
  trading212,
  vercel,
};

assert.deepEqual(
  Object.keys(SERVICES).sort(),
  Object.keys(SNAPSHOT).sort(),
  'every service must have exactly one snapshot entry',
);

for (const [name, def] of Object.entries(SERVICES)) {
  assert.equal(def.name, name, `service file exports the expected name ${name}`);
  assert.deepEqual(
    effective(def),
    effective(SNAPSHOT[name]),
    `${name}: effective limits after defineService() migration must match the frozen pre-migration snapshot`,
  );
}

assert.ok(
  typeof vercel.rateLimitSource === 'string' && vercel.rateLimitSource.length > 0,
  'vercel.service.ts must have a non-empty rateLimitSource (previously omitted — defineService() now requires it)',
);

console.log(`  ✓ effective limits for all ${Object.keys(SERVICES).length} services match the frozen pre-migration snapshot`);

// Poisoned-env test: re-importing vercel.service.ts with a poisoned VERCEL_MONTHLY_CAP
// must throw at load time, naming the var — proving envInt() (not a bare Number(...))
// governs the numeric read. Run in a fresh child process since ESM module state (and
// the poisoned env var) can't be reset/reloaded in-process.
const repoRoot = new URL('../../', import.meta.url).pathname;
let threw = false;
let stderr = '';
try {
  execFileSync(
    process.execPath,
    ['--import', 'tsx', '-e', "import('./src/services/vercel.service.js')"],
    {
      cwd: repoRoot,
      env: { ...process.env, VERCEL_MONTHLY_CAP: '2,000' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
} catch (err) {
  threw = true;
  stderr = (err as { stderr?: string }).stderr ?? '';
}

assert.ok(threw, 'importing vercel.service.ts with a poisoned VERCEL_MONTHLY_CAP must throw at load time');
assert.match(stderr, /VERCEL_MONTHLY_CAP/, 'the thrown error must name the poisoned env var');

console.log('  ✓ importing vercel.service.ts with VERCEL_MONTHLY_CAP="2,000" throws at load, naming the var');

