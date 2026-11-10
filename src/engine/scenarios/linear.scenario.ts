// SCENARIO: a linear pipeline.
//
//   ln-fetch ──▶ ln-transform ──▶ ln-publish
//
// The simplest shape: each stage reads the one before. Used to check the basics
// in isolation: data flows down the chain, a bad output stops it at the source, a
// failure mid-chain skips what follows, retries, and cancelling.
import { writeFileSync } from 'node:fs';
import { acceptAny, defineStage, fileArtifact, fromChecks, inlineArtifact, jsonArtifact } from '../ports.js';
import { inScenario as at, scenarioMode as mode } from '../testing/scenario.js';
import type { JobDefinition, WorkflowDefinition } from '../types.js';

export const fetched = jsonArtifact<{ rows: number[] }>({
  key: 'ln-fetched',
  description: 'The rows fetched from the source.',
  check: (v) => fromChecks([{ label: 'has at least one row', ok: Array.isArray(v?.rows) && v.rows.length > 0, actual: `${v?.rows?.length ?? 0} row(s)` }]),
  summary: (v) => `${v.rows.length} row(s)`,
});
export const transformed = jsonArtifact<{ doubled: number[] }>({
  key: 'ln-transformed',
  description: 'Each row doubled.',
  check: (v) => fromChecks([{ label: 'has a doubled array', ok: Array.isArray(v?.doubled), actual: Array.isArray(v?.doubled) ? `${v.doubled.length} value(s)` : 'missing' }]),
});
export const report = fileArtifact({
  key: 'ln-report',
  description: 'The published report.',
  format: 'markdown',
  check: (f) => fromChecks([{ label: 'is not empty', ok: f.bytes > 0, actual: `${f.bytes} byte(s)` }]),
});
const total = inlineArtifact<number>({ key: 'ln-total', description: 'The sum that was published.', check: acceptAny });

const fetch = defineStage({
  name: 'ln-fetch',
  outputs: { fetched: { artifact: fetched, location: at('fetched.json') } },
  async run(ctx) {
    ctx.log(`run ${ctx.run.workflowRunId}, attempt ${ctx.run.attempt}`);
    ctx.output('fetched').write({ rows: mode('ln-fetch') === 'empty' ? [] : [1, 2, 3] });
  },
});

const transform = defineStage({
  name: 'ln-transform',
  maxRetries: 1,
  inputs: { fetched: { artifact: fetched } },
  outputs: { transformed: { artifact: transformed, location: at('transformed.json') } },
  async run(ctx) {
    const m = mode('ln-transform');
    if (m === 'fail') throw new Error('transform is broken');
    // (A timer keeps the process alive: a bare never-settling promise would let Node exit.)
    if (m === 'hang') await new Promise(() => { setInterval(() => {}, 1000); });
    ctx.output('transformed').write({ doubled: ctx.input('fetched').read().rows.map((n) => n * 2) });
  },
});

const publish = defineStage({
  name: 'ln-publish',
  inputs: { transformed: { artifact: transformed } },
  outputs: { report: { artifact: report, location: at('report.md') }, total: { artifact: total } },
  async run(ctx) {
    const { doubled } = ctx.input('transformed').read();
    const sum = doubled.reduce((a, b) => a + b, 0);
    // A stage may write a file however it likes; the engine commits it at the end.
    writeFileSync(ctx.output('report').path, `# Report\n\nSum: ${sum}\n`);
    ctx.output('total').write(sum);
  },
});

export const jobs: JobDefinition[] = [fetch, transform, publish];

export const linearWorkflow: WorkflowDefinition = {
  name: 'ln-linear',
  jobs: [{ job: 'ln-fetch' }, { job: 'ln-transform', dependsOn: ['ln-fetch'] }, { job: 'ln-publish', dependsOn: ['ln-transform'] }],
};
