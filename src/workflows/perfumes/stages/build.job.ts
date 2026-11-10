import { defineStage } from '../../../engine/index.js';
import { perfumesConfig } from '../config.js';
import { fragranticaData, fragranticaUrls, perfumeProfiles } from '../contracts.js';
import { rowFields } from '../lib.js';
import { runBuild } from './build.js';

export default defineStage({
  name: 'perfumes-build',
  description:
    'Stage 4 (final) of the perfumes workflow. For each perfume with parsed Fragrantica data from ' +
    'stage 3, asks Claude Code to research the perfume further on the web and write a complete ' +
    'markdown profile that follows the enforced profile.template.md contract (YAML frontmatter ' +
    'covering name, brand, notes pyramid, accords, wear profile, community rating and ' +
    'provenance, plus fixed narrative sections). It blends Fragrantica\'s community vote signal ' +
    'against the LLM\'s own research using a continuous confidence weight based on the perfume\'s ' +
    'vote count relative to the scraped corpus\'s median, passing that weight into the prompt as ' +
    'an explicit instruction to state the confidence level in the written profile (there is no ' +
    'separate validator that checks the prose actually honors it). The finished profile is ' +
    'written to data/out/markdown/<id>.md. It is handed the parsed data by stage 3 and the URL ' +
    'store by stage 1 (the profile cites the Fragrantica page).',
  timeoutMs: 0,
  maxRetries: 3,
  // Two inputs from two different stages: the parsed records, and the URL of each
  // perfume's page (cited in the profile). The URL store comes straight from
  // find-url, which is why the manifest gives this stage an edge from it.
  inputs: {
    data: { artifact: fragranticaData },
    urls: { artifact: fragranticaUrls },
  },
  outputs: {
    profiles: { artifact: perfumeProfiles, location: () => perfumesConfig.markdownDir, cumulative: true },
  },
  // The profiles are what this workflow is for.
  product: true,
  describeItem: (d) => ({
    title: String(d.name ?? ''),
    fields: rowFields(d, [['Fragrantica votes', d.votes]]),
  }),
  async run(ctx) {
    await runBuild(ctx, { urls: ctx.input('urls').read(), dataDir: ctx.input('data').path });
  },
});
