import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildClaudeArgs, claudeTimeoutMs } from './claude.js';
import { syncService, updateServiceLimits } from '../db/store.js';
import { effectiveServiceTimeoutMs } from '../core/services.js';

describe('buildClaudeArgs', () => {
  it('omits --effort when not provided', () => {
    const args = buildClaudeArgs('claude-sonnet-5');
    assert.ok(!args.includes('--effort'));
  });

  it('includes --effort <level> when provided', () => {
    const args = buildClaudeArgs('claude-sonnet-5', 'medium');
    const idx = args.indexOf('--effort');
    assert.notEqual(idx, -1);
    assert.equal(args[idx + 1], 'medium');
  });
});

describe('claudeTimeoutMs (T465)', () => {
  it('a dashboard override of the claude-cli service timeout wins over the env/code default, no env var touched', () => {
    const before = claudeTimeoutMs();
    syncService({ name: 'claude-cli' }); // ensure a services row exists (registry does this in production)
    updateServiceLimits('claude-cli', { rate_per_minute: null, daily_cap: null, monthly_cap: null, timeout_ms: 77_000 });
    assert.equal(claudeTimeoutMs(), 77_000);
    assert.notEqual(before, 77_000, 'the override value differs from whatever the code default was');

    updateServiceLimits('claude-cli', { rate_per_minute: null, daily_cap: null, monthly_cap: null, timeout_ms: null });
    assert.equal(claudeTimeoutMs(), before, 'clearing the override reverts to the code default');
  });

  it('resolves in order: dashboard/service override > env var > 300000 default (T566)', () => {
    // No override, no env var — falls back to the 300000 code default (mirrors the
    // module's `LOCALJOBS_CLAUDE_TIMEOUT_MS ?? 300_000` seed, which is read once at
    // module load, so this only exercises the "no env set" case honestly).
    syncService({ name: 'claude-cli' });
    updateServiceLimits('claude-cli', { rate_per_minute: null, daily_cap: null, monthly_cap: null, timeout_ms: null });
    assert.equal(effectiveServiceTimeoutMs('claude-cli', 300_000), 300_000, 'env unset, no override -> the 300000 default');

    // An env-var-style fallback (as if LOCALJOBS_CLAUDE_TIMEOUT_MS had been set to
    // 123456 at module load) wins over the bare 300000 default when there's no
    // dashboard override yet.
    assert.equal(effectiveServiceTimeoutMs('claude-cli', 123_456), 123_456, 'env fallback wins over the bare default when unoverridden');

    // A dashboard/service-effective override wins over the env-var-style fallback.
    updateServiceLimits('claude-cli', { rate_per_minute: null, daily_cap: null, monthly_cap: null, timeout_ms: 99_000 });
    assert.equal(effectiveServiceTimeoutMs('claude-cli', 123_456), 99_000, 'dashboard override wins over the env-var fallback');

    updateServiceLimits('claude-cli', { rate_per_minute: null, daily_cap: null, monthly_cap: null, timeout_ms: null });
  });
});
