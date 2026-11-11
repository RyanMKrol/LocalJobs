import { defineStage } from '../../../engine/index.js';
import { plexPostersConfig } from '../config.js';
import { backupReport, posterSet } from '../contracts.js';
import { runRecord } from './record.js';

export default defineStage({
  name: 'plex-posters-record',
  description:
    'Writes this backup\'s snapshot into the archive: a dated file listing every title with the ' +
    'image its poster is, and a copy of it as latest.json, which is what the restore script reads ' +
    'by default. Before writing, it checks that every image the snapshot names is really in the ' +
    'archive, and refuses to record one that could not be restored. It then compares the new ' +
    'snapshot with the previous one, by the bytes of each title\'s poster (not its path, which Plex ' +
    'changes on any metadata refresh), and writes a report to data/out/backup-report.json: how many ' +
    'posters are covered, how many changed, which titles are new or gone, and any that could not be ' +
    'downloaded. Nothing in the archive is ever deleted. Read-only towards Plex.',
  timeoutMs: 600_000,
  maxRetries: 2,
  // The report is what this workflow is for, although one more stage follows it.
  product: true,
  inputs: { set: { artifact: posterSet } },
  outputs: { report: { artifact: backupReport, location: () => plexPostersConfig.reportOut } },
  async run(ctx) {
    ctx.output('report').write(await runRecord(ctx, ctx.input('set').read(), { archiveDir: plexPostersConfig.archiveDir() }));
  },
});
