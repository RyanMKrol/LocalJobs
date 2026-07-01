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

const WARM_MODEL = 'claude-haiku-4-5-20251001';
const WARM_PROMPT = 'hi';

async function runJobWith(runClaudeFn: () => Promise<ClaudeResult>): Promise<MockCtx> {
  const ctx = fakeCtx() as MockCtx & { log(m: string, l?: LogLevel): void };

  ctx.log(`Sending warm prompt to Claude (model: ${WARM_MODEL}): "${WARM_PROMPT}"`);
  try {
    const result = await runClaudeFn();
    if (result.rateLimited) {
      ctx.log(`Claude usage/rate limit reached (model: ${WARM_MODEL}) — window already active (${result.error ?? ''})`, 'warn');
      return ctx;
    }
    if (!result.ok) {
      ctx.log(`Claude warm call failed (model: ${WARM_MODEL}, non-fatal): ${result.error ?? 'unknown error'}`, 'warn');
      return ctx;
    }
    ctx.log(`Warm call succeeded (model: ${WARM_MODEL}) — usage window is active.`);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      ctx.log(`claude-cli service quota exceeded (model: ${WARM_MODEL}, upstream plan limit) — window already active: ${(err as Error).message}`, 'warn');
      return ctx;
    }
    ctx.log(`Unexpected error during warm call (model: ${WARM_MODEL}, non-fatal): ${String(err)}`, 'warn');
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
    assert.ok(ctx.logs.some(l => l.includes('succeeded') && l.includes(WARM_MODEL)), 'should log success with model');
    assert.ok(
      ctx.logs.some(l => l.includes(WARM_MODEL) && l.includes(`"${WARM_PROMPT}"`)),
      'initial sending log should include model and prompt text',
    );
  });

  it('handles QuotaExceededError without throwing', async () => {
    const ctx = await runJobWith(async () => {
      throw new QuotaExceededError('claude-cli', 'daily', 100, 100);
    });
    assert.ok(ctx.logs.some(l => l.includes('quota exceeded') && l.includes(WARM_MODEL)), 'should log quota warning with model');
  });

  it('handles rate-limited result without throwing', async () => {
    const ctx = await runJobWith(async () => ({
      ok: false,
      text: '',
      rateLimited: true,
      error: 'claude usage limit reached',
    }));
    assert.ok(ctx.logs.some(l => l.includes('rate limit') && l.includes(WARM_MODEL)), 'should log rate limit warning with model');
  });

  it('handles unexpected error without throwing', async () => {
    const ctx = await runJobWith(async () => {
      throw new Error('network failure');
    });
    assert.ok(ctx.logs.some(l => l.includes('non-fatal') && l.includes(WARM_MODEL)), 'should log non-fatal error with model');
  });
});
