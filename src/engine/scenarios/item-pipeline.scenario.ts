// SCENARIO: an incremental item pipeline.
//
//   ip-discover ──▶ ip-process ──▶ ip-publish
//
// The shape most real workflows have: a list of items is discovered, each is
// processed once, each processed item is published once, and every later run
// only touches what is new or still failing. The ledger records what is done;
// the data travels as a ledger artifact (discover → process) and as a directory
// of per-item files (process → publish), both cumulative.
//
// The source list is `source.json` in the scenario directory; the test edits it
// to add items. Per-item behaviour is steered through the control file:
//   "ip-process": "fail:<id>"        that item always fails
//   "ip-process": "fail-once:<id>"   that item fails on its first attempt only
//   "ip-process": "quota"            a quota is hit before anything is processed
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDirs, writeFileAtomic, writeJsonFile } from '../fsjson.js';
import { eachItem, snapshotLedger, softStop, successRows } from '../items.js';
import { acceptAny, defineStage, dirArtifact, fromChecks, ledgerArtifact } from '../ports.js';
import { scenarioDir, scenarioMode as mode } from '../testing/scenario.js';
import type { JobDefinition, WorkflowDefinition } from '../types.js';

const sourcePath = () => join(scenarioDir(), 'source.json');
const readSource = (): string[] => (existsSync(sourcePath()) ? (JSON.parse(readFileSync(sourcePath(), 'utf8')) as string[]) : []);
const processedDir = () => join(scenarioDir(), 'processed');
const publishedDir = () => join(scenarioDir(), 'published');

/** The discovered items: the discover stage's ledger rows. */
export const discovered = ledgerArtifact({
  key: 'ip-discovered',
  description: 'Every item currently in the source, one ledger row each.',
  readRows: successRows,
  check: (rows) => fromChecks([{ label: 'has at least one item', ok: rows.length > 0, actual: `${rows.length} item(s)` }], `${rows.length} item(s)`),
  items: (rows) => rows.map((r) => ({ id: r.itemKey, title: r.itemKey })),
});
export const processed = dirArtifact({
  key: 'ip-processed',
  description: 'One JSON file per processed item.',
  check: acceptAny,
  count: (d) => d.files.length,
  items: (d) => d.files.map((f) => ({ id: f, title: f, preview: { path: join(d.path, f), format: 'json' } })),
});
export const published = dirArtifact({
  key: 'ip-published',
  description: 'One markdown file per published item.',
  check: acceptAny,
  count: (d) => d.files.length,
});

const discover = defineStage({
  name: 'ip-discover',
  // Declaring inputKeys makes the workflow LIMITABLE: a manual run can be capped
  // to N originating inputs, each of which then flows through every stage.
  inputKeys: () => readSource(),
  outputs: { discovered: { artifact: discovered } },
  async run(ctx) {
    snapshotLedger(ctx, 'ip-discover', readSource().map((id) => ({ key: id, detail: { name: id } })), { prune: true });
  },
});

const process = defineStage({
  name: 'ip-process',
  inputs: { discovered: { artifact: discovered } },
  outputs: { processed: { artifact: processed, location: processedDir, cumulative: true } },
  describeItem: (d) => ({ title: String(d.name), fields: [{ label: 'Length', value: String(d.length) }], preview: { path: String(d.path), format: 'json' } }),
  async run(ctx) {
    ensureDirs(processedDir());
    const m = mode('ip-process');
    const rows = ctx.input('discovered').read();
    await eachItem(ctx, 'ip-process', rows, { key: (r) => r.itemKey, from: { job: 'ip-discover' }, maxAttempts: 3 }, async (row, info) => {
      if (m === 'quota') return softStop('daily quota reached');
      if (m === `fail:${row.itemKey}`) throw new Error(`cannot process ${row.itemKey}`);
      if (m === `fail-once:${row.itemKey}` && info.attempt === 1) throw new Error(`first attempt at ${row.itemKey} fails`);
      const path = join(processedDir(), `${row.itemKey}.json`);
      // The item's data is on disk BEFORE the loop marks it done.
      writeJsonFile(path, { id: row.itemKey, upper: row.itemKey.toUpperCase() });
      return { path, length: row.itemKey.length };
    });
  },
});

const publish = defineStage({
  name: 'ip-publish',
  inputs: { processed: { artifact: processed } },
  outputs: { published: { artifact: published, location: publishedDir, cumulative: true } },
  product: true,
  async run(ctx) {
    ensureDirs(publishedDir());
    const dir = ctx.input('processed').read();
    await eachItem(ctx, 'ip-publish', dir.files, { key: (f) => f.replace(/\.json$/, ''), from: { job: 'ip-process' }, maxAttempts: 3 }, async (file) => {
      const data = JSON.parse(readFileSync(join(dir.path, file), 'utf8')) as { id: string; upper: string };
      const path = join(publishedDir(), `${data.id}.md`);
      writeFileAtomic(path, `# ${data.upper}\n`);
      return { markdown: path };
    });
  },
});

export const jobs: JobDefinition[] = [discover, process, publish];

const members: WorkflowDefinition['jobs'] = [
  { job: 'ip-discover' },
  { job: 'ip-process', dependsOn: ['ip-discover'] },
  { job: 'ip-publish', dependsOn: ['ip-process'] },
];
export const pipelineWorkflow: WorkflowDefinition = { name: 'ip-pipeline', jobs: members };
