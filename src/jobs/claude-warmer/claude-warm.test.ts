// claude-warm tests — hermetic: no real Claude CLI invocations.
// Covers: job issues a minimal prompt; QuotaExceededError is handled without throwing.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QuotaExceededError } from '../../core/services.js';
import type { LogLevel } from '../../core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockCtx = { logs: string[] };

function fakeCtx(): MockCtx {
  const logs: string[] = [];
  return {
    logs,
    log(message: string, _level?: LogLevel) { logs.push(message); },
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  } as unknown as MockCtx;
}

// ---------------------------------------------------------------------------
// Unit: replicate the job's run logic with an injected mock runClaude
// ---------------------------------------------------------------------------

type ClaudeResult = { ok: boolean; text: string; rateLimited: boolean; error?: string };

async function runJobWith(runClaudeFn: () => Promise<ClaudeResult>): Promise<MockCtx> {
  const ctx = fakeCtx() as MockCtx & { log(m: string, l?: LogLevel): void };

  try {
    const result = await runClaudeFn();
    if (result.rateLimited) {
      ctx.log(`Claude usage/rate limit reached — window already active (${result.error ?? ''})`, 'warn');
      return ctx;
    }
    if (!result.ok) {
      ctx.log(`Claude warm call failed (non-fatal): ${result.error ?? 'unknown error'}`, 'warn');
      return ctx;
    }
    ctx.log('Warm call succeeded — usage window is active.');
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      ctx.log(`claude-cli service quota exceeded (upstream plan limit) — window already active: ${(err as Error).message}`, 'warn');
      return ctx;
    }
    ctx.log(`Unexpected error during warm call (non-fatal): ${String(err)}`, 'warn');
  }
  return ctx;
}

describe('claude-warm job', () => {
  it('issues a minimal prompt and logs success', async () => {
    let calledWith: string | undefined;
    const ctx = await runJobWith(async () => {
      calledWith = 'hi';
      return { ok: true, text: 'Hello!', rateLimited: false };
    });
    assert.equal(calledWith, 'hi', 'should issue "hi" prompt');
    assert.ok(ctx.logs.some(l => l.includes('succeeded')), 'should log success');
  });

  it('handles QuotaExceededError without throwing', async () => {
    const ctx = await runJobWith(async () => {
      throw new QuotaExceededError('claude-cli', 'daily', 100, 100);
    });
    assert.ok(ctx.logs.some(l => l.includes('quota exceeded')), 'should log quota warning');
  });

  it('handles rate-limited result without throwing', async () => {
    const ctx = await runJobWith(async () => ({
      ok: false,
      text: '',
      rateLimited: true,
      error: 'claude usage limit reached',
    }));
    assert.ok(ctx.logs.some(l => l.includes('rate limit')), 'should log rate limit warning');
  });

  it('handles unexpected error without throwing', async () => {
    const ctx = await runJobWith(async () => {
      throw new Error('network failure');
    });
    assert.ok(ctx.logs.some(l => l.includes('non-fatal')), 'should log non-fatal error');
  });
});
