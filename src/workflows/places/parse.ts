import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
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
