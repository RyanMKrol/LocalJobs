import { defineStage } from '../../../engine/index.js';
import { stocksSyncConfig } from '../config.js';
import { namedPositions, portfolio, portfolioReport } from '../contracts.js';
import { runStocksSnapshot } from './stocks-snapshot.js';

export default defineStage({
  name: 'stocks-snapshot',
  description:
    'Builds the human-readable portfolio snapshot from the named positions ' +
    'stocks-resolve-names wrote: reads data/out/named-positions.json and writes ' +
    'data/out/portfolio.json (a structured, broker-agnostic array of ticker/quantity/average buy ' +
    'price/current price/current value/account) plus data/out/portfolio.md, a markdown table with ' +
    'one row per position, an Account column, and the company name (falling back to an em-dash ' +
    'when a name could not be resolved). This stage is a pure report builder — it makes no ' +
    'Trading212 or OpenFIGI calls of its own; all resolution work happens upstream in ' +
    'stocks-resolve-names. Both files are written on every run, including when no positions are ' +
    'held. It writes no work-item ledger rows (the two files are its declared outputs) and ' +
    'declares no inputKeys(), so it is not limitable from the dashboard\'s run-limit box.',
  timeoutMs: 60_000,
  maxRetries: 3,
  inputs: { named: { artifact: namedPositions } },
  outputs: {
    portfolio: { artifact: portfolio, location: () => stocksSyncConfig.portfolioJsonPath },
    report: { artifact: portfolioReport, location: () => stocksSyncConfig.portfolioMdPath },
  },
  // The portfolio is what this workflow is for. The two stages after it only
  // watch it and, rarely, send a push.
  product: true,
  async run(ctx) {
    await runStocksSnapshot(ctx, { readNamedPositions: () => ctx.input('named').read() });
  },
});
