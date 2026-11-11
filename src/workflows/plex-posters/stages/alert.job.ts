import { defineStage } from '../../../engine/index.js';
import { plexPostersConfig } from '../config.js';
import { alertDigest, backupReport } from '../contracts.js';
import { runAlert } from './alert.js';

export default defineStage({
  name: 'plex-posters-alert',
  description:
    'Last stage of the Plex poster backup: tells the owner what they need to know about it. It ' +
    'sends one high-priority push when a large share of posters changed since the previous snapshot ' +
    '(by default at least 20% and at least 25 posters; PLEX_POSTER_ALERT_PCT and ' +
    'PLEX_POSTER_ALERT_MIN change that), because that usually means a metadata refresh has replaced ' +
    'chosen posters and the previous snapshot is the way back. A ledger row keyed by the snapshot\'s ' +
    'timestamp records that the push went out, so a retry cannot send it twice. On a normal week it ' +
    'sends nothing. If any posters could not be downloaded this run, it fails after recording its ' +
    'result, naming them, so the run ends as a warning even though the snapshot itself was written.',
  timeoutMs: 60_000,
  maxRetries: 1,
  inputs: { report: { artifact: backupReport } },
  outputs: { digest: { artifact: alertDigest } },
  describeItem: (d) => ({
    title: String(d.name ?? ''),
    fields: typeof d.changedPct === 'number' ? [{ label: 'Changed', value: `${d.changedPct}%` }] : [],
  }),
  async run(ctx) {
    const report = ctx.input('report').read();
    const digest = await runAlert(ctx, report, { thresholdPct: plexPostersConfig.alertPct(), minChanged: plexPostersConfig.alertMinChanged() });
    ctx.output('digest').write(digest);
    if (report.failures.length > 0) {
      const names = report.failures.slice(0, 10).map((f) => f.label).join(', ');
      throw new Error(`${report.failures.length} poster(s) could not be downloaded and are missing from this snapshot: ${names}${report.failures.length > 10 ? ', ...' : ''}`);
    }
  },
});
