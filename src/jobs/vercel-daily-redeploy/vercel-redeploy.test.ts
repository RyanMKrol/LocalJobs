// vercel-redeploy tests — hermetic: no real network calls, global fetch is mocked.
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

import type { LogLevel } from '../../core/types.js';

type MockCtx = { logs: Array<{ message: string; level?: LogLevel }> };

function fakeCtx(): MockCtx & { log(m: string, l?: LogLevel): void; progress(): void; selectedRoots(): null; rootAllowed(): boolean } {
  const logs: Array<{ message: string; level?: LogLevel }> = [];
  return {
    logs,
    log(message: string, level?: LogLevel) { logs.push({ message, level }); },
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

const originalFetch = globalThis.fetch;
const originalEnv = process.env.VERCEL_DEPLOY_HOOK_URL;

describe('vercel-redeploy job', () => {
  beforeEach(() => {
    delete process.env.VERCEL_DEPLOY_HOOK_URL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) {
      delete process.env.VERCEL_DEPLOY_HOOK_URL;
    } else {
      process.env.VERCEL_DEPLOY_HOOK_URL = originalEnv;
    }
  });

  it('soft-skips when VERCEL_DEPLOY_HOOK_URL is unset — no fetch attempted', async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error('should not be called');
    }) as typeof fetch;

    const job = (await import('./vercel-redeploy.job.js')).default;
    const ctx = fakeCtx();
    await job.run(ctx as any);

    assert.equal(fetchCalled, false, 'fetch should never be called when hook url is unset');
    assert.ok(
      ctx.logs.some(l => l.level === 'warn' && l.message.includes('not configured') && l.message.includes('skipping')),
      'should log a warn about missing config',
    );
  });

  it('POSTs to the hook url with no body/auth header on success (2xx)', async () => {
    process.env.VERCEL_DEPLOY_HOOK_URL = 'https://api.vercel.com/v1/integrations/deploy/abc123';
    let calledUrl: string | undefined;
    let calledInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calledUrl = url;
      calledInit = init;
      return { ok: true, status: 201, text: async () => '' } as Response;
    }) as typeof fetch;

    const job = (await import('./vercel-redeploy.job.js')).default;
    const ctx = fakeCtx();
    await job.run(ctx as any);

    assert.equal(calledUrl, process.env.VERCEL_DEPLOY_HOOK_URL);
    assert.equal(calledInit?.method, 'POST');
    assert.equal(calledInit?.body, undefined, 'no body should be sent');
    assert.equal(calledInit?.headers, undefined, 'no auth header should be sent');
    assert.ok(ctx.logs.some(l => l.message.includes('successfully')), 'should log a success line');
  });

  it('throws on a non-2xx response', async () => {
    process.env.VERCEL_DEPLOY_HOOK_URL = 'https://api.vercel.com/v1/integrations/deploy/abc123';
    globalThis.fetch = (async () => ({ ok: false, status: 500, text: async () => 'server error' }) as Response) as typeof fetch;

    const job = (await import('./vercel-redeploy.job.js')).default;
    const ctx = fakeCtx();
    await assert.rejects(() => job.run(ctx as any), /500/);
  });

  it('propagates a network error (fetch rejection) as a failure', async () => {
    process.env.VERCEL_DEPLOY_HOOK_URL = 'https://api.vercel.com/v1/integrations/deploy/abc123';
    globalThis.fetch = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;

    const job = (await import('./vercel-redeploy.job.js')).default;
    const ctx = fakeCtx();
    await assert.rejects(() => job.run(ctx as any), /ECONNRESET/);
  });
});
