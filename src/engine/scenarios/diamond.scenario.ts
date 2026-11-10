// SCENARIO: a diamond, with several DIFFERENT inputs joining.
//
//              ┌──▶ dm-left  ──┐
//   dm-source ─┤               ├──▶ dm-join
//              └──▶ dm-right ──┘
//
// Unlike a fan-in (many producers of the SAME artifact through one port), the
// join here has two separate input ports, each fed by a different stage with a
// different artifact. The two sides run in parallel; the join waits for both.
import { defineStage, fromChecks, jsonArtifact } from '../ports.js';
import { inScenario as at, scenarioMode as mode } from '../testing/scenario.js';
import type { JobDefinition, WorkflowDefinition } from '../types.js';

const hasValue = (v: { value?: unknown }) => fromChecks([{ label: 'has a value', ok: typeof v?.value === 'number', actual: String(v?.value) }]);
export const source = jsonArtifact<{ value: number }>({ key: 'dm-source', description: 'The starting number.', check: hasValue });
export const left = jsonArtifact<{ value: number; at: number[] }>({ key: 'dm-left', description: 'The number plus one.', check: hasValue });
export const right = jsonArtifact<{ value: number; at: number[] }>({ key: 'dm-right', description: 'The number times ten.', check: hasValue });
export const joined = jsonArtifact<{ value: number; startedAt: number }>({ key: 'dm-joined', description: 'Both sides added together.', check: hasValue });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function side(name: 'dm-left' | 'dm-right', artifact: typeof left, f: (n: number) => number): JobDefinition {
  return defineStage({
    name,
    inputs: { source: { artifact: source } },
    outputs: { out: { artifact, location: at(`${name}.json`) } },
    async run(ctx) {
      if (mode(name) === 'fail') throw new Error(`${name} failed`);
      const started = Date.now();
      await sleep(400); // long enough that the two sides must overlap to finish in time
      ctx.output('out').write({ value: f(ctx.input('source').read().value), at: [started, Date.now()] });
    },
  });
}

const sourceStage = defineStage({
  name: 'dm-source',
  outputs: { source: { artifact: source, location: at('source.json') } },
  async run(ctx) { ctx.output('source').write({ value: 4 }); },
});

const join = defineStage({
  name: 'dm-join',
  inputs: { left: { artifact: left }, right: { artifact: right } },
  outputs: { joined: { artifact: joined, location: at('joined.json') } },
  async run(ctx) {
    ctx.output('joined').write({ value: ctx.input('left').read().value + ctx.input('right').read().value, startedAt: Date.now() });
  },
});

export const jobs: JobDefinition[] = [sourceStage, side('dm-left', left, (n) => n + 1), side('dm-right', right, (n) => n * 10), join];

export const diamondWorkflow: WorkflowDefinition = {
  name: 'dm-diamond',
  maxConcurrency: 2,
  jobs: [
    { job: 'dm-source' },
    { job: 'dm-left', dependsOn: ['dm-source'] },
    { job: 'dm-right', dependsOn: ['dm-source'] },
    { job: 'dm-join', dependsOn: ['dm-left', 'dm-right'] },
  ],
};
