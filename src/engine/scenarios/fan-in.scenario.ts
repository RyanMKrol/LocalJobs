// SCENARIO: fan-out and fan-in, plus a cumulative store.
//
//   px-src ──▶ px-b1 ─┐
//          ──▶ px-b2 ─┼──▶ px-merge ──▶ px-report
//          ──▶ px-b3 ─┘        ▲
//          └───────────────────┘   (merge also reads the source directly)
//
// Three branches each transform the source; the merge takes all three through
// ONE fan-in port and the source through a second port; the report reads the
// merge and commits a small inline value. A branch can be made to misbehave for a
// run through the scenario control file.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { acceptAny, defineStage, fromChecks, inlineArtifact, jsonArtifact } from '../ports.js';
import { inScenario as at, scenarioMode as mode } from '../testing/scenario.js';
import type { JobDefinition, WorkflowDefinition } from '../types.js';

export interface SourceData { run: string; items: string[] }
export interface PartData { branch: string; from: string; upper: string[] }
export interface MergedData { run: string; sourceCount: number; parts: Record<string, string[]> }

export const sourceData = jsonArtifact<SourceData>({
  key: 'px-data',
  description: 'The source list every branch works from.',
  check: (v) => fromChecks([{ label: 'has items', ok: Array.isArray(v?.items) && v.items.length > 0, actual: `${v?.items?.length ?? 0} item(s)` }], `${v?.items?.length ?? 0} item(s)`),
  summary: (v) => `${v.items.length} item(s) from run ${v.run}`,
  items: (v) => v.items.map((i) => ({ id: i, title: i })),
});

export const partData = jsonArtifact<PartData>({
  key: 'px-part',
  description: "One branch's transformed copy of the source list.",
  check: (v) => fromChecks([{ label: 'has an upper array', ok: Array.isArray(v?.upper), actual: Array.isArray(v?.upper) ? `${v.upper.length} item(s)` : 'missing' }]),
  items: (v) => v.upper.map((i) => ({ id: i, title: i, fields: [{ label: 'Branch', value: v.branch }] })),
});

export const mergedData = jsonArtifact<MergedData>({
  key: 'px-merged',
  description: 'Every branch merged, keyed by branch.',
  check: (v) => fromChecks([{ label: 'has parts', ok: !!v?.parts && Object.keys(v.parts).length > 0, actual: `${Object.keys(v?.parts ?? {}).length} branch(es)` }]),
  summary: (v) => `${Object.keys(v.parts).length} branch(es) merged`,
});

export const digest = inlineArtifact<{ branches: number; items: number }>({
  key: 'px-digest',
  description: 'How much the report covered.',
  check: acceptAny,
});

const src = defineStage({
  name: 'px-src',
  outputs: { data: { artifact: sourceData, location: at('data.json') } },
  async run(ctx) {
    ctx.output('data').write({ run: ctx.run.workflowRunId, items: ['a', 'b', 'c'] });
  },
});

function branch(name: string): JobDefinition {
  return defineStage({
    name,
    maxRetries: name === 'px-b3' ? 1 : 0,
    inputs: { data: { artifact: sourceData } },
    outputs: { part: { artifact: partData, location: at(`${name}.json`) } },
    async run(ctx) {
      const data = ctx.input('data').read();
      const part: PartData = { branch: name, from: data.run, upper: data.items.map((i) => `${i.toUpperCase()}-${name}`) };
      switch (mode(name)) {
        case 'fail':
          throw new Error('planned branch failure');
        case 'skip-write':
          // Returns success WITHOUT writing its output: the bug this engine exists
          // to catch. A file from an earlier run may still be sitting at the path.
          return;
        case 'bad-output':
          ctx.output('part').write({ branch: name, from: data.run } as unknown as PartData);
          return;
        case 'write-then-fail-once':
          // Attempt 1 writes a (wrong) output and then fails; the retry writes the
          // right one. Only the retry's artifact may reach the merge.
          if (ctx.run.attempt === 1) {
            ctx.output('part').write({ ...part, upper: ['FROM-FAILED-ATTEMPT'] });
            throw new Error('fails after writing, first attempt only');
          }
          break;
        case 'raw-write':
          // Writes the file itself and never calls commit(): the end-of-run sweep
          // must commit it.
          writeFileSync(ctx.output('part').path, JSON.stringify(part));
          return;
      }
      ctx.output('part').write(part);
    },
  });
}

const merge = defineStage({
  name: 'px-merge',
  inputs: {
    data: { artifact: sourceData },
    parts: { artifact: partData, many: true },
  },
  outputs: { merged: { artifact: mergedData, location: at('merged.json') } },
  async run(ctx) {
    const data = ctx.input('data').read();
    const parts: Record<string, string[]> = {};
    for (const p of ctx.inputs('parts')) {
      const v = p.read();
      parts[p.from] = v.upper;
      ctx.log(`merging ${p.from}: ${v.upper.join(',')}`);
    }
    ctx.input('data').used(data.items.slice(0, 2).map((i) => ({ id: i, title: i })));
    ctx.output('merged').write({ run: data.run, sourceCount: data.items.length, parts });
  },
});

const report = defineStage({
  name: 'px-report',
  inputs: { merged: { artifact: mergedData } },
  outputs: { digest: { artifact: digest } },
  async run(ctx) {
    const m = ctx.input('merged').read();
    ctx.output('digest').write({ branches: Object.keys(m.parts).length, items: Object.values(m.parts).flat().length });
  },
});

// A second, tiny workflow for cumulative stores: px-store adds to a file only when
// told to; px-reader reads it.
export const storeData = jsonArtifact<{ entries: string[] }>({
  key: 'px-store',
  description: 'A store that grows over many runs.',
  check: (v) => fromChecks([{ label: 'has entries', ok: Array.isArray(v?.entries), actual: `${v?.entries?.length ?? 0} entr(ies)` }]),
});
const store = defineStage({
  name: 'px-store',
  outputs: { store: { artifact: storeData, location: at('store.json'), cumulative: true } },
  async run(ctx) {
    if (mode('px-store') === 'nothing-new') return; // leaves the file untouched
    const path = ctx.output('store').path;
    const cur = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { entries: string[] }) : { entries: [] };
    ctx.output('store').write({ entries: [...cur.entries, `entry-${cur.entries.length + 1}`] });
  },
});
const reader = defineStage({
  name: 'px-reader',
  inputs: { store: { artifact: storeData } },
  outputs: { count: { artifact: inlineArtifact<number>({ key: 'px-count', description: 'How many entries were read.', check: acceptAny }) } },
  async run(ctx) {
    const input = ctx.input('store');
    ctx.log(`store is ${input.meta.fresh ? 'fresh' : 'carried forward'}`);
    ctx.output('count').write(input.read().entries.length);
  },
});

export const jobs: JobDefinition[] = [src, branch('px-b1'), branch('px-b2'), branch('px-b3'), merge, report, store, reader];

export const fanInWorkflow: WorkflowDefinition = {
  name: 'px-fan-in',
  maxConcurrency: 3,
  jobs: [
    { job: 'px-src' },
    { job: 'px-b1', dependsOn: ['px-src'] },
    { job: 'px-b2', dependsOn: ['px-src'] },
    { job: 'px-b3', dependsOn: ['px-src'] },
    { job: 'px-merge', dependsOn: ['px-src', 'px-b1', 'px-b2', 'px-b3'] },
    { job: 'px-report', dependsOn: ['px-merge'] },
  ],
};

export const storeWorkflow: WorkflowDefinition = {
  name: 'px-store-wf',
  jobs: [{ job: 'px-store' }, { job: 'px-reader', dependsOn: ['px-store'] }],
};
