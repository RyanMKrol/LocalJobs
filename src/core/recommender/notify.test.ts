// Notify-stage tests for the shared pipeline (T561) — dedup + digest + report +
// history against the work_items ledger, plus the push-ok-then-mark guard
// (B11, T527). Hermetic: no live push (an injected capture fn), synthetic
// recommendations file, scratch DB. Two SYNTHETIC domains (movie-like / tv-like)
// prove the SAME shared runRecsNotify serves differently-configured domains
// (distinct digest wording, report heading, extra ledger detail) without
// cross-contamination — a golden-file assertion of the exact digest + history
// row shape produced from a fixed fixture.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorkItem, isWorkItemDone } from '../../db/store.js';
import type { JobContext } from '../types.js';
import { runRecsNotify } from './notify.js';
import type { Recommendation, RecommendationsFile, RecommenderConfig, RecommenderDomain } from './types.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

interface CapturedPush { title: string; body: string; job: string; tags: string }
function capturePush(sent: CapturedPush[]) {
  return (async (title: string, body: string, opts: { job: string; tags: string }) => {
    sent.push({ title, body, job: opts.job, tags: opts.tags });
    return { ok: true };
  }) as any;
}

function makeConfig(dir: string): RecommenderConfig {
  return {
    snapshotOut: join(dir, 'snapshot.json'),
    tasteOut: join(dir, 'taste.json'),
    recsHistoryOut: join(dir, 'history.json'),
    recsDir: join(dir, 'recs'),
    recsOut: join(dir, 'recommendations.json'),
    reportDir: dir,
    recsModel: 'claude-sonnet-5',
    recsSampleSize: 50, recsPerBranchAsk: 9, recsTarget: 15, recsGenreCap: 3,
    recsMinRating: 7, recsMinVotes: 50, recsTopUpRounds: 3, recsTopUpConcurrency: 4,
    recsRecentWindow: 40, recsHistoryContext: 200,
  };
}

function makeDomain(name: string, dir: string, extraDetail?: boolean): RecommenderDomain<unknown, unknown> {
  return {
    recsJob: `${name}-notify-recs`,
    snapshotStageName: `${name}-snapshot`,
    mergeStageName: `${name}-merge`,
    notifyStageName: `${name}-notify`,
    config: makeConfig(dir),
    branches: [],
    itemsOf: () => [],
    profileOf: () => ({}),
    search: async () => null,
    genreName: () => 'Unknown',
    tmdbUrl: (tmdbId) => `https://example.test/${name}/${tmdbId}`,
    buildDigest: (recs) => ({
      count: recs.length,
      title: `${name.toUpperCase()}: ${recs.length} pick(s)`,
      body: recs.map((r) => r.title).join(' | '),
    }),
    pushJob: name,
    pushTags: `${name}-tag`,
    reportFilename: `${name}-report.md`,
    reportHeading: `# ${name} report`,
    reportEmptyLine: `_No ${name} picks._`,
    ...(extraDetail ? { extraNotifyDetail: (r: Recommendation) => ({ tmdbUrl: `https://example.test/${name}/${r.tmdbId}` }) } : {}),
  };
}

const NOW = new Date('2026-06-24T00:00:00Z');
const rec = (id: number, title: string): Recommendation =>
  ({ tmdbId: id, title, year: 2001, reason: `pick ${title}`, lens: 'serendipity', genre: 'Drama', tmdbRating: 7.5 });

function writeRecs(recsFile: string, recs: Recommendation[]) {
  writeFileSync(recsFile, JSON.stringify({ generatedAt: NOW.toISOString(), pooled: recs.length, recommendations: recs } as RecommendationsFile));
}

// ── golden-file: movie-like domain (no extra detail) ──
{
  const dir = mkdtempSync(join(tmpdir(), 'recommender-notify-movie-'));
  const domain = makeDomain('movie', dir);
  writeRecs(domain.config.recsOut, [rec(41001, 'Alpha'), rec(41002, 'Beta')]);
  const sent: CapturedPush[] = [];
  await runRecsNotify(fakeCtx(), domain, { push: capturePush(sent), now: NOW });

  assert.equal(sent.length, 1, 'one digest sent');
  assert.deepEqual(sent[0], { title: 'MOVIE: 2 pick(s)', body: 'Alpha | Beta', job: 'movie', tags: 'movie-tag' }, 'digest matches the domain\'s exact wiring (golden)');
  assert.ok(isWorkItemDone(domain.recsJob, '41001', 1));
  const row = getWorkItem(domain.recsJob, '41001');
  const detail = JSON.parse(row?.detail ?? '{}');
  assert.equal(detail.tmdbUrl, undefined, 'movie-like domain has no extraNotifyDetail — no tmdbUrl in ledger detail');
  const md = readFileSync(join(dir, 'movie-report.md'), 'utf8');
  assert.match(md, /# movie report/);
  assert.match(md, /\[Alpha\]\(https:\/\/example\.test\/movie\/41001\)/);
  const hist = JSON.parse(readFileSync(domain.config.recsHistoryOut, 'utf8'));
  assert.deepEqual(hist.recommended, [
    { tmdbId: 41001, title: 'Alpha', year: 2001, at: NOW.toISOString() },
    { tmdbId: 41002, title: 'Beta', year: 2001, at: NOW.toISOString() },
  ], 'recs-history rows are exactly { tmdbId, title, year, at } (golden)');
  console.log('  ✓ golden-file: movie-like domain notify digest/report/history are byte-identical to the expected fixture');
}

// ── golden-file: tv-like domain (extraNotifyDetail adds tmdbUrl to ledger detail) ──
{
  const dir = mkdtempSync(join(tmpdir(), 'recommender-notify-tv-'));
  const domain = makeDomain('tv', dir, true);
  writeRecs(domain.config.recsOut, [rec(42001, 'Gamma')]);
  const sent: CapturedPush[] = [];
  await runRecsNotify(fakeCtx(), domain, { push: capturePush(sent), now: NOW });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { title: 'TV: 1 pick(s)', body: 'Gamma', job: 'tv', tags: 'tv-tag' }, 'digest matches the tv-like domain\'s exact wiring (golden)');
  const row = getWorkItem(domain.recsJob, '42001');
  const detail = JSON.parse(row?.detail ?? '{}');
  assert.equal(detail.tmdbUrl, 'https://example.test/tv/42001', 'tv-like domain\'s extraNotifyDetail is merged into the ledger detail');
  console.log('  ✓ golden-file: tv-like domain notify wires extraNotifyDetail into the ledger without affecting the movie-like domain');
}

// ── a failed push throws BEFORE marking the ledger or writing history (B11, T527) ──
{
  const dir = mkdtempSync(join(tmpdir(), 'recommender-notify-fail-'));
  const domain = makeDomain('fail', dir);
  writeRecs(domain.config.recsOut, [rec(43001, 'Delta')]);
  const failingPush = (async () => ({ ok: false, error: 'boom' })) as any;
  await assert.rejects(
    () => runRecsNotify(fakeCtx(), domain, { push: failingPush, now: NOW }),
    /digest push failed \(boom\)/,
    'a failed push throws with the domain-agnostic unified message',
  );
  assert.equal(isWorkItemDone(domain.recsJob, '43001', 1), false, 'not marked notified after a failed push');
  assert.ok(!existsSync(domain.config.recsHistoryOut), 'history file not written after a failed push');
  console.log('  ✓ a failed digest push throws before marking the ledger or writing history — retried next run');
}

console.log('  ✓ shared recommender notify golden-file tests passed');
