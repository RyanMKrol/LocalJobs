import { existsSync } from 'node:fs';
import { defineStage } from '../../../engine/index.js';
import { sectorsJsonPath } from '../config.js';
import { digestPortfolio, sectors } from '../contracts.js';
import { runStockSectorLookup } from './stock-sector-lookup.js';

export default defineStage({
  name: 'stock-sector-lookup',
  description:
    'Resolves each currently-held ticker\'s industry classification via the Finnhub company-profile ' +
    'API, preferring the OpenFIGI-resolved real-world ticker produced by stock-portfolio-snapshot ' +
    'over Trading212\'s own raw ticker (T373) — falling back to a crude string-strip of a trailing ' +
    'market/country suffix only when no resolved ticker exists, since a stale raw ticker can return ' +
    'an empty Finnhub profile. Each ticker\'s lookup is idempotent via the work_items ledger: a ' +
    'resolved industry is never re-queried on a later run, while an unresolved lookup is recorded as ' +
    'failed so it retries (surfacing on the Stuck tile if it never resolves). Writes the resulting ' +
    'ticker-to-industry map to data/out/sectors.json, feeding stock-digest-build\'s sector-' +
    'diversification section. If FINNHUB_API_KEY is unset the whole stage soft-skips with a clear ' +
    'warning, and that run\'s digest simply omits the diversification section.',
  timeoutMs: 120_000,
  maxRetries: 3,
  inputs: { portfolio: { artifact: digestPortfolio } },
  // A ticker is looked up once, so the map grows over many runs and a week with
  // no new ticker carries it forward.
  outputs: { sectors: { artifact: sectors, location: () => sectorsJsonPath, cumulative: true } },
  describeItem: (d) => ({
    title: String(d.name ?? ''),
    fields: [
      ...(typeof d.industry === 'string' ? [{ label: 'Industry', value: d.industry }] : []),
      ...(typeof d.queriedSymbol === 'string' ? [{ label: 'Looked up as', value: d.queriedSymbol }] : []),
      ...(typeof d.error === 'string' ? [{ label: 'Error', value: d.error.slice(0, 160) }] : []),
    ],
  }),
  async run(ctx) {
    const out = ctx.output('sectors');
    try {
      await runStockSectorLookup(ctx, { portfolioPath: ctx.input('portfolio').path, outPath: out.path });
    } finally {
      // The stage returns early without writing when there is no FINNHUB_API_KEY
      // or nothing is held. The map is still its output: with nothing ever
      // resolved it is an empty one, which the digest reads as "no sector data".
      if (!existsSync(out.path)) out.write({});
    }
  },
});
