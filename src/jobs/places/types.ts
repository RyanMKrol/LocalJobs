// Types for the places ingestion pipeline (private — gitignored).

/** A note attached to a place from one specific saved list. */
export interface ListNote {
  list: string;
  note: string;
  comment: string;
}

/** A normalized, deduped place record (the output of ingestion). */
export interface NormalizedPlace {
  /** Decimal CID — the stable anchor for later resolution. null if name-only. */
  cid: string | null;
  /** Hex CID (e.g. 0xc8030aeb7f27624e). null if name-only. */
  cidHex: string | null;
  /** Full feature id (area:cid hex). null if name-only. */
  featureId: string | null;
  name: string;
  /** Original Google Maps URL (from the first list it was seen in). */
  url: string;
  /** Convenience: the canonical ?cid= URL (null if name-only). */
  cidUrl: string | null;
  /** Every saved list this place appears in. */
  lists: string[];
  /** Per-list notes/comments. */
  notes: ListNote[];
  /** false when there's no CID — can't be resolved/enriched later. */
  resolvable: boolean;
}

/** Status of a single CID→place_id resolution attempt. */
export type ResolveStatus = 'success' | 'mismatch' | 'no_place_id' | 'error';

/** Output of the resolver, one per CID. */
export interface ResolvedPlace {
  cid: string;
  name: string;
  status: ResolveStatus;
  placeId: string | null;
  lat: number | null;
  lng: number | null;
  featureId: string | null;
  kgMid: string | null;
  resolvedAt: string;
  /** How many times we've attempted this CID across runs. */
  attempts: number;
  /** Populated when status !== 'success'. */
  error?: string;
}

export interface ResolvedFile {
  generatedAt: string;
  resolved: Record<string, ResolvedPlace>;
}

/** Output of the enricher, one per CID (keyed by CID). */
export interface EnrichedPlace {
  cid: string;
  placeId: string;
  status: 'success' | 'failed';
  enrichedAt: string;
  /** How many times we've attempted this place across runs. */
  attempts: number;
  /** The selected Places API Place fields (present on success). */
  data?: Record<string, unknown>;
  error?: string;
}

export interface EnrichedFile {
  generatedAt: string;
  enriched: Record<string, EnrichedPlace>;
}

/** Per-calendar-month count of billable Places API calls, e.g. {"2026-06": 412}. */
export type EnrichUsage = Record<string, number>;

export type IssueLevel = 'warn' | 'error';

export interface ValidationIssue {
  level: IssueLevel;
  list: string;
  name: string;
  reason: string;
}

export interface PerListStat {
  list: string;
  description: string | null;
  rows: number;
  places: number;
  nameOnly: number;
}

export interface ValidationReport {
  generatedAt: string;
  ok: boolean;
  summary: {
    listsProcessed: number;
    placeRows: number;
    uniquePlaces: number;
    withCid: number;
    nameOnly: number;
    appearingInMultipleLists: number;
  };
  perList: PerListStat[];
  issues: ValidationIssue[];
}

export interface IngestOutput {
  generatedAt: string;
  source: 'google-takeout';
  places: NormalizedPlace[];
}
