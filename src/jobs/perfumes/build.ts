import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobContext } from '../../core/types.js';
import { getWorkItem, isWorkItemDone, markWorkItem } from '../../db/store.js';
import { runClaude, unfenceMarkdown } from './claude.js';
import { perfumesConfig } from './config.js';
import { ensureDirs, label, loadPerfumes, readJsonFile } from './lib.js';
import type { PerfumeInput, StageResult } from './types.js';

export const BUILD_JOB = 'perfumes-build';

/** Stage 4: Claude combines the parsed Fragrantica data + web research into a
 *  profile that follows perfume-markdown's _TEMPLATE.md. */
export async function runBuild(ctx: JobContext): Promise<StageResult> {
  ensureDirs();
  const perfumes = loadPerfumes();
  const urls = readJsonFile<Record<string, string>>(perfumesConfig.urlsFile, {});
  const fragPath = (id: string) => join(perfumesConfig.fragranticaDir, `${id}.json`);
  const pendingOf = () => perfumes.filter((p) => existsSync(fragPath(p.id)) && !isWorkItemDone(BUILD_JOB, p.id, perfumesConfig.maxAttempts));
  const todo = pendingOf();
  ctx.log(`[build] ${todo.length} profile(s) to build`);

  const template = existsSync(perfumesConfig.templatePath)
    ? readFileSync(perfumesConfig.templatePath, 'utf8')
    : FALLBACK_TEMPLATE;

  let ok = 0;
  let failed = 0;
  let rateLimited = false;
  const cap = perfumesConfig.runLimit > 0 ? perfumesConfig.runLimit : Infinity;

  for (const p of todo) {
    if (ok + failed >= cap) break;
    const attempts = (getWorkItem(BUILD_JOB, p.id)?.attempts ?? 0) + 1;
    const fragJson = readFileSync(fragPath(p.id), 'utf8');
    const res = perfumesConfig.dryRun
      ? { ok: true, text: `---\nname: "${p.name}"\nbrand: "${p.brand}"\n---\n# ${p.name} — ${p.brand}\n(dry run)\n`, rateLimited: false }
      : await runClaude(buildPrompt(p, fragJson, urls[p.id] ?? null, template), perfumesConfig.modelBuild);

    if (res.rateLimited) { ctx.log('[build] Claude usage/rate limit — pausing stage; will resume.', 'warn'); rateLimited = true; break; }

    try {
      if (!res.ok) throw new Error(res.error ?? 'claude error');
      const md = unfenceMarkdown(res.text);
      if (!md.startsWith('---') || !md.includes('## Sources')) throw new Error('output is not a template-shaped markdown file');
      writeFileSync(join(perfumesConfig.markdownDir, `${p.id}.md`), md);
      markWorkItem(BUILD_JOB, p.id, 'success', { attempts, detail: { name: label(p) } });
      ok++;
      ctx.log(`[build] ✓ ${label(p)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
      markWorkItem(BUILD_JOB, p.id, 'failed', { attempts, detail: { name: label(p), error: msg } });
      failed++;
      ctx.log(`[build] ✗ ${label(p)}: ${msg}${attempts >= perfumesConfig.maxAttempts ? ' — giving up' : ''}`, 'warn');
    }
  }

  return { ok, failed, pending: pendingOf().length, rateLimited };
}

function buildPrompt(p: PerfumeInput, fragJson: string, url: string | null, template: string): string {
  return [
    'You are writing one perfume profile for a personal fragrance "second brain". Produce a single',
    'Markdown file that EXACTLY follows the TEMPLATE at the end — same YAML frontmatter keys, same',
    'section headings, valid YAML, no extra keys.',
    '',
    `PERFUME: "${p.name}" (${p.concentration}) by ${p.brand}.`,
    '',
    'FRAGRANTICA DATA — already fetched from the live page; treat this as the community-signal source',
    'of truth and map it into the frontmatter:',
    fragJson,
    `Fragrantica URL: ${url ?? '(none)'}`,
    '',
    'MAPPING RULES:',
    `- Set fragrantica_status: "ok" and fragrantica_url: "${url ?? ''}" (the page WAS fetched).`,
    '- gender: pick the leading category from the gender votes → one of feminine | unisex | masculine.',
    '- longevity: from the longevity votes → one of weak | moderate | long | very long (long lasting/eternal → "long"/"very long").',
    '- sillage: from the sillage votes → one of intimate | moderate | strong | enormous.',
    '- season / time: from whenToWear (note Fragrantica uses "fall" = autumn). occasion/mood: your judgement from the data + reviews.',
    '- accords: the dominant accords (3–6, lowercase). notes.top/heart/base: from the notes pyramid.',
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

const FALLBACK_TEMPLATE = '---\nname: ""\nbrand: ""\nyear: null\nperfumer: ""\nconcentration: ""\nfamily: ""\naccords: []\nnotes:\n  top: []\n  heart: []\n  base: []\nseason: []\ntime: []\noccasion: []\nmood: []\ngender: ""\nlongevity: ""\nsillage: ""\ncommunity_rating: null\nfragrantica_status: "ok"\nfragrantica_url: null\nrating: null\nstatus: "owned"\nsources: []\n---\n\n# Name — Brand\n\n## Overview\n\n## Olfactory Profile\n\n## Community Sentiment\n\n## Recommended Settings\n\n## Similar Fragrances\n\n## History & Background\n\n## Personal Notes\n\n## Application\n\n## Sources\n';
