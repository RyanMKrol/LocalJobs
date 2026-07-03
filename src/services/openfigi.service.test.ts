import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';

import service, { fetchOpenFigiTickers } from './openfigi.service.js';

describe('openfigi service — unit', () => {
  const originalFetch = global.fetch;
  after(() => {
    global.fetch = originalFetch;
  });

  it('service definition has expected shape', () => {
    assert.equal(service.name, 'openfigi');
    assert.equal(service.category, 'api');
    assert.equal(service.paid, false);
    assert.ok(typeof service.ratePerMinute === 'number' && service.ratePerMinute > 0);
    assert.ok(typeof service.dailyCap === 'number' && service.dailyCap! > 0);
    assert.ok(typeof service.monthlyCap === 'number' && service.monthlyCap! > 0);
  });

  it('fetchOpenFigiTickers resolves tickers in input order, omitting X-OPENFIGI-APIKEY without a key', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: unknown;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        json: async () => [{ data: [{ ticker: 'AAPL' }] }, { warning: 'No identifier found.' }],
      } as Response;
    }) as typeof fetch;

    const result = await fetchOpenFigiTickers(['US0378331005', 'ZZ0000000000']);
    assert.deepEqual(result, ['AAPL', null]);
    assert.deepEqual(capturedBody, [
      { idType: 'ID_ISIN', idValue: 'US0378331005' },
      { idType: 'ID_ISIN', idValue: 'ZZ0000000000' },
    ]);
    assert.equal(capturedHeaders?.['X-OPENFIGI-APIKEY'], undefined);
  });

  it('fetchOpenFigiTickers sends X-OPENFIGI-APIKEY when a key is provided', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return { ok: true, json: async () => [{ data: [{ ticker: 'MSFT' }] }] } as Response;
    }) as typeof fetch;

    await fetchOpenFigiTickers(['US5949181045'], 'my-key');
    assert.equal(capturedHeaders?.['X-OPENFIGI-APIKEY'], 'my-key');
  });

  it('fetchOpenFigiTickers throws on a non-OK response', async () => {
    global.fetch = (async () => ({ ok: false, status: 500 }) as Response) as typeof fetch;
    await assert.rejects(() => fetchOpenFigiTickers(['US0378331005']), /HTTP 500/);
  });
});
