import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildClaudeArgs, claudeTimeoutMs } from './claude.js';
import { syncService, updateServiceLimits } from '../db/store.js';

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
});
