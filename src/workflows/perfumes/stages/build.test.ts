// Guards the honest handling of empty Fragrantica notes pyramids. Some pages
// come back with no notes breakdown; the build stage must reflect that without
// fabricating notes (and without silently dropping the section). Covers the
// parse-side normalization (empty stays explicitly empty arrays) and the
// build-prompt clause that branches empty vs. populated.
import assert from 'node:assert/strict';
import {
  confidenceClause,
  confidenceWeight,
  DEFAULT_CONFIDENCE_K,
  notesMappingClause,
  personalFieldsClause,
  voteDistribution,
  votesFromFragJson,
} from './build.js';
import { normalizeNotes, notesEmpty } from './parse.js';
import type { PerfumeInput } from '../types.js';

// ── normalizeNotes: canonical shape; entries trimmed; empty stays empty. ──
{
  const n = normalizeNotes({ top: ['Bergamot', '  Pink   Pepper '], heart: null, base: ['Cedar'] });
  assert.deepEqual(
    n,
    { top: ['Bergamot', 'Pink Pepper'], heart: [], base: ['Cedar'] },
    'tiers coerce to arrays, whitespace collapses, missing tiers become []',
  );
  assert.equal(notesEmpty(n), false, 'a pyramid with any tier populated is not empty');
}

// ── A missing / undefined notes object normalizes to an explicitly-empty pyramid. ──
{
  const n = normalizeNotes(undefined);
  assert.deepEqual(n, { top: [], heart: [], base: [] }, 'absent notes → all tiers explicitly []');
  assert.equal(notesEmpty(n), true);
}

// ── All-empty tiers count as empty; one note anywhere makes it populated. ──
{
  assert.equal(notesEmpty(normalizeNotes({ top: [], heart: [], base: [] })), true);
  assert.equal(notesEmpty(normalizeNotes({ top: ['vanilla'] })), false);
}

// ── EMPTY-SECTION FIXTURE: build clause must mark it empty, never fabricate. ──
{
  const clause = notesMappingClause(JSON.stringify({ notes: { top: [], heart: [], base: [] } }));
  assert.match(clause, /EMPTY/, 'empty pyramid → explicit EMPTY directive');
  assert.match(clause, /empty arrays/, 'tells Claude to keep the tiers as empty arrays');
  assert.match(clause, /do NOT fabricate/i, 'forbids fabricating a substitute pyramid');
  assert.match(clause, /unavailable/i, 'asks the prose to state the breakdown was unavailable');
}

// ── POPULATED FIXTURE: normal mapping clause, not the empty branch. ──
{
  const clause = notesMappingClause(
    JSON.stringify({ notes: { top: ['bergamot'], heart: ['rose'], base: ['musk'] } }),
  );
  assert.match(clause, /from the notes pyramid/, 'populated pyramid → normal map-through clause');
  assert.doesNotMatch(clause, /EMPTY/, 'populated pyramid must not get the empty directive');
}

// ── Malformed JSON is treated as empty (honest fallback) and never throws. ──
{
  const clause = notesMappingClause('not-json{');
  assert.match(clause, /EMPTY/, 'unparseable frag JSON falls back to the empty directive');
}

console.log('  ✓ perfumes empty notes-pyramid handled honestly (normalize + build clause)');

// ───────────── Fragrantica vs LLM confidence blend (sample-size weighting) ─────────────

// ── voteDistribution: k is calibrated to the corpus MEDIAN, percentiles sane. ──
{
  // Mirrors the real corpus spread: niche houses cluster low, designers high.
  const corpus = [18, 20, 48, 144, 339, 1080, 1934, 3753, 11965, 21809];
  const dist = voteDistribution(corpus);
  assert.equal(dist.count, 10, 'every usable vote count contributes to the corpus');
  assert.equal(dist.min, 18);
  assert.equal(dist.max, 21809);
  // median of the 10-element set = mean of the two middle values (339, 1080) = 709.5 → 710
  assert.equal(dist.median, 710, 'median is the interpolated middle of the corpus');
  assert.equal(dist.k, dist.median, 'with no override, k is calibrated to the corpus median');
  assert.ok(dist.p25 < dist.median && dist.median < dist.p75, 'quartiles bracket the median');
}

// ── An explicit override pins k; an empty corpus falls back to the default. ──
{
  assert.equal(voteDistribution([18, 20, 48], 100).k, 100, 'positive override pins k');
  assert.equal(voteDistribution([]).k, DEFAULT_CONFIDENCE_K, 'empty corpus → default k');
  assert.equal(voteDistribution([], 0).k, DEFAULT_CONFIDENCE_K, 'non-positive override ignored');
}

// ── confidenceWeight: continuous, 0.5 at k, monotonic, 0 with no votes. ──
{
  assert.equal(confidenceWeight(100, 100), 0.5, 'weight is exactly 0.5 at votes == k');
  assert.equal(confidenceWeight(null, 100), 0, 'no votes → zero confidence');
  assert.equal(confidenceWeight(0, 100), 0, 'zero votes → zero confidence');
  assert.ok(
    confidenceWeight(20, 100) < confidenceWeight(2000, 100),
    'more votes → strictly higher confidence (continuous, sample-size driven)',
  );
  assert.ok(confidenceWeight(20, 100) > 0 && confidenceWeight(2000, 100) < 1, 'weight stays in (0,1)');
}

// ── votesFromFragJson: reads the vote count; null on absent/unparseable. ──
{
  assert.equal(votesFromFragJson(JSON.stringify({ votes: 1080 })), 1080);
  assert.equal(votesFromFragJson(JSON.stringify({ votes: 0 })), null, 'zero votes → null');
  assert.equal(votesFromFragJson('not-json{'), null, 'unparseable → null');
}

// ── LOW-SAMPLE vs HIGH-SAMPLE fixtures: assert the RELATIVE weighting. ──
{
  const dist = voteDistribution([18, 20, 48, 144, 339, 1080, 1934, 3753, 11965, 21809]);

  // A niche, barely-reviewed perfume (kingdom-scotland-portal had 18 votes).
  const low = votesFromFragJson(JSON.stringify({ votes: 18 }));
  // A designer blockbuster (chanel-bleu-de-chanel had 21809 votes).
  const high = votesFromFragJson(JSON.stringify({ votes: 21809 }));

  const wLow = confidenceWeight(low, dist.k);
  const wHigh = confidenceWeight(high, dist.k);
  assert.ok(wLow < wHigh, 'low-sample perfume gets a strictly lower Fragrantica confidence weight');
  assert.ok(wLow < 0.5 && wHigh > 0.5, 'low sits below half-confidence, high above it');

  const lowClause = confidenceClause(low, dist);
  const highClause = confidenceClause(high, dist);

  // Both clauses make the weighting explicit and route it into the profile.
  assert.match(lowClause, /CONFIDENCE IN FRAGRANTICA/, 'clause is labelled');
  assert.match(lowClause, /Community Sentiment/, 'requires the weighting be stated in the profile');
  assert.match(highClause, /Community Sentiment/, 'high-sample clause also states it in the profile');

  // Low sample → lean on research; high sample → lean on Fragrantica.
  assert.match(lowClause, /LOW \(bottom quartile/, 'low-sample perfume flagged LOW vs corpus');
  assert.match(lowClause, /WEAK low-sample prior/, 'low-sample clause down-weights Fragrantica');
  assert.match(highClause, /HIGH \(top quartile/, 'high-sample perfume flagged HIGH vs corpus');
  assert.match(highClause, /Lean ON the Fragrantica community data/, 'high-sample clause trusts Fragrantica');

  // The numeric blend in the prose reflects the relative weighting.
  const blendPct = (clause: string): number => {
    const m = clause.match(/≈ (\d+)% Fragrantica/);
    assert.ok(m, 'clause states a Fragrantica blend percentage');
    return Number(m[1]);
  };
  assert.ok(
    blendPct(lowClause) < blendPct(highClause),
    'the low-sample blend leans less on Fragrantica than the high-sample blend',
  );
  assert.ok(blendPct(lowClause) < 50 && blendPct(highClause) > 50, 'blend crosses 50% across the samples');
}

console.log('  ✓ perfumes Fragrantica-vs-LLM confidence blend weights by corpus-calibrated sample size');

// ───────────── personalFieldsClause: the 8 owner-authored personal fields (T462) ─────────────

const BASE_PERFUME: PerfumeInput = { id: 'x__y__edp', name: 'X', concentration: 'EDP', brand: 'Y' };

// ── FULLY-POPULATED FIXTURE: every real value appears verbatim + verbatim/no-invention. ──
{
  const p: PerfumeInput = {
    ...BASE_PERFUME,
    rating: 8,
    description: 'A cosy autumn scent I reach for constantly.',
    dateAdded: '05-03-2024',
    ownership: 'Full bottle',
    personalLongevity: 6,
    personalProjection: 3,
    personalSeasons: ['autumn', 'winter'],
    applicationSpots: ['2 to chest', '1 to each wrist'],
  };
  const clause = personalFieldsClause(p);
  assert.match(clause, /rating: 8/, 'rating value appears verbatim');
  assert.match(clause, /"05-03-2024"/, 'date_added value appears verbatim');
  assert.match(clause, /"Full bottle"/, 'ownership value appears verbatim');
  assert.match(clause, /personal_longevity: 6/, 'personal_longevity value appears verbatim');
  assert.match(clause, /personal_projection: 3/, 'personal_projection value appears verbatim');
  assert.match(clause, /\["autumn","winter"\]/, 'personal_seasons values appear verbatim');
  assert.match(clause, /A cosy autumn scent I reach for constantly\./, 'description appears verbatim');
  assert.match(clause, /\["2 to chest","1 to each wrist"\]/, 'applicationSpots appear verbatim');
  assert.match(clause, /copy th(is|ese) exact/i, 'instructs copying the exact value(s)');
  assert.match(clause, /do NOT alter, reinterpret/, 'instructs no alteration/reinterpretation');
  assert.match(clause, /invent additional values/, 'instructs no invention');
}

// ── EMPTY FIXTURE: no personal fields set → honest fallbacks, no fabrication. ──
{
  const clause = personalFieldsClause(BASE_PERFUME);
  assert.match(clause, /rating:.*use null/, 'rating falls back to null');
  assert.match(clause, /date_added:.*use null/, 'date_added falls back to null');
  assert.match(clause, /ownership:.*use null/, 'ownership falls back to null');
  assert.match(clause, /personal_longevity:.*use null/, 'personal_longevity falls back to null');
  assert.match(clause, /personal_projection:.*use null/, 'personal_projection falls back to null');
  assert.match(clause, /personal_seasons:.*empty array/, 'personal_seasons falls back to []');
  assert.match(clause, /Personal Notes section:.*not recorded yet/, 'Personal Notes falls back to placeholder text');
  assert.match(clause, /Application section:.*not recorded yet/, 'Application falls back to placeholder text');
  assert.doesNotMatch(clause, /\d{2}-\d{2}-\d{4}/, 'no fabricated date appears');
  assert.doesNotMatch(clause, /Full bottle|Sample|Travel size/, 'no fabricated ownership value appears');
}

console.log('  ✓ perfumes personalFieldsClause copies real personal values verbatim, falls back honestly otherwise');
