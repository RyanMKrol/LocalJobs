import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobContext } from '../../core/types.js';
import { markWorkItem } from '../../db/store.js';
import { placesConfig } from './config.js';
import { extractFeatureId, nameFromUrl, parseListFile } from './parse.js';
import type {
  IngestOutput,
  NormalizedPlace,
  PerListStat,
  ValidationIssue,
  ValidationReport,
} from './types.js';

/** This job's name — the workflow's first stage, which owns the per-item ledger list. */
const INGEST_JOB = 'places-ingest';

/**
 * Record the canonical per-item work-item list for the workflow: one ledger entry
 * per CID-bearing place, keyed by its CID (the id every downstream stage keys on).
 * Name-only places (no CID) can't be resolved, so they don't enter the pipeline and
 * aren't recorded. This is what makes ingest — the FIRST stage — the owner of the
 * idempotency list (so the run's Input→Output mapping has an input side). A bulk
 * prep step re-records the full current list each run (upsert; no skip). Exported so
 * it can be unit-tested against the scratch DB without disk I/O.
 */
export function recordIngestLedger(places: NormalizedPlace[]): void {
  for (const p of places) {
    if (p.cid) markWorkItem(INGEST_JOB, p.cid, 'success', { detail: { name: p.name } });
  }
}

/**
 * Ingest every saved-list CSV (places-data/raw/Saved) into one normalized,
 * deduped places.json, and emit a validation report. Only the Saved/ export is
 * processed — Maps / Maps (your places) are intentionally ignored for now.
 * Throws if validation finds any error-level issue (so the job is marked failed).
 *
 * Logging is intentionally verbose (see CLAUDE.md): it narrates every list and
 * every place so the run page tells the full story.
 */
export async function runIngest(ctx: JobContext): Promise<ValidationReport> {
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('places-ingest starting');
  ctx.log(`  savedDir: ${placesConfig.savedDir}`);
  ctx.log(`  outDir:   ${placesConfig.outDir}`);
  mkdirSync(placesConfig.outDir, { recursive: true });

  const csvFiles = readdirSync(placesConfig.savedDir)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .sort();
  ctx.log(`Discovered ${csvFiles.length} saved lists: ${csvFiles.map((f) => f.replace(/\.csv$/, '')).join(', ')}`);
  ctx.log('Per place we log: action (ADDED = first time seen · ALREADY SAVED = also in another list), name, CID, and feature ID.');

  const byKey = new Map<string, NormalizedPlace>();
  const perList: PerListStat[] = [];
  const issues: ValidationIssue[] = [];

  csvFiles.forEach((file, i) => {
    const parsed = parseListFile(join(placesConfig.savedDir, file));
    const { list, description, rows, rawPlaceUrlCount } = parsed;

    ctx.log('');
    ctx.log(`▶ [${i + 1}/${csvFiles.length}] "${list}" — ${rows.length} data rows, ${rawPlaceUrlCount} place URLs`);
    if (description) ctx.log(`    description: "${description}"`);

    let placesInList = 0;
    let nameOnlyInList = 0;
    let newInList = 0;
    let mergedInList = 0;
    let skippedInList = 0;

    for (const row of rows) {
      const url = (row.URL ?? '').trim();
      let name = (row.Title ?? '').trim();

      if (!url) {
        skippedInList++;
        ctx.log(`    ! skip "${name || '(blank)'}" — row has no URL`, 'warn');
        issues.push({ level: 'warn', list, name: name || '(blank)', reason: 'row has no URL — skipped' });
        continue;
      }
      if (!url.includes('/maps/place/')) {
        skippedInList++;
        ctx.log(`    ! skip "${name || '(blank)'}" — non-Maps URL: ${url.slice(0, 70)}`, 'warn');
        issues.push({ level: 'warn', list, name: name || '(blank)', reason: `non-Maps URL — skipped (${url.slice(0, 60)})` });
        continue;
      }
      if (!name) {
        name = nameFromUrl(url) ?? '(unknown)';
        ctx.log(`    ~ row had no Title; derived "${name}" from URL`, 'warn');
        issues.push({ level: 'warn', list, name, reason: 'row has no Title; derived name from URL' });
      }

      placesInList++;
      const fid = extractFeatureId(url);
      const note = (row.Note ?? '').trim();
      const comment = (row.Comment ?? '').trim();

      if (!fid) {
        nameOnlyInList++;
        ctx.log(`    ⚠ "${name}" — Maps URL without a CID; not resolvable later`, 'warn');
        issues.push({ level: 'warn', list, name, reason: 'Maps URL without a CID — not resolvable' });
        const key = `nameonly::${list}::${name.toLowerCase()}`;
        const action = upsert(byKey, key, {
          cid: null, cidHex: null, featureId: null, name, url, cidUrl: null,
          lists: [list], notes: [{ list, note, comment }], resolvable: false,
        }, list, { note, comment });
        action === 'new' ? newInList++ : mergedInList++;
        continue;
      }

      const key = `cid::${fid.cid}`;
      const action = upsert(byKey, key, {
        cid: fid.cid, cidHex: fid.cidHex, featureId: fid.featureId, name, url,
        cidUrl: `https://maps.google.com/?cid=${fid.cid}`,
        lists: [list], notes: [{ list, note, comment }], resolvable: true,
      }, list, { note, comment });

      if (action === 'new') {
        newInList++;
        ctx.log(`    + ADDED "${name}"  —  CID ${fid.cid},  feature ID ${fid.featureId}`);
      } else {
        mergedInList++;
        const merged = byKey.get(key)!;
        ctx.log(`    ~ ALREADY SAVED "${name}"  —  CID ${fid.cid};  now in ${merged.lists.length} lists: [${merged.lists.join(', ')}]`);
      }
    }

    if (placesInList !== rawPlaceUrlCount) {
      ctx.log(`    ✗ MISMATCH: parsed ${placesInList} places but raw file has ${rawPlaceUrlCount} place URLs`, 'error');
      issues.push({
        level: 'error',
        list,
        name: '',
        reason: `parsed ${placesInList} places but raw file has ${rawPlaceUrlCount} place URLs`,
      });
    }

    ctx.log(`    └ "${list}": ${placesInList} places (${newInList} new, ${mergedInList} merged, ${nameOnlyInList} name-only, ${skippedInList} skipped)`);
    perList.push({ list, description, rows: rows.length, places: placesInList, nameOnly: nameOnlyInList });
    ctx.progress(((i + 1) / csvFiles.length) * 95, `Parsed ${list}`);
  });

  const places = [...byKey.values()];
  const withCid = places.filter((p) => p.cid).length;
  const nameOnly = places.filter((p) => !p.cid).length;
  const multi = places.filter((p) => p.lists.length > 1);

  const report: ValidationReport = {
    generatedAt: new Date().toISOString(),
    ok: !issues.some((x) => x.level === 'error'),
    summary: {
      listsProcessed: csvFiles.length,
      placeRows: perList.reduce((a, l) => a + l.places, 0),
      uniquePlaces: places.length,
      withCid,
      nameOnly,
      appearingInMultipleLists: multi.length,
    },
    perList,
    issues,
  };

  const output: IngestOutput = {
    generatedAt: report.generatedAt,
    source: 'google-takeout',
    places: places.sort((a, b) => a.name.localeCompare(b.name)),
  };

  writeFileSync(placesConfig.placesOut, JSON.stringify(output, null, 2));
  writeFileSync(placesConfig.reportOut, JSON.stringify(report, null, 2));

  // Convention (first stage owns the per-item list): as the workflow's first stage,
  // ingest records the canonical work-item list every later stage keys on — one
  // ledger item per CID-bearing place, keyed by CID. This anchors idempotency AND
  // the run's Input→Output mapping from stage one (a bulk-prep first stage that
  // records nothing leaves the IO panel with no input side). Only on a valid run.
  if (report.ok) recordIngestLedger(places);

  ctx.progress(100, `${places.length} places (${withCid} with CID)`);

  // ── Detailed summary ──────────────────────────────────────────────
  const errors = issues.filter((x) => x.level === 'error');
  const warns = issues.filter((x) => x.level === 'warn');
  ctx.log('');
  ctx.log('═══════════════════ INGEST SUMMARY ═══════════════════');
  ctx.log(`Lists processed:        ${report.summary.listsProcessed}`);
  ctx.log(`Place rows seen:        ${report.summary.placeRows}`);
  ctx.log(`Unique places:          ${report.summary.uniquePlaces}`);
  ctx.log(`  • with CID:           ${withCid}`);
  ctx.log(`  • name-only (no CID):  ${nameOnly}`);
  ctx.log(`Appear in >1 list:      ${multi.length}`);

  ctx.log('Top 10 lists by size:');
  [...perList].sort((a, b) => b.places - a.places).slice(0, 10)
    .forEach((l) => ctx.log(`    ${String(l.places).padStart(4)}  ${l.list}`));

  if (multi.length) {
    ctx.log(`Places saved to multiple lists (${multi.length}):`);
    multi.slice(0, 40).forEach((p) => ctx.log(`    • ${p.name} — [${p.lists.join(', ')}]`));
    if (multi.length > 40) ctx.log(`    …and ${multi.length - 40} more`);
  }

  if (warns.length) {
    ctx.log(`Warnings (${warns.length}):`, 'warn');
    warns.forEach((w) => ctx.log(`    • [${w.list}] ${w.name}: ${w.reason}`, 'warn'));
  }
  if (errors.length) {
    ctx.log(`Errors (${errors.length}):`, 'error');
    errors.forEach((e) => ctx.log(`    • [${e.list}] ${e.reason}`, 'error'));
  }

  const placesBytes = statSync(placesConfig.placesOut).size;
  ctx.log(`Wrote ${placesConfig.placesOut} (${(placesBytes / 1024).toFixed(0)} KB, ${places.length} places)`);
  ctx.log(`Wrote ${placesConfig.reportOut}`);
  ctx.log(`Validation: ${errors.length ? 'FAILED' : 'passed'} — ${errors.length} errors, ${warns.length} warnings`,
    errors.length ? 'error' : 'info');
  ctx.log('══════════════════════════════════════════════════════');

  return report;
}

/** Insert a new place or merge list-membership/notes into an existing one. */
function upsert(
  map: Map<string, NormalizedPlace>,
  key: string,
  fresh: NormalizedPlace,
  list: string,
  note: { note: string; comment: string },
): 'new' | 'merged' {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, fresh);
    return 'new';
  }
  if (!existing.lists.includes(list)) existing.lists.push(list);
  existing.notes.push({ list, note: note.note, comment: note.comment });
  return 'merged';
}
