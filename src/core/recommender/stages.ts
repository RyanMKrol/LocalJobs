// The recommender pipeline's stages and the data they exchange, generic over the
// domain (movies or TV), built on the workflow engine's ports.
//
//   snapshot ──▶ N branches ──▶ merge ──▶ notify
//      └──────────────────────────▲   (merge also reads the snapshot + taste profile)
//
// A domain calls `recommenderArtifacts` once to get its artifact types, then
// builds its branch / merge / notify stages from the makers here. The snapshot
// stage stays in the domain (it is the part that knows Plex's movie or TV shape).
//
// Nothing in this pipeline writes a ledger row for the dashboard's benefit. What
// each stage read and wrote is the engine's own record: a branch's output is its
// suggestions file, its real input is the SAMPLE of the library it put in its
// prompt (reported with `input.used()`), and the only ledger left is the one that
// does a job: `domain.recsJob`, which remembers what has already been announced.
import { join } from 'node:path';
import {
  defineStage, fileArtifact, fromChecks, inlineArtifact, jsonArtifact,
  type ArtifactType, type FileInfo, type IoItem, type JobDefinition, type StateDecl,
} from '../../engine/index.js';
import { runBranch, type BranchRunOpts } from './branch.js';
import { runMerge, type MergeRunOpts } from './merge.js';
import { runRecsNotify, type NotifyResult, type NotifyRunOpts } from './notify.js';
import type { BranchOutputFile, Recommendation, RecommendationsFile, RecommenderDomain } from './types.js';

/** What every owned item has in common, as far as display goes. */
interface OwnedItem {
  title: string;
  year?: number | null;
  tmdbId?: number | null;
  ratingKey?: string;
}

const titled = (title: string, year?: number | null) => `${title}${year ? ` (${year})` : ''}`;

function ownedItemRow(item: OwnedItem, index: number): IoItem {
  return {
    id: item.tmdbId != null ? String(item.tmdbId) : (item.ratingKey ?? String(index)),
    title: titled(item.title, item.year),
    fields: item.tmdbId != null ? [{ label: 'TMDB', value: String(item.tmdbId) }] : [],
  };
}

function recommendationRow(r: Recommendation): IoItem {
  return {
    id: String(r.tmdbId),
    title: titled(r.title, r.year),
    subtitle: r.reason,
    fields: [
      { label: 'Lens', value: r.lens },
      { label: 'Genre', value: r.genre },
      ...(r.tmdbRating != null ? [{ label: 'TMDB', value: r.tmdbRating.toFixed(1) }] : []),
    ],
  };
}

export interface RecommenderArtifacts {
  /** The owned library, one entry per title. */
  snapshot: ArtifactType<unknown>;
  /** What the library leans towards (genres, people, decades, countries). */
  taste: ArtifactType<unknown>;
  /** One branch's raw suggestions. Every branch outputs this SAME artifact; the merge takes them all. */
  suggestions: ArtifactType<BranchOutputFile>;
  /** The verified, deduped, balanced list. */
  recommendations: ArtifactType<RecommendationsFile>;
  /** The markdown report of the current recommendations. */
  report: ArtifactType<FileInfo>;
  /** What one run announced. */
  digest: ArtifactType<NotifyResult>;
}

/**
 * The artifact types of one recommender domain. `prefix` namespaces the keys
 * (`tv` → `tv-snapshot`, `tv-branch-suggestions`, …); `noun` is the plural used
 * in summaries ("shows", "movies").
 */
export function recommenderArtifacts<M extends OwnedItem, P>(
  domain: RecommenderDomain<M, P>,
  prefix: string,
  noun: string,
): RecommenderArtifacts {
  const itemsOf = (v: unknown): M[] | null => {
    // The list must actually be there: `domain.itemsOf` alone would turn a file
    // with no list at all into "an empty library".
    if (!v || typeof v !== 'object' || !Array.isArray((v as Record<string, unknown>)[domain.snapshotListKey])) return null;
    try {
      const items = domain.itemsOf(v);
      return Array.isArray(items) ? items : null;
    } catch {
      return null;
    }
  };

  const snapshot = jsonArtifact<unknown>({
    key: `${prefix}-snapshot`,
    description: `The Plex library snapshot: every one of the owned ${noun}, each with its TMDB id and taste metadata.`,
    shape: {
      summary: `The fresh Plex snapshot of the owned ${noun}.`,
      format: 'JSON object',
      expectations: [
        { label: `Contains the ${noun} list`, detail: 'The library may legitimately be empty.' },
        { label: 'Titles carry a TMDB id', detail: 'A Plex change that drops the tmdb:// GUIDs is caught here.' },
      ],
    },
    check(v) {
      const items = itemsOf(v);
      if (!items) return fromChecks([{ label: `Contains the ${noun} list`, ok: false, actual: `no ${noun} list` }]);
      const withTmdb = items.filter((i) => typeof i.tmdbId === 'number').length;
      return fromChecks(
        [
          { label: `Contains the ${noun} list`, ok: true, actual: `${items.length} ${noun}` },
          // An empty library is acceptable; a NON-empty one with no ids at all means the GUIDs stopped coming through.
          { label: 'Titles carry a TMDB id', ok: items.length === 0 || withTmdb > 0, actual: `${withTmdb}/${items.length} with a TMDB id` },
        ],
        `${items.length} ${noun}, ${withTmdb} with a TMDB id`,
      );
    },
    summary: (v) => {
      const items = itemsOf(v) ?? [];
      return `${items.length} ${noun}, ${items.filter((i) => typeof i.tmdbId === 'number').length} with a TMDB id`;
    },
    count: (v) => (itemsOf(v) ?? []).length,
    items: (v) => (itemsOf(v) ?? []).map(ownedItemRow),
  });

  const taste = jsonArtifact<unknown>({
    key: `${prefix}-taste-profile`,
    description: `What the owned ${noun} lean towards: genres, people, decades and countries, counted across the whole library.`,
    check(v) {
      let ok = false;
      try {
        const p = domain.profileOf(v);
        ok = !!p && typeof p === 'object';
      } catch { /* a profile that cannot be read is not a profile */ }
      return fromChecks([{ label: 'Contains a taste profile', ok, actual: ok ? 'present' : 'missing' }]);
    },
    summary: () => 'taste profile',
  });

  const suggestions = jsonArtifact<BranchOutputFile>({
    key: `${prefix}-branch-suggestions`,
    description: 'Raw suggestions from one recommender branch, before verification. May be empty: a branch with nothing to ask, or one that hit a usage limit, still hands over its file.',
    check(v) {
      const ok = Array.isArray(v?.suggestions);
      const note = v?.error ? ` [${v.error}]` : '';
      return fromChecks(
        [{ label: 'Contains the suggestions list', ok, actual: ok ? `${v.suggestions.length} suggestion(s)${note}` : 'no suggestions list' }],
        ok ? `${v.suggestions.length} suggestion(s)${note}` : undefined,
      );
    },
    summary: (v) => `${v.suggestions.length} suggestion(s)${v.error ? ` [${v.error}]` : ''}`,
    count: (v) => v.suggestions.length,
    items: (v) => v.suggestions.map((s, i) => ({
      id: String(i),
      title: titled(s.title, s.year),
      subtitle: s.reason,
      fields: [{ label: 'Lens', value: s.lens }],
    })),
  });

  const recommendations = jsonArtifact<RecommendationsFile>({
    key: `${prefix}-recommendations`,
    description: 'The TMDB-verified, deduped, balanced recommendation list. May be empty when nothing passed the quality bar.',
    check(v) {
      const recs = Array.isArray(v?.recommendations) ? v.recommendations : null;
      if (!recs) return fromChecks([{ label: 'Contains the recommendations list', ok: false, actual: 'no recommendations list' }]);
      const bad = recs.find((r) => typeof r.tmdbId !== 'number' || !r.title);
      return fromChecks(
        [
          { label: 'Contains the recommendations list', ok: true, actual: `${recs.length} recommendation(s)` },
          { label: 'Every recommendation is a verified title', ok: !bad, actual: bad ? `one has no TMDB id or title: ${JSON.stringify(bad).slice(0, 80)}` : 'all verified' },
        ],
        `${recs.length} recommendation(s) (pooled ${v.pooled ?? '?'})`,
      );
    },
    summary: (v) => `${v.recommendations.length} recommendation(s) (pooled ${v.pooled ?? '?'})`,
    count: (v) => v.recommendations.length,
    items: (v) => v.recommendations.map(recommendationRow),
  });

  const report = fileArtifact({
    key: `${prefix}-recs-report`,
    description: 'The markdown report of the current recommendations.',
    format: 'markdown',
    check: (f) => fromChecks([{ label: 'Is not empty', ok: f.bytes > 0, actual: `${f.bytes} byte(s)` }]),
  });

  const digest = inlineArtifact<NotifyResult>({
    key: `${prefix}-recs-digest`,
    description: 'What this run announced: how many recommendations were new, and how many were already announced or dismissed.',
    check: (v) => fromChecks([{ label: 'Has an announced count', ok: typeof v?.announced === 'number', actual: String(v?.announced) }]),
    summary: (v) => `${v.announced} announced, ${v.alreadyAnnounced} already announced, ${v.ignored} dismissed`,
  });

  return { snapshot, taste, suggestions, recommendations, report, digest };
}

/** The cross-run state the branches and the merge read: declared so it is visible on the stage. */
function recommenderState<M, P>(domain: RecommenderDomain<M, P>, access: 'read' | 'readwrite'): StateDecl[] {
  return [
    {
      kind: 'file',
      name: 'recs-history',
      access,
      path: () => domain.config.recsHistoryOut,
      note: 'Titles recommended in earlier runs, appended by the notify stage and fed back into prompts so picks vary.',
    },
    {
      kind: 'ledger',
      name: domain.recsJob,
      access,
      note: 'Which recommendations have already been announced, and which the owner dismissed. Written by the notify stage and the dashboard.',
    },
  ];
}

export interface StageHooks<O> {
  /** Runs before the stage does anything (e.g. create the output directories). */
  before?: () => void;
  /** Extra options for the underlying run function (tests inject fakes here). */
  runOpts?: O;
}

/**
 * ONE recommender branch. Reads the snapshot and the taste profile, asks Claude,
 * commits its suggestions file. It tells the engine which owned titles it
 * actually put in its prompt, so the run page shows that sample as its input
 * rather than the whole library.
 */
export function makeBranchStage<M extends OwnedItem, P>(
  domain: RecommenderDomain<M, P>,
  artifacts: RecommenderArtifacts,
  id: string,
  hooks: StageHooks<BranchRunOpts> = {},
): JobDefinition {
  const spec = domain.branches.find((b) => b.id === id);
  if (!spec) throw new Error(`unknown recommender branch: ${id}`);
  return defineStage({
    name: spec.id,
    description: spec.description,
    timeoutMs: 600_000, // ~10 min headroom for one Claude CLI call
    maxRetries: 1, //      a rate limit or junk reply is handled in-stage; any other Claude failure throws and gets this one retry
    inputs: { snapshot: { artifact: artifacts.snapshot }, taste: { artifact: artifacts.taste } },
    outputs: { suggestions: { artifact: artifacts.suggestions, location: () => join(domain.config.recsDir, `${spec.id}.json`) } },
    state: recommenderState(domain, 'read'),
    async run(ctx) {
      hooks.before?.();
      const snapshot = ctx.input('snapshot');
      await runBranch(ctx, domain, spec, {
        ...hooks.runOpts,
        snapshotFile: hooks.runOpts?.snapshotFile ?? snapshot.path,
        tasteFile: hooks.runOpts?.tasteFile ?? ctx.input('taste').path,
        onBranchWritten: (branchId, opts, sampledItems) => {
          if (Array.isArray(sampledItems)) snapshot.used((sampledItems as OwnedItem[]).map(ownedItemRow));
          hooks.runOpts?.onBranchWritten?.(branchId, opts, sampledItems);
        },
      });
      // The suggestions file is written by runBranch on every path that returns;
      // the engine commits it (and fails the stage if it was not written).
    },
  });
}

/**
 * The merge: the fan-in. Takes EVERY branch's suggestions through one port, plus
 * the snapshot (to drop titles already owned) and the taste profile (to re-prompt
 * when short), and commits the verified list.
 */
export function makeMergeStage<M extends OwnedItem, P>(
  domain: RecommenderDomain<M, P>,
  artifacts: RecommenderArtifacts,
  def: { name: string; description: string; timeoutMs?: number; maxRetries?: number },
  hooks: StageHooks<MergeRunOpts> = {},
): JobDefinition {
  return defineStage({
    ...def,
    inputs: {
      snapshot: { artifact: artifacts.snapshot },
      taste: { artifact: artifacts.taste },
      branches: { artifact: artifacts.suggestions, many: true },
    },
    outputs: { recommendations: { artifact: artifacts.recommendations, location: () => domain.config.recsOut } },
    state: recommenderState(domain, 'read'),
    async run(ctx) {
      hooks.before?.();
      const branches = ctx.inputs('branches');
      ctx.log(`Merging ${branches.length} branch(es): ${branches.map((b) => b.from).join(', ')}`);
      await runMerge(ctx, domain, {
        ...hooks.runOpts,
        snapshotFile: hooks.runOpts?.snapshotFile ?? ctx.input('snapshot').path,
        tasteFile: hooks.runOpts?.tasteFile ?? ctx.input('taste').path,
        // Exactly the files this run's branches committed: never "whatever is in the folder".
        branchFiles: branches.map((b) => b.path),
      });
    },
  });
}

/**
 * The notify stage. Announces the recommendations not announced before, records
 * them in the `recsJob` ledger (the one ledger that does a job here), rewrites
 * the report and appends to the history.
 */
export function makeNotifyStage<M extends OwnedItem, P>(
  domain: RecommenderDomain<M, P>,
  artifacts: RecommenderArtifacts,
  def: { name: string; description: string; timeoutMs?: number; maxRetries?: number },
  hooks: StageHooks<NotifyRunOpts> = {},
): JobDefinition {
  return defineStage({
    ...def,
    inputs: { recommendations: { artifact: artifacts.recommendations } },
    outputs: {
      report: { artifact: artifacts.report, location: () => join(domain.config.reportDir, domain.reportFilename) },
      digest: { artifact: artifacts.digest },
    },
    state: recommenderState(domain, 'readwrite'),
    product: true,
    // An announced recommendation, as the run page shows it.
    describeItem: (d) => ({
      title: typeof d.name === 'string' ? d.name : String(d.title ?? ''),
      subtitle: typeof d.reason === 'string' ? d.reason : undefined,
      fields: [
        ...(typeof d.lens === 'string' ? [{ label: 'Lens', value: d.lens }] : []),
        ...(typeof d.genre === 'string' ? [{ label: 'Genre', value: d.genre }] : []),
        ...(typeof d.tmdbRating === 'number' ? [{ label: 'TMDB', value: d.tmdbRating.toFixed(1) }] : []),
      ],
      preview: typeof d.markdown === 'string' ? { path: d.markdown, format: 'markdown' } : undefined,
    }),
    async run(ctx) {
      hooks.before?.();
      const result = await runRecsNotify(ctx, domain, {
        ...hooks.runOpts,
        recsFile: hooks.runOpts?.recsFile ?? ctx.input('recommendations').path,
      });
      ctx.output('digest').write(result);
      // The report is rewritten on every run; the engine commits it.
    },
  });
}
