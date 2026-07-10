import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'csv-parse/sync';

const HEADER = 'Title,Note,URL,Tags,Comment';

export interface RawRow {
  Title: string;
  Note: string;
  URL: string;
  Tags: string;
  Comment: string;
}

export interface ParsedList {
  list: string;
  description: string | null;
  rows: RawRow[];
  /** Count of place URLs in the raw file text — used to verify nothing is lost. */
  rawPlaceUrlCount: number;
}

/**
 * Read one saved-list CSV. Some lists prefix a free-text description line (and a
 * blank line) before the real header, so we locate the header wherever it is and
 * treat any text before it as the list description.
 */
export function parseListFile(path: string): ParsedList {
  const list = basename(path).replace(/\.csv$/i, '');
  const text = readFileSync(path, 'utf8');
  const rawPlaceUrlCount = (text.match(/\/maps\/place\//g) ?? []).length;

  const headerIdx = text.indexOf(HEADER);
  if (headerIdx === -1) {
    // No recognizable header — surface as an empty parse; ingest validates this.
    return { list, description: null, rows: [], rawPlaceUrlCount };
  }

  const pre = text.slice(0, headerIdx).trim();
  const description = pre ? pre.replace(/^"+|"+$/g, '').trim() || null : null;

  const csvText = text.slice(headerIdx);
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  }) as RawRow[];

  // Drop the structural empty row(s) Google emits (",,,,") — no title and no URL.
  const cleaned = rows.filter((r) => (r.Title ?? '').trim() !== '' || (r.URL ?? '').trim() !== '');
  return { list, description, rows: cleaned, rawPlaceUrlCount };
}

export interface FeatureId {
  featureId: string; // "0xAREA:0xCID"
  cidHex: string; // "0xCID"
  cid: string; // decimal CID
}

/**
 * Extract the Google feature id + CID from a maps URL. Returns null for
 * name-only URLs (e.g. https://www.google.com/maps/place/Clays) that carry no
 * !1s0x..:0x.. data segment.
 */
export function extractFeatureId(url: string): FeatureId | null {
  const m = url.match(/!1s(0x[0-9a-f]+):(0x[0-9a-f]+)/i);
  if (!m) return null;
  const cidHex = m[2].toLowerCase();
  let cid: string;
  try {
    cid = BigInt(cidHex).toString();
  } catch {
    return null; // malformed hex
  }
  return { featureId: `${m[1].toLowerCase()}:${cidHex}`, cidHex, cid };
}

/** List every saved-list CSV in a directory, in the same deterministic order
 *  places-ingest processes them (lowercased-extension match, alphabetical). Shared
 *  so any other consumer of the same raw CSVs (e.g. resolveInputKeys) walks the
 *  exact same file set as places-ingest, rather than a second, possibly-drifting
 *  readdir call. */
export function listSavedCsvFiles(savedDir: string): string[] {
  return readdirSync(savedDir)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .sort();
}

/**
 * The full set of CIDs every "resolvable" saved place contributes across all CSVs
 * in `savedDir` — i.e. the same per-row filter places-ingest applies when deciding
 * a row is worth carrying forward (has a URL, is a `/maps/place/` URL, and its URL
 * carries a CID feature id). Shared by places-ingest's row loop (via the same
 * `extractFeatureId` call) and `resolveInputKeys` (which needs only the CID list,
 * not the full normalized place) so the two can never drift on which rows count.
 */
export function collectResolvableCids(savedDir: string): string[] {
  const cids = new Set<string>();
  for (const file of listSavedCsvFiles(savedDir)) {
    const { rows } = parseListFile(join(savedDir, file));
    for (const row of rows) {
      const url = (row.URL ?? '').trim();
      if (!url || !url.includes('/maps/place/')) continue;
      const fid = extractFeatureId(url);
      if (fid) cids.add(fid.cid);
    }
  }
  return [...cids];
}

/** Decode the place name from the /place/<name>/ segment for sanity-checking. */
export function nameFromUrl(url: string): string | null {
  const m = url.match(/\/maps\/place\/([^/]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' '));
  } catch {
    return m[1].replace(/\+/g, ' ');
  }
}
