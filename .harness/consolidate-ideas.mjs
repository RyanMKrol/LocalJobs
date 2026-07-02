#!/usr/bin/env node
// consolidate-ideas.mjs — the Stage 3 consolidation pass for /local-jobs-convert-ideas.
//
// Reads every .harness/.pending-tasks/<slug>.json file (one per idea, or per shared-answer-space
// cluster — see .claude/commands/local-jobs-convert-ideas.md), allocates real sequential task ids,
// resolves cross-unit tempId `dependsOn` references, writes .harness/tasks/TNNN.md spec files by
// COPYING each task's referenced `specFile` (a real markdown file the per-unit agent wrote alongside
// this JSON, e.g. `<tempId>.md` — NOT a JSON string field; writing markdown as an actual file instead
// of an escaped string lets agents be fully expressive with headers/code fences/lists instead of
// compressing the spec to fit a flat string), merges the new tasks into TASKS.json, and removes each
// converted idea's bullet from IDEAS.md.
//
// This is pure data-processing — it does NOT touch git and does NOT take the repo lock itself.
// Run it via consolidate-ideas.sh, which wraps it in the shared repo-lock.sh mutex and handles the
// git add/commit/push. (Split this way because id allocation + IDEAS.md bullet removal need the
// lock, but are much easier to get right in JS than in bash/jq — and lock acquisition itself is a
// one-line bash `source`, no reason to reimplement it here.)
//
// Bullet removal is FUZZY-matched (normalized: backticks stripped, whitespace collapsed), not exact
// string match — a pending file's recorded `ideaBullets` text is a straight paragraph, while the
// actual bullet in IDEAS.md is hand-line-wrapped markdown, so byte-identity is not realistic.
//
// Idempotent: safe to re-run — it only ever processes whatever `.pending-tasks/*.json` files still
// exist on disk, and a bullet that's already gone from IDEAS.md is skipped (not an error). Units
// that were deliberately deferred (owner declined, no pending file written — see the plex-file-naming
// worked example in the skill) are correctly invisible to this script; their bullet stays untouched.
//
// Usage: node .harness/consolidate-ideas.mjs
// Writes .harness/.pending-tasks/.consolidation-summary.json — the wrapper script reads this to know
// which files to `git add` and to build the commit message, then deletes it once committed.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = execFileSync('git', ['-C', HERE, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const PENDING_DIR = path.join(REPO, '.harness/.pending-tasks');
const TASKS_PATH = path.join(REPO, '.harness/TASKS.json');
const TASKS_DIR = path.join(REPO, '.harness/tasks');
const IDEAS_PATH = path.join(REPO, '.harness/IDEAS.md');
const SUMMARY_PATH = path.join(PENDING_DIR, '.consolidation-summary.json');

function normalize(s) {
  return s.replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---- 1. Read TASKS.json fresh, compute next id ----
const tasksDoc = JSON.parse(fs.readFileSync(TASKS_PATH, 'utf8'));
const existingIds = tasksDoc.tasks.map(t => t.id);
const idNums = existingIds.map(id => parseInt(id.slice(1), 10));
const width = existingIds.length ? existingIds[0].slice(1).length : 3;
let nextNum = Math.max(0, ...idNums) + 1;

function allocId() {
  const id = 'T' + String(nextNum).padStart(width, '0');
  nextNum += 1;
  return id;
}

// ---- 2. Read every pending file, stable order (sorted by filename == agentSlug) ----
fs.mkdirSync(PENDING_DIR, { recursive: true });
const pendingFiles = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json') && f !== '.consolidation-summary.json').sort();
if (pendingFiles.length === 0) {
  console.log('No pending files found — nothing to consolidate.');
  process.exit(0);
}

const units = pendingFiles.map(f => {
  const full = path.join(PENDING_DIR, f);
  return { file: full, fname: f, data: JSON.parse(fs.readFileSync(full, 'utf8')) };
});

const tempIdMap = new Map(); // tempId -> realId
const allocatedTasks = [];   // { realId, tempId, raw, unit }

for (const unit of units) {
  for (const t of (unit.data.tasks || [])) {
    const realId = allocId();
    tempIdMap.set(t.tempId, realId);
    allocatedTasks.push({ realId, tempId: t.tempId, raw: t, unit });
  }
}

console.log(`Allocated ${allocatedTasks.length} task id(s): ${allocatedTasks.map(a => a.realId).join(', ') || '(none)'}`);

// ---- 3. Resolve dependsOn ----
const droppedDeps = [];
for (const a of allocatedTasks) {
  const resolved = [];
  for (const dep of (a.raw.dependsOn || [])) {
    if (/^T\d+$/.test(dep)) {
      const existsOld = existingIds.includes(dep);
      const existsNew = allocatedTasks.some(x => x.realId === dep);
      if (existsOld || existsNew) resolved.push(dep);
      else droppedDeps.push({ realId: a.realId, tempId: a.tempId, dep, reason: 'referenced real id does not exist' });
    } else if (tempIdMap.has(dep)) {
      resolved.push(tempIdMap.get(dep));
    } else {
      droppedDeps.push({ realId: a.realId, tempId: a.tempId, dep, reason: 'tempId has no matching produced task (unit likely produced zero tasks)' });
    }
  }
  a.resolvedDependsOn = resolved;
}

if (droppedDeps.length) {
  console.log(`WARNING: ${droppedDeps.length} dependsOn reference(s) dropped:`);
  for (const d of droppedDeps) console.log(`  ${d.realId} (${d.tempId}) -> "${d.dep}": ${d.reason}`);
}

// ---- 4. Write tasks/TNNN.md spec files by copying each task's referenced specFile ----
fs.mkdirSync(TASKS_DIR, { recursive: true });
const consumedSpecFiles = [];
for (const a of allocatedTasks) {
  if (!a.raw.specFile) {
    throw new Error(`${a.tempId} (unit "${a.unit.data.agentSlug}") has no "specFile" field — every task must reference a real markdown spec file written alongside the unit's .json file. Refusing to write an empty spec.`);
  }
  const specSrcPath = path.join(PENDING_DIR, a.raw.specFile);
  if (!fs.existsSync(specSrcPath)) {
    throw new Error(`${a.tempId} (unit "${a.unit.data.agentSlug}") references specFile "${a.raw.specFile}" but ${specSrcPath} does not exist.`);
  }
  const content = fs.readFileSync(specSrcPath, 'utf8');
  if (!/^## Do\b/m.test(content) || !/^## Done when\b/m.test(content)) {
    console.log(`WARNING: ${a.tempId}'s spec file (${a.raw.specFile}) is missing a "## Do" or "## Done when" heading — copying it as-is, but this likely needs a manual look.`);
  }
  const mdPath = path.join(TASKS_DIR, `${a.realId}.md`);
  fs.writeFileSync(mdPath, content, 'utf8');
  consumedSpecFiles.push(a.raw.specFile);
}

// ---- 5. Build final task objects ----
const newTaskObjects = allocatedTasks.map(a => {
  const t = a.raw;
  const isNeedsHuman = t.gate === 'needs-human';
  const tags = Array.isArray(t.tags) ? [...t.tags] : [];
  if (isNeedsHuman && !tags.includes('needs-human')) tags.push('needs-human');

  const obj = {
    id: a.realId,
    title: t.title,
    status: 'pending',
    dependsOn: a.resolvedDependsOn,
    gate: t.gate ?? null,
    tags,
    scope: Array.isArray(t.scope) ? t.scope : [],
    design: t.design ?? null,
    verify: Array.isArray(t.verify) ? t.verify : [],
    spec: `.harness/tasks/${a.realId}.md`,
  };
  if (!isNeedsHuman) {
    obj.facets = t.facets ?? null;
    obj.expectsTest = !!t.expectsTest;
  }
  return obj;
});

// ---- 6. Merge into TASKS.json ----
tasksDoc.tasks.push(...newTaskObjects);
fs.writeFileSync(TASKS_PATH, JSON.stringify(tasksDoc, null, 2) + '\n', 'utf8');

// ---- 7. Remove converted idea bullets from IDEAS.md (fuzzy match, re-read fresh) ----
let removedBulletCount = 0;
if (fs.existsSync(IDEAS_PATH)) {
  const ideasRaw = fs.readFileSync(IDEAS_PATH, 'utf8');
  const lines = ideasRaw.split('\n');
  const inboxHeaderIdx = lines.findIndex(l => l.trim() === '## Inbox');

  if (inboxHeaderIdx === -1) {
    console.error('WARNING: could not find "## Inbox" header in IDEAS.md — skipping bullet removal');
  } else {
    // IDEAS.md's ## Inbox uses sequentially numbered bullets ("1. ", "2. ", ...) since T328 —
    // previously it used literal "- " bullets. NUMBERED_BULLET_RE matches a top-level bullet start;
    // update this in lockstep with IDEAS.md's actual format if it ever changes again.
    const NUMBERED_BULLET_RE = /^\d+\.\s/;
    const bulletSpans = [];
    let i = inboxHeaderIdx + 1;
    while (i < lines.length) {
      if (NUMBERED_BULLET_RE.test(lines[i])) {
        const start = i;
        let j = i + 1;
        while (j < lines.length && !NUMBERED_BULLET_RE.test(lines[j]) && !lines[j].startsWith('## ')) j++;
        bulletSpans.push({ start, end: j, text: lines.slice(start, j).join('\n') });
        i = j;
      } else if (lines[i].startsWith('## ')) {
        break;
      } else {
        i++;
      }
    }
    console.log(`Parsed ${bulletSpans.length} bullet(s) from IDEAS.md inbox.`);

    const allRecordedBullets = [];
    for (const unit of units) {
      for (const b of (unit.data.ideaBullets || [])) allRecordedBullets.push({ text: b, slug: unit.data.agentSlug });
    }

    const normBullets = bulletSpans.map(b => ({ ...b, norm: normalize(b.text) }));
    const matchedSpans = new Set();

    for (const rec of allRecordedBullets) {
      const recNorm = normalize(rec.text);
      let match = normBullets.find(b => b.norm === recNorm);
      if (!match) match = normBullets.find(b => b.norm.slice(0, 200) === recNorm.slice(0, 200));
      if (!match) {
        const recPrefix100 = recNorm.slice(0, 100);
        match = normBullets.find(b => b.norm.includes(recPrefix100) || recNorm.includes(b.norm.slice(0, 100)));
      }
      if (match) {
        matchedSpans.add(match.start);
        console.log(`MATCHED bullet for unit "${rec.slug}": line ${match.start + 1}`);
      } else {
        console.log(`WARNING: no bullet match for unit "${rec.slug}" (starts: "${rec.text.slice(0, 80)}...") — leaving it in IDEAS.md`);
      }
    }

    const spansToRemove = normBullets.filter(b => matchedSpans.has(b.start)).sort((a, b) => b.start - a.start);
    let newLines = [...lines];
    for (const span of spansToRemove) newLines.splice(span.start, span.end - span.start);
    fs.writeFileSync(IDEAS_PATH, newLines.join('\n'), 'utf8');
    removedBulletCount = spansToRemove.length;
    console.log(`Removed ${removedBulletCount} bullet(s) from IDEAS.md.`);
  }
} else {
  console.log('IDEAS.md does not exist — skipping bullet removal (nothing to clean up).');
}

// ---- 8. Write summary for the shell wrapper ----
const idList = allocatedTasks.map(a => a.realId);
const first = idList[0];
const last = idList[idList.length - 1];
const idRange = idList.length === 0 ? '' : idList.length === 1 ? first : `${first}-${last}`;
const unitSlugs = [...new Set(units.map(u => u.data.agentSlug))];
const suggestedCommitMessage = idList.length
  ? `backlog: add ${idRange} from idea conversion sweep\n\nConverted ${unitSlugs.length} idea unit(s): ${unitSlugs.join(', ')}.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
  : '';

const summary = {
  allocatedTasks: allocatedTasks.map(a => ({ realId: a.realId, tempId: a.tempId, unit: a.unit.data.agentSlug, title: a.raw.title })),
  droppedDeps,
  removedBulletCount,
  pendingFilesConsumed: pendingFiles,
  specFilesConsumed: consumedSpecFiles,
  suggestedCommitMessage,
};
fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');
console.log('\n--- SUMMARY ---');
console.log(JSON.stringify(summary, null, 2));
