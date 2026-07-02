import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildClaudeArgs } from './claude.js';

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
