# The workflow engine

Everything that runs a workflow is in this directory. It is written as a package: it
knows nothing about the workflows in this repo, and it is tested with stages made up
for the purpose.

## What it does

A workflow is a graph of stages. Each stage declares the data it needs and the data
it produces. The engine:

- checks, when the application starts, that every stage's inputs are produced by the
  stage before it, and refuses to start if they are not
- runs stages in dependency order, several at once where the graph allows
- starts a stage only when every stage it depends on has succeeded, so a stage with
  several inputs waits for all of them
- hands each stage the data its predecessors produced in the same run, never a file
  left over from an earlier one
- fails a stage that reports success without producing what it declared
- retries, times out and cancels stages, each of which runs in its own process
- keeps a record of every run: what each stage read, what it wrote, how it ended and
  why

The run page in the dashboard is drawn from that record. A stage does not write
anything for the dashboard's benefit.

## Using it

Import from `index.ts`. The other files are internal.

```ts
import { defineStage, jsonArtifact, fromChecks } from '../../../engine/index.js';

const snapshot = jsonArtifact<Snapshot>({
  key: 'library-snapshot',
  description: 'Every title in the library.',
  check: (v) => fromChecks([{ label: 'has titles', ok: v.titles.length > 0, actual: `${v.titles.length}` }]),
  items: (v) => v.titles.map((t) => ({ id: t.id, title: t.name })),
});

export default defineStage({
  name: 'recommend',
  inputs: { snapshot: { artifact: snapshot } },
  outputs: { picks: { artifact: picks, location: () => config.picksFile } },
  async run(ctx) {
    const library = ctx.input('snapshot').read();
    ctx.output('picks').write(choose(library));
  },
});
```

An input is fed by the stage it depends on that outputs the same artifact. Add
`many: true` and it is fed by every such stage, which is how several branches join.

For a stage that works through a list, `eachItem` is the loop: it skips what is
already done, counts attempts, keeps going past a failed item, stops politely at a
quota, and fails the run at the end if anything failed.

## How it stays separate

No file here imports a workflow, a service, the job registry or the notifier. The
application connects itself at startup:

```ts
configureEngine({ getJob, notify });
```

`boundary.test.ts` fails if any file in this directory imports from outside it,
apart from the database layer and process config.

## How it is tested

`scenarios/` holds small made-up workflows and the tests that run them. The stages
really run, each in its own process, through the same code a real stage goes through.
Nothing from the rest of the repo is loaded.

| Scenario | What it shows |
|---|---|
| `linear` | Data passing down a chain, a bad output stopping it at the source, retries, cancelling |
| `fan-in` | Several branches joining through one input, stale files rejected, a failed attempt ignored, a changed file caught, a store carried forward |
| `diamond` | Two different inputs joining, the two sides running at once, the join waiting for both |
| `item-pipeline` | Items done once each, a failed item not blocking the rest, picking up where it left off, a run capped to a few items, a quota stop, repeating until settled |

To add a case, write a `*.scenario.ts` that exports `jobs`, then a test that calls
`setupScenario` and runs it. `testing/scenario.ts` has the helpers.

The rest of the tests here cover the pieces on their own: the graph (`dag.test.ts`),
how inputs are matched to outputs (`ports.test.ts`), the item loop (`items.test.ts`),
what the run page is built from (`reporting.test.ts`), and the older style of stage
that is being replaced (`engine-hardening.test.ts`, `workflow-executor.test.ts`).
