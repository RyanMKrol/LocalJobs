// Fault injection, for proving failure handling on a REAL run.
//
// The scenario tests show what the engine does when a stage misbehaves, but they
// run made-up stages. To see the same thing happen to a real workflow, through
// the daemon, with its run page as the evidence, something has to make a real
// stage misbehave on demand. That is this file.
//
// Write a JSON list to the faults file (next to the database, so it is never in
// the repo), then start the run:
//
//   [{ "job": "tv-snapshot", "fault": "skip-outputs", "attempts": 3 }]
//
//   fail          the stage throws before doing anything
//   skip-outputs  the stage returns without running, so it writes none of its outputs
//
// `attempts` is how many attempts of that stage to affect (default 1). Each
// affected attempt uses one up; an entry at zero is removed, and the file is
// deleted when the list is empty. So a fault cannot outlive the run it was
// written for, and with no file this does nothing at all.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { writeFileAtomic } from './fsjson.js';

export type FaultKind = 'fail' | 'skip-outputs';
interface FaultEntry { job: string; fault: FaultKind; attempts?: number }

export function faultsFile(): string {
  return process.env.LOCALJOBS_FAULTS_FILE || join(dirname(config.dbPath), 'engine-faults.json');
}

/**
 * The fault to apply to this attempt of `jobName`, if one is waiting. Taking it
 * uses it up. A file that cannot be read is ignored: a broken test aid must never
 * be the reason a real stage fails.
 */
export function takeFault(jobName: string, file: string = faultsFile()): FaultKind | null {
  if (!existsSync(file)) return null;
  let entries: FaultEntry[];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return null;
    entries = parsed as FaultEntry[];
  } catch {
    return null;
  }
  const hit = entries.find((e) => e && e.job === jobName && (e.fault === 'fail' || e.fault === 'skip-outputs'));
  if (!hit) return null;
  const left = (hit.attempts ?? 1) - 1;
  const rest = left > 0 ? entries.map((e) => (e === hit ? { ...e, attempts: left } : e)) : entries.filter((e) => e !== hit);
  if (rest.length === 0) rmSync(file, { force: true });
  else writeFileAtomic(file, JSON.stringify(rest, null, 2));
  return hit.fault;
}
