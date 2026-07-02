// stock-digest-build tests — hermetic: no live Trading212/Claude calls.
// Uses a stub claudeRunner + a scratch DB (npm test sets LOCALJOBS_DB) + a tmp
// portfolio file / outDir. Covers: pure helpers (weekKey/Label, gainPct,
// portfolioSharePct, pickMovers, buildFacts), and the end-to-end run (writes
// markdown + ledger, missing/empty portfolio soft-skips, idempotent re-run).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isWorkItemDone } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import {
  runStockDigestBuild,
  weekKey,
  weekLabel,
  gainPct,
  portfolioSharePct,
  pickMovers,
  buildFacts,
  readPortfolio,
  type ClaudeRunner,
} from './stock-digest-build.js';
import type { NormalizedPosition } from '../../stocks-sync/stages/stocks-snapshot.js';

function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

function pos(overrides: Partial<NormalizedPosition> = {}): NormalizedPosition {
  return {
    ticker: 'AAPL',
    quantity: 10,
    averageBuyPrice: 100,
    currentPrice: 120,
    currentValue: 1200,
    account: 'invest',
    ...overrides,
  };
}

describe('weekKey / weekLabel', () => {
  it('formats an ISO week key', () => {
    // 2026-07-02 is a Thursday in ISO week 27.
    const key = weekKey(new Date('2026-07-02T12:00:00Z'));
    assert.equal(key, '2026-W27');
  });

  it('formats a human-readable week label matching the key', () => {
    const d = new Date('2026-07-02T12:00:00Z');
    assert.equal(weekLabel(d), `Week 27, ${weekKey(d).split('-W')[0]}`);
  });

  it('handles a year boundary correctly (ISO week, not calendar week)', () => {
    // 2025-01-01 is a Wednesday, part of ISO week 1 of 2025.
    const key = weekKey(new Date('2025-01-01T12:00:00Z'));
    assert.equal(key, '2025-W01');
  });
});

describe('gainPct', () => {
  it('computes gain since average buy price', () => {
    assert.equal(gainPct(pos({ averageBuyPrice: 100, currentPrice: 120 })), 20);
  });

  it('returns 0 when averageBuyPrice is 0 (guards divide-by-zero)', () => {
    assert.equal(gainPct(pos({ averageBuyPrice: 0, currentPrice: 120 })), 0);
  });

  it('computes a negative gain for a loser', () => {
    assert.equal(gainPct(pos({ averageBuyPrice: 100, currentPrice: 80 })), -20);
  });
});

describe('portfolioSharePct', () => {
  it('computes share of total portfolio value', () => {
    assert.equal(portfolioSharePct(pos({ currentValue: 250 }), 1000), 25);
  });

  it('returns 0 when total value is 0', () => {
    assert.equal(portfolioSharePct(pos({ currentValue: 250 }), 0), 0);
  });
});

describe('pickMovers', () => {
  it('picks top N winners and losers by gain %', () => {
    const positions = [
      pos({ ticker: 'A', averageBuyPrice: 100, currentPrice: 150 }), // +50%
      pos({ ticker: 'B', averageBuyPrice: 100, currentPrice: 90 }), // -10%
      pos({ ticker: 'C', averageBuyPrice: 100, currentPrice: 200 }), // +100%
      pos({ ticker: 'D', averageBuyPrice: 100, currentPrice: 50 }), // -50%
    ];
    const { winners, losers } = pickMovers(positions, 2);
    assert.deepEqual(winners.map((m) => m.ticker), ['C', 'A']);
    assert.deepEqual(losers.map((m) => m.ticker), ['D', 'B']);
  });
});

describe('buildFacts', () => {
  it('builds a structured facts object with holdings sorted by value', () => {
    const positions = [
      pos({ ticker: 'A', currentValue: 100, averageBuyPrice: 100, currentPrice: 100 }),
      pos({ ticker: 'B', currentValue: 900, averageBuyPrice: 100, currentPrice: 110 }),
    ];
    const facts = buildFacts(positions, new Date('2026-07-02T12:00:00Z'));
    assert.equal(facts.totalValue, 1000);
    assert.deepEqual(facts.holdings.map((h) => h.ticker), ['B', 'A']);
    assert.equal(facts.holdings[0].portfolioSharePct, 90);
    assert.equal(facts.weekLabel, weekLabel(new Date('2026-07-02T12:00:00Z')));
  });
});

describe('readPortfolio', () => {
  it('returns an empty array when the file does not exist', () => {
    assert.deepEqual(readPortfolio('/nonexistent/path/portfolio.json'), []);
  });

  it('returns an empty array on malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-digest-'));
    const p = join(dir, 'portfolio.json');
    writeFileSync(p, 'not json');
    assert.deepEqual(readPortfolio(p), []);
  });

  it('parses a valid portfolio file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-digest-'));
    const p = join(dir, 'portfolio.json');
    writeFileSync(p, JSON.stringify([pos()]));
    assert.deepEqual(readPortfolio(p), [pos()]);
  });
});

const JOB = 'stock-digest-build';

describe('runStockDigestBuild', () => {
  it('soft-skips with no crash when the portfolio file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-digest-'));
    let claudeCalled = false;
    const claudeRunner: ClaudeRunner = async () => {
      claudeCalled = true;
      return { ok: true, text: 'unused', rateLimited: false };
    };
    await runStockDigestBuild(fakeCtx(), {
      portfolioPath: join(dir, 'nope.json'),
      outDir: join(dir, 'out'),
      claudeRunner,
    });
    assert.equal(claudeCalled, false);
    assert.equal(existsSync(join(dir, 'out')), false);
  });

  it('soft-skips with no crash when the portfolio file is an empty array', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-digest-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(portfolioPath, '[]');
    let claudeCalled = false;
    const claudeRunner: ClaudeRunner = async () => {
      claudeCalled = true;
      return { ok: true, text: 'unused', rateLimited: false };
    };
    await runStockDigestBuild(fakeCtx(), {
      portfolioPath,
      outDir: join(dir, 'out'),
      claudeRunner,
    });
    assert.equal(claudeCalled, false);
  });

  it('writes markdown + records the work item on a successful run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-digest-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(portfolioPath, JSON.stringify([pos()]));
    const outDir = join(dir, 'out');
    const now = new Date('2026-07-02T12:00:00Z');
    const claudeRunner: ClaudeRunner = async () => ({
      ok: true,
      text: '# Stock Digest — Week 27, 2026\n\nnarrated report',
      rateLimited: false,
    });

    await runStockDigestBuild(fakeCtx(), { portfolioPath, outDir, now, claudeRunner });

    const key = weekKey(now);
    const mdPath = join(outDir, `stock-digest-${key}.md`);
    assert.ok(existsSync(mdPath));
    assert.match(readFileSync(mdPath, 'utf8'), /narrated report/);
    assert.equal(isWorkItemDone(JOB, key, 1), true);
  });

  it('throws when the Claude call fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-digest-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(portfolioPath, JSON.stringify([pos()]));
    const claudeRunner: ClaudeRunner = async () => ({
      ok: false,
      text: '',
      rateLimited: false,
      error: 'boom',
    });

    await assert.rejects(
      runStockDigestBuild(fakeCtx(), { portfolioPath, outDir: join(dir, 'out'), claudeRunner }),
      /boom/,
    );
  });

  it('is idempotent per ISO week — a re-run the same week overwrites, not duplicates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-digest-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(portfolioPath, JSON.stringify([pos()]));
    const outDir = join(dir, 'out');
    const now = new Date('2026-07-02T12:00:00Z');
    const claudeRunner: ClaudeRunner = async () => ({ ok: true, text: 'first', rateLimited: false });

    await runStockDigestBuild(fakeCtx(), { portfolioPath, outDir, now, claudeRunner });
    const claudeRunner2: ClaudeRunner = async () => ({ ok: true, text: 'second', rateLimited: false });
    await runStockDigestBuild(fakeCtx(), { portfolioPath, outDir, now, claudeRunner: claudeRunner2 });

    const mdPath = join(outDir, `stock-digest-${weekKey(now)}.md`);
    assert.equal(readFileSync(mdPath, 'utf8'), 'second');
  });
});
