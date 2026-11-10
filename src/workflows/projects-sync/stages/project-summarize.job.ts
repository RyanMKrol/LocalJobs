import { defineStage } from '../../../engine/index.js';
import { projectsSyncConfig } from '../config.js';
import { projectSummaries, projectsCatalog } from '../contracts.js';
import { runProjectSummarize } from './project-summarize.js';

export default defineStage({
  name: 'project-summarize',
  description:
    'Shallow-clones each cataloged repo into a gitignored data/repos/<name>/ folder (pulling/resetting ' +
    'in place rather than re-cloning if it already exists), with the git operations routed through the ' +
    'shared github service. It then calls the Claude CLI via runClaudeWithRepoAccess, a distinct ' +
    'invocation shape from the shared runClaude helper: the process cwd is set to the cloned repo and ' +
    'launched with --add-dir <repoDir> --allowedTools Read Glob Grep, giving Claude real but strictly ' +
    'read-only filesystem access to explore the actual checked-out project (package.json, source ' +
    'layout, README) — no Bash, Write, or Edit tools are granted. The prompt embeds GitHub metadata ' +
    '(name, description, language, topics, pushedAt, url) plus the required project.template.md shape ' +
    '(YAML frontmatter and fixed section headings), and the response is validated post-hoc against that ' +
    'template — a missing section or malformed frontmatter throws and marks the item failed. Claude is ' +
    'instructed never to invent facts about a project it can\'t verify by exploring the repo. The final ' +
    'markdown is written to data/out/<repo-name>.md and recorded via detail.markdown. Idempotent per ' +
    'repo — a repo whose stored last-processed marker (the catalog\'s pushedAt) already matches the ' +
    'current catalog value is skipped entirely, with no clone and no Claude call.',
  timeoutMs: 600_000,
  maxRetries: 2,
  inputs: { catalog: { artifact: projectsCatalog } },
  // One profile per repo, rewritten only when the repo has been pushed to: on a
  // week with no pushes the folder is carried forward.
  outputs: {
    summaries: { artifact: projectSummaries, location: () => projectsSyncConfig.outDir, cumulative: true },
  },
  describeItem: (d) => ({
    title: String(d.name ?? ''),
    fields: typeof d.lastCommitSha === 'string' ? [{ label: 'Pushed', value: d.lastCommitSha.slice(0, 10) }] : [],
  }),
  async run(ctx) {
    await runProjectSummarize(ctx, { readCatalog: () => ctx.input('catalog').read() });
  },
});
