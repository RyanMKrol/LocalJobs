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
  sectorBreakdown,
  extractCandidateTickers,
  findUnknownTickers,
  type ClaudeRunner,
} from './stock-digest-build.js';
import { factsPathFor } from '../config.js';
import type { NormalizedPosition } from '../../../services/trading212.service.js';

function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

function fakeCtxWithLogSpy(): { ctx: JobContext; logs: string[] } {
  const logs: string[] = [];
  const ctx: JobContext = {
    log(msg: string) {
      logs.push(msg);
    },
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
  return { ctx, logs };
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

describe('sectorBreakdown', () => {
  it('groups portfolio value % by resolved industry, sorted descending', () => {
    const positions = [
      pos({ ticker: 'A', currentValue: 100 }),
      pos({ ticker: 'B', currentValue: 300 }),
      pos({ ticker: 'C', currentValue: 600 }),
    ];
    const sectors = { A: 'Tech', B: 'Tech', C: 'Retail' };
    const breakdown = sectorBreakdown(positions, sectors);
    assert.deepEqual(breakdown, [
      { industry: 'Retail', valuePct: 60 },
      { industry: 'Tech', valuePct: 40 },
    ]);
  });

  it('excludes tickers with no resolved sector', () => {
    const positions = [pos({ ticker: 'A', currentValue: 100 }), pos({ ticker: 'B', currentValue: 900 })];
    const breakdown = sectorBreakdown(positions, { A: 'Tech', B: null });
    assert.deepEqual(breakdown, [{ industry: 'Tech', valuePct: 10 }]);
  });

  it('returns an empty array when no sectors are known at all', () => {
    const positions = [pos({ ticker: 'A', currentValue: 100 })];
    assert.deepEqual(sectorBreakdown(positions, {}), []);
  });

  it('returns an empty array when total value is 0', () => {
    assert.deepEqual(sectorBreakdown([pos({ currentValue: 0 })], { AAPL: 'Tech' }), []);
  });
});

describe('buildFacts diversification', () => {
  it('includes sectorBreakdown when sectors are provided', () => {
    const positions = [pos({ ticker: 'A', currentValue: 1000 })];
    const facts = buildFacts(positions, new Date('2026-07-02T12:00:00Z'), { A: 'Tech' });
    assert.deepEqual(facts.sectorBreakdown, [{ industry: 'Tech', valuePct: 100 }]);
  });

  it('defaults to an empty sectorBreakdown when no sector map is passed', () => {
    const positions = [pos({ ticker: 'A', currentValue: 1000 })];
    const facts = buildFacts(positions, new Date('2026-07-02T12:00:00Z'));
    assert.deepEqual(facts.sectorBreakdown, []);
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

  it('degrades gracefully (no crash) when sectors.json is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-digest-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(portfolioPath, JSON.stringify([pos()]));
    const outDir = join(dir, 'out');
    let capturedPrompt = '';
    const claudeRunner: ClaudeRunner = async (prompt) => {
      capturedPrompt = prompt;
      return { ok: true, text: 'ok', rateLimited: false };
    };

    await runStockDigestBuild(fakeCtx(), {
      portfolioPath,
      sectorsPath: join(dir, 'nope-sectors.json'),
      outDir,
      claudeRunner,
    });

    assert.doesNotMatch(capturedPrompt, /Diversification/);
  });

  it('includes the diversification section when sectors.json has resolved data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-digest-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(portfolioPath, JSON.stringify([pos({ ticker: 'AAPL', currentValue: 1000 })]));
    const sectorsPath = join(dir, 'sectors.json');
    writeFileSync(sectorsPath, JSON.stringify({ AAPL: 'Technology' }));
    const outDir = join(dir, 'out');
    let capturedPrompt = '';
    const claudeRunner: ClaudeRunner = async (prompt) => {
      capturedPrompt = prompt;
      return { ok: true, text: 'ok', rateLimited: false };
    };

    await runStockDigestBuild(fakeCtx(), { portfolioPath, sectorsPath, outDir, claudeRunner });

    assert.match(capturedPrompt, /Diversification/);
    assert.match(capturedPrompt, /Technology/);
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

  it('writes the raw facts JSON alongside the markdown, matching the computed facts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-digest-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(portfolioPath, JSON.stringify([pos({ ticker: 'AAPL', currentValue: 1000 })]));
    const outDir = join(dir, 'out');
    const now = new Date('2026-07-02T12:00:00Z');
    const claudeRunner: ClaudeRunner = async () => ({ ok: true, text: 'narrated', rateLimited: false });

    await runStockDigestBuild(fakeCtx(), { portfolioPath, outDir, now, claudeRunner });

    const key = weekKey(now);
    const factsPath = factsPathFor(key, outDir);
    assert.ok(existsSync(factsPath));
    const written = JSON.parse(readFileSync(factsPath, 'utf8'));
    const expected = buildFacts([pos({ ticker: 'AAPL', currentValue: 1000 })], now);
    assert.deepEqual(written, expected);
  });
});

describe('extractCandidateTickers', () => {
  it('pulls ticker-shaped tokens out of narrated text', () => {
    const text = 'Your AAPL position gained, while YNDX_US_EQ dropped sharply this week.';
    assert.deepEqual(extractCandidateTickers(text), ['AAPL', 'YNDX_US_EQ']);
  });

  it('dedupes repeated tokens', () => {
    const text = 'AAPL rose. AAPL is now your biggest holding.';
    assert.deepEqual(extractCandidateTickers(text), ['AAPL']);
  });
});

describe('findUnknownTickers', () => {
  const facts = buildFacts([pos({ ticker: 'AAPL' }), pos({ ticker: 'YNDX_US_EQ' })], new Date('2026-07-02T12:00:00Z'));

  it('returns candidates missing from facts.holdings', () => {
    assert.deepEqual(findUnknownTickers(['AAPL', 'TSLA'], facts), ['TSLA']);
  });

  it('excludes known tickers', () => {
    assert.deepEqual(findUnknownTickers(['AAPL', 'YNDX_US_EQ'], facts), []);
  });

  it('excludes stoplisted tokens', () => {
    assert.deepEqual(findUnknownTickers(['ISA', 'USD', 'API'], facts), []);
  });
});

describe('runStockDigestBuild — ticker cross-check', () => {
  it('logs a warn line when narration mentions a ticker not in facts.holdings, without throwing or changing outcome', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-digest-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(portfolioPath, JSON.stringify([pos({ ticker: 'AAPL' })]));
    const outDir = join(dir, 'out');
    const now = new Date('2026-07-02T12:00:00Z');
    const claudeRunner: ClaudeRunner = async () => ({
      ok: true,
      text: 'Your AAPL position is steady, but TSLA surged this week.',
      rateLimited: false,
    });
    const { ctx, logs } = fakeCtxWithLogSpy();

    await runStockDigestBuild(ctx, { portfolioPath, outDir, now, claudeRunner });

    const warnLine = logs.find((l) => l.includes('possible narration drift'));
    assert.ok(warnLine, 'expected a warn log about narration drift');
    assert.match(warnLine!, /TSLA/);
    assert.equal(isWorkItemDone(JOB, weekKey(now), 1), true);
  });

  it('logs nothing extra when narration mentions no unknown tickers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-digest-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(portfolioPath, JSON.stringify([pos({ ticker: 'AAPL' })]));
    const outDir = join(dir, 'out');
    const now = new Date('2026-07-02T12:00:00Z');
    const claudeRunner: ClaudeRunner = async () => ({
      ok: true,
      text: 'Your AAPL position is steady this week.',
      rateLimited: false,
    });
    const { ctx, logs } = fakeCtxWithLogSpy();

    await runStockDigestBuild(ctx, { portfolioPath, outDir, now, claudeRunner });

    assert.equal(logs.some((l) => l.includes('narration drift')), false);
  });
});
