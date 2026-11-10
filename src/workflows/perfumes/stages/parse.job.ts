import { defineStage } from '../../../engine/index.js';
import { perfumesConfig } from '../config.js';
import { fragranticaData, fragranticaPages } from '../contracts.js';
import { rowFields } from '../lib.js';
import { runParse } from './parse.js';

export default defineStage({
  name: 'perfumes-parse',
  description:
    'Stage 3 of the perfumes workflow. For each perfume with a captured Fragrantica page from ' +
    'stage 2, asks Claude Code to parse the cached page text into structured notes and accords, ' +
    'written to data/out/fragrantica/<id>.json. Each accord\'s percentage (e.g. "woody 83%") is ' +
    'lifted from the page\'s coloured bar CSS width, read from the <id>.html capture stage 2 ' +
    'saves beside the text; a page with no HTML capture leaves that percentage null rather than ' +
    'guessing. This stage makes no network calls of its own; it only reads the already-cached ' +
    'page and calls Claude Code (routed through the shared claude-cli service).',
  timeoutMs: 0,
  maxRetries: 3,
  inputs: { pages: { artifact: fragranticaPages } },
  outputs: {
    data: { artifact: fragranticaData, location: () => perfumesConfig.fragranticaDir, cumulative: true },
  },
  describeItem: (d) => ({
    title: String(d.name ?? ''),
    fields: rowFields(d, [['Accords', d.accordsCount], ['Notes', d.notesCount], ['Rating', d.rating]]),
  }),
  async run(ctx) {
    await runParse(ctx, { pagesDir: ctx.input('pages').path });
  },
});
