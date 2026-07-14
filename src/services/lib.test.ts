import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyFromMonthly, defineService, envInt } from './lib.js';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prev[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

await test('envInt: returns the fallback when unset', () => {
  withEnv({ T568_UNSET: undefined }, () => {
    assert.equal(envInt('T568_UNSET', 42), 42);
  });
});

await test('envInt: parses a valid set integer', () => {
  withEnv({ T568_VALID: '99' }, () => {
    assert.equal(envInt('T568_VALID', 1), 99);
  });
});

await test('envInt: throws naming the var for an empty string', () => {
  withEnv({ T568_EMPTY: '' }, () => {
    assert.throws(() => envInt('T568_EMPTY', 1), /T568_EMPTY/);
  });
});

await test('envInt: throws naming the var for a poisoned "2,000"', () => {
  withEnv({ T568_POISONED: '2,000' }, () => {
    assert.throws(() => envInt('T568_POISONED', 1), /T568_POISONED/);
  });
});

await test('envInt: throws naming the var for a non-numeric (NaN) value', () => {
  withEnv({ T568_NAN: 'not-a-number' }, () => {
    assert.throws(() => envInt('T568_NAN', 1), /T568_NAN/);
  });
});

await test('envInt: throws naming the var for a negative value', () => {
  withEnv({ T568_NEGATIVE: '-5' }, () => {
    assert.throws(() => envInt('T568_NEGATIVE', 1), /T568_NEGATIVE/);
  });
});

await test('defineService: resolves numeric fields via envPrefix-derived names', () => {
  withEnv(
    {
      T568SVC_RATE_PER_MIN: '7',
      T568SVC_DAILY_CAP: undefined,
      T568SVC_MONTHLY_CAP: undefined,
    },
    () => {
      const svc = defineService({
        name: 't568-svc',
        rateLimitSource: 'test fixture',
        envPrefix: 'T568SVC',
        ratePerMinute: { fallback: 10 },
        monthlyCap: { fallback: 300 },
      });
      assert.equal(svc.ratePerMinute, 7); // env override wins
      assert.equal(svc.monthlyCap, 300); // fallback used, unset env
    },
  );
});

await test('defineService: resolves numeric fields via a bespoke per-field env-name override', () => {
  withEnv({ PLACES_LLM_MONTHLY_CAP_T568: '5000' }, () => {
    const svc = defineService({
      name: 't568-bespoke',
      rateLimitSource: 'test fixture',
      monthlyCap: { env: 'PLACES_LLM_MONTHLY_CAP_T568', fallback: 2000 },
    });
    assert.equal(svc.monthlyCap, 5000);
  });
});

await test('defineService: an explicit resolved number bypasses env lookup entirely', () => {
  const svc = defineService({
    name: 't568-literal',
    rateLimitSource: 'test fixture',
    minIntervalMs: 12_000,
  });
  assert.equal(svc.minIntervalMs, 12_000);
});

await test("defineService: the 'monthly/30' dailyCap sentinel yields dailyFromMonthly(monthlyCap)", () => {
  const svc = defineService({
    name: 't568-sentinel',
    rateLimitSource: 'test fixture',
    monthlyCap: 2000,
    dailyCap: 'monthly/30',
  });
  assert.equal(svc.dailyCap, dailyFromMonthly(2000));
});

await test("defineService: a bespoke-named dailyCap field can fall back to the 'monthly/30' sentinel", () => {
  withEnv({ T568_DAILY_CAP_BESPOKE: undefined }, () => {
    const svc = defineService({
      name: 't568-sentinel-bespoke',
      rateLimitSource: 'test fixture',
      monthlyCap: 3000,
      dailyCap: { env: 'T568_DAILY_CAP_BESPOKE', fallback: 'monthly/30' },
    });
    assert.equal(svc.dailyCap, dailyFromMonthly(3000));
  });
});

await test('defineService: omitting rateLimitSource fails to compile', () => {
  // @ts-expect-error rateLimitSource is required — a service must document where its limits came from.
  defineService({ name: 't568-missing-source' });
});
