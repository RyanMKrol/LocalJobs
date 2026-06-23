import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobContext } from '../../../core/types.js';
import { getWorkItem, isWorkItemDone, markWorkItem } from '../../../db/store.js';
import { runClaude, unfenceMarkdown } from '../claude.js';
import { perfumesConfig } from '../config.js';
import { ensureDirs, label, loadPerfumes, loadVoteCorpus, readJsonFile, reportItemProgress } from '../lib.js';
import { normalizeNotes, notesEmpty } from './parse.js';
import type { PerfumeInput, StageResult } from '../types.js';

export const BUILD_JOB = 'perfumes-build';

/** Stage 4: Claude combines the parsed Fragrantica data + web research into a
 *  profile that follows perfume-markdown's _TEMPLATE.md. */
export async function runBuild(ctx: JobContext): Promise<StageResult> {
  ensureDirs();
  const perfumes = loadPerfumes();
  const urls = readJsonFile<Record<string, string>>(perfumesConfig.urlsFile, {});
  const fragPath = (id: string) => join(perfumesConfig.fragranticaDir, `${id}.json`);
  const pendingOf = () => perfumes.filter((p) => ctx.rootAllowed(p.id) && existsSync(fragPath(p.id)) && !isWorkItemDone(BUILD_JOB, p.id, perfumesConfig.maxAttempts));
  const todo = pendingOf();
  ctx.log(`[build] ${todo.length} profile(s) to build`);

  const template = existsSync(perfumesConfig.templatePath)
    ? readFileSync(perfumesConfig.templatePath, 'utf8')
    : FALLBACK_TEMPLATE;

  // Calibrate the Fragrantica-vs-LLM confidence blend against the WHOLE scraped
  // corpus, so "high" vs "low" vote counts are judged relative to this ecosystem
  // (niche houses cluster low; designer blockbusters cluster high).
  const dist = voteDistribution(loadVoteCorpus(), perfumesConfig.confidenceK);
  ctx.log(
    `[build] confidence calibration: ${dist.count} perfume(s) in corpus, votes ` +
      `min ${dist.min} · p25 ${dist.p25} · median ${dist.median} · p75 ${dist.p75} · max ${dist.max}; ` +
      `half-confidence k=${dist.k} (weight=0.5 at ${dist.k} votes)`,
  );

  let ok = 0;
  let failed = 0;
  let rateLimited = false;
  const cap = perfumesConfig.runLimit > 0 ? perfumesConfig.runLimit : Infinity;
  const total = Math.min(todo.length, cap); // how many we'll actually build this run (progress denominator)

  for (const [i, p] of todo.entries()) {
    if (ok + failed >= cap) break;
    ctx.log(`[build] ${i + 1}/${total} → ${label(p)}`);
    const attempts = (getWorkItem(BUILD_JOB, p.id)?.attempts ?? 0) + 1;
    const fragJson = readFileSync(fragPath(p.id), 'utf8');
    const res = perfumesConfig.dryRun
      ? { ok: true, text: `---\nname: "${p.name}"\nbrand: "${p.brand}"\n---\n# ${p.name} — ${p.brand}\n(dry run)\n`, rateLimited: false }
      : await runClaude(buildPrompt(p, fragJson, urls[p.id] ?? null, template, dist), perfumesConfig.modelBuild);

    if (res.rateLimited) { ctx.log('[build] Claude usage/rate limit — pausing stage; will resume.', 'warn'); rateLimited = true; break; }

    try {
      if (!res.ok) throw new Error(res.error ?? 'claude error');
      const md = unfenceMarkdown(res.text);
      if (!md.startsWith('---') || !md.includes('## Sources')) throw new Error('output is not a template-shaped markdown file');
      const mdPath = join(perfumesConfig.markdownDir, `${p.id}.md`);
      writeFileSync(mdPath, md);
      // Record the artifact path so the dashboard's IO panel can preview it
      // (mirrors places-llm-enrich's detail.markdown — see workItemMarkdownPath).
      markWorkItem(BUILD_JOB, p.id, 'success', { attempts, detail: { name: label(p), markdown: mdPath } });
      ok++;
      ctx.log(`[build] ✓ ${label(p)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
      markWorkItem(BUILD_JOB, p.id, 'failed', { attempts, detail: { name: label(p), error: msg } });
      failed++;
      ctx.log(`[build] ✗ ${label(p)}: ${msg}${attempts >= perfumesConfig.maxAttempts ? ' — giving up' : ''}`, 'warn');
    }
    reportItemProgress(ctx, i + 1, total, `${ok} ok, ${failed} failed`);
  }

  return { ok, failed, pending: pendingOf().length, rateLimited };
}

function buildPrompt(
  p: PerfumeInput,
  fragJson: string,
  url: string | null,
  template: string,
  dist: VoteDistribution,
): string {
  return [
    'You are writing one perfume profile for a personal fragrance "second brain". Produce a single',
    'Markdown file that EXACTLY follows the TEMPLATE at the end — same YAML frontmatter keys, same',
    'section headings, valid YAML, no extra keys.',
    '',
    `PERFUME: "${p.name}" (${p.concentration}) by ${p.brand}.`,
    '',
    'FRAGRANTICA DATA — already fetched from the live page; treat this as the community-signal source',
    'and map it into the frontmatter (but weight it by the confidence below):',
    fragJson,
    `Fragrantica URL: ${url ?? '(none)'}`,
    '',
    confidenceClause(votesFromFragJson(fragJson), dist),
    '',
    'MAPPING RULES:',
    `- Set fragrantica_status: "ok" and fragrantica_url: "${url ?? ''}" (the page WAS fetched).`,
    '- gender: pick the leading category from the gender votes → one of feminine | unisex | masculine.',
    '- longevity: from the longevity votes → one of weak | moderate | long | very long (long lasting/eternal → "long"/"very long").',
    '- sillage: from the sillage votes → one of intimate | moderate | strong | enormous.',
    '- season / time: from whenToWear (note Fragrantica uses "fall" = autumn). occasion/mood: your judgement from the data + reviews.',
    '- accords: the dominant accords (3–6, lowercase).',
    notesMappingClause(fragJson),
    '- community_rating: "<rating> / 5 (<votes> votes)" from the rating + votes (null if absent).',
    '',
    'RESEARCH THE REST (web search): perfumer, release year, olfactory family, the house/story, and a few',
    'similar fragrances. Cite at least ONE reputable source IN ADDITION to Fragrantica (≥2 sources total)',
    'in BOTH the ## Sources section and the sources: frontmatter list.',
    '',
    'RULES:',
    '- Fill EVERY researched frontmatter field and EVERY researched section (Overview, Olfactory Profile,',
    '  Community Sentiment, Recommended Settings, Similar Fragrances, History & Background).',
    '- Leave personal scaffolding blank: rating: null, status: "owned", and empty Personal Notes / Application.',
    '- NEVER invent votes, notes, a perfumer, or a year. Use null or "unknown" for anything you genuinely',
    '  cannot find. Honest gaps beat fabrication.',
    '',
    'Reply with ONLY the Markdown file content, starting at the opening "---" — no code fences, no commentary.',
    '',
    '--- TEMPLATE ---',
    template,
  ].join('\n');
}

// ───────────────────────── Fragrantica vs LLM confidence blend ─────────────────────────
//
// Niche houses get very few community votes, so their Fragrantica longevity/
// sillage/season/gender/rating distributions are noisy and shouldn't outweigh
// the LLM's own multi-source web research. Designer blockbusters get tens of
// thousands of votes — there the community signal is the most reliable source.
// We model that with a CONTINUOUS sample-size confidence weight votes/(votes+k),
// calibrated so the corpus-median perfume sits at weight 0.5.

/** The corpus-wide vote-count distribution used to calibrate the confidence
 *  blend. `k` is the half-confidence point (weight 0.5 at `k` votes). */
export interface VoteDistribution {
  count: number; // perfumes contributing a usable vote count
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  k: number;
}

/** Fallback half-confidence point when the corpus is empty (no scraped data yet)
 *  and no explicit override is configured. */
export const DEFAULT_CONFIDENCE_K = 50;

/** Linear-interpolation quantile of an ascending-sorted, non-empty array. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Summarise the corpus-wide vote distribution and pick the calibration constant
 * `k`. With no override, `k` is the corpus MEDIAN vote count (rounded, ≥1), so
 * the typical perfume in *this* ecosystem sits at confidence 0.5 — that's what
 * makes "high" vs "low" relative to the scraped corpus rather than an arbitrary
 * absolute. An explicit positive `kOverride` pins it. An empty corpus falls back
 * to {@link DEFAULT_CONFIDENCE_K}.
 */
export function voteDistribution(votesList: number[], kOverride?: number | null): VoteDistribution {
  const sorted = votesList.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) {
    const k = kOverride && kOverride > 0 ? Math.round(kOverride) : DEFAULT_CONFIDENCE_K;
    return { count: 0, min: 0, p25: 0, median: 0, p75: 0, max: 0, k };
  }
  const median = Math.round(quantile(sorted, 0.5));
  const k = kOverride && kOverride > 0 ? Math.round(kOverride) : Math.max(1, median);
  return {
    count: sorted.length,
    min: sorted[0],
    p25: Math.round(quantile(sorted, 0.25)),
    median,
    p75: Math.round(quantile(sorted, 0.75)),
    max: sorted[sorted.length - 1],
    k,
  };
}

/**
 * Continuous confidence in Fragrantica's community signal from its sample size:
 * `votes / (votes + k)`, in `[0, 1)`. At `votes == k` the weight is exactly 0.5;
 * it rises toward 1 with more votes and falls toward 0 with fewer. No votes (or
 * null/non-finite) → 0: zero community confidence, defer entirely to research.
 */
export function confidenceWeight(votes: number | null | undefined, k: number): number {
  if (votes == null || !Number.isFinite(votes) || votes <= 0) return 0;
  if (k <= 0) return 1;
  return votes / (votes + k);
}

/** Pull the community vote count out of a parsed-Fragrantica JSON blob. Returns
 *  null for absent/zero votes or unparseable JSON (→ zero confidence). */
export function votesFromFragJson(fragJson: string): number | null {
  try {
    const v = (JSON.parse(fragJson) as { votes?: unknown }).votes;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * The build-prompt clause that tells Claude HOW MUCH to trust the Fragrantica
 * community data versus its own web research, based on this perfume's vote count
 * relative to the scraped corpus. Emits the explicit numeric weight, where the
 * perfume sits in the corpus distribution, and a directive that leans toward the
 * community data when the weight is high and toward multi-source research when
 * it's low — and requires the chosen weighting to be stated in the built profile
 * (the Community Sentiment section).
 */
export function confidenceClause(votes: number | null, dist: VoteDistribution): string {
  const w = confidenceWeight(votes, dist.k);
  const fragPct = Math.round(w * 100);
  const researchPct = 100 - fragPct;
  const band =
    votes == null
      ? 'NO community votes — treat Fragrantica as essentially unsupported here'
      : votes >= dist.p75
        ? `HIGH (top quartile of the corpus; p75 ≈ ${dist.p75} votes)`
        : votes <= dist.p25
          ? `LOW (bottom quartile of the corpus; p25 ≈ ${dist.p25} votes)`
          : `MID (around the corpus median ≈ ${dist.median} votes)`;
  const lean =
    w >= 0.5
      ? 'Lean ON the Fragrantica community data for the subjective fields (longevity, sillage, ' +
        'season/time, gender, rating) — the sample is large enough to trust. Use web research to ' +
        'fill gaps and corroborate, not to override it.'
      : 'Lean ON your own multi-source web research for the subjective fields (longevity, sillage, ' +
        'season/time, gender, rating). Treat the Fragrantica votes as a WEAK low-sample prior — ' +
        'follow it only where independent sources agree, and prefer research consensus when they conflict.';
  return [
    `CONFIDENCE IN FRAGRANTICA (sample-size weighted): this perfume has ${votes ?? 0} community vote(s) — ${band}.`,
    `Calibrated against the whole scraped corpus (half-confidence at k=${dist.k} votes), the confidence weight is ${w.toFixed(2)}.`,
    `So blend the subjective community fields ≈ ${fragPct}% Fragrantica / ${researchPct}% your web research.`,
    lean,
    `Make this EXPLICIT in the profile: in the Community Sentiment section, state the confidence — e.g. "Community-signal confidence: ${fragPct}% (${votes ?? 0} votes, ${votes == null ? 'no votes' : band.split(' ')[0].toLowerCase()} sample) — weighted ${fragPct}% Fragrantica / ${researchPct}% independent research."`,
  ].join('\n');
}

/**
 * The build-prompt clause for mapping the notes pyramid into the profile.
 *
 * Some Fragrantica pages come back with an empty notes pyramid. When that
 * happens we tell Claude EXPLICITLY to keep `notes.top/heart/base` as empty
 * arrays (present but explicitly empty — never dropped from the frontmatter)
 * and to say plainly that the notes breakdown was unavailable — rather than
 * fabricating or web-researching a substitute pyramid. A populated pyramid gets
 * the normal "map it through" instruction. Never throws on malformed JSON: an
 * unparseable blob is treated as an empty pyramid (the honest fallback).
 */
export function notesMappingClause(fragJson: string): string {
  let notes;
  try {
    notes = normalizeNotes((JSON.parse(fragJson) as { notes?: unknown }).notes);
  } catch {
    notes = normalizeNotes(undefined);
  }
  if (notesEmpty(notes)) {
    return [
      '- notes.top/heart/base: the Fragrantica notes pyramid is EMPTY for this perfume.',
      '  Keep notes.top, notes.heart and notes.base as empty arrays ([]) — do NOT fabricate',
      '  a pyramid or substitute web-researched notes — and state plainly in the Olfactory',
      '  Profile that a notes breakdown was unavailable for this fragrance.',
    ].join('\n');
  }
  return '- notes.top/heart/base: from the notes pyramid in the Fragrantica data above (do not invent extra notes).';
}

const FALLBACK_TEMPLATE = '---\nname: ""\nbrand: ""\nyear: null\nperfumer: ""\nconcentration: ""\nfamily: ""\naccords: []\nnotes:\n  top: []\n  heart: []\n  base: []\nseason: []\ntime: []\noccasion: []\nmood: []\ngender: ""\nlongevity: ""\nsillage: ""\ncommunity_rating: null\nfragrantica_status: "ok"\nfragrantica_url: null\nrating: null\nstatus: "owned"\nsources: []\n---\n\n# Name — Brand\n\n## Overview\n\n## Olfactory Profile\n\n## Community Sentiment\n\n## Recommended Settings\n\n## Similar Fragrances\n\n## History & Background\n\n## Personal Notes\n\n## Application\n\n## Sources\n';
