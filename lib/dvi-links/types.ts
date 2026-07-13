// Task #860: DVI share-link ingestion — shared types.
//
// These types are intentionally free of any server-only imports so parsers
// can be unit-tested under tsx (see server-only-untestable-under-tsx memory).

/** Severity buckets common to every DVI provider. */
export type DviSeverity = "required" | "suggested" | "ok" | "info";

/** Providers we can detect. Adding one = register a matcher + parser. */
export type DviLinkProvider =
  | "autoserve1"
  | "autovitals"
  | "mastertech"
  | "autoops"
  | "autoflow";

/** Outcome classification for a fetch attempt. */
export type DviFetchOutcome = "ok" | "expired" | "blocked" | "error" | "media";

/** Parse outcome for a fetched snapshot. */
export type DviParseStatus = "parsed" | "failed" | "pending" | "na";

export interface DviMeasurement {
  name: string;
  value: string;
  unit?: string | null;
}

export interface ParsedDviItem {
  /** Customer-facing item name ("Front Brakes", "Battery"). */
  name: string;
  /** Section / category label when the provider has one. */
  section?: string | null;
  severity: DviSeverity;
  /** Provider finding text ("Dirty", "At service limit"). */
  finding?: string | null;
  /** Provider recommendation text ("Replace front brake pads"). */
  recommendation?: string | null;
  notes?: string | null;
  measurements?: DviMeasurement[];
  photoUrls?: string[];
}

export interface ParsedDviReport {
  provider: DviLinkProvider;
  /** VIN when the report carries one (uppercased). */
  vin?: string | null;
  odometer?: number | null;
  odometerUnit?: string | null;
  /** RO / invoice number as shown by the provider. */
  roNumber?: string | null;
  inspectionName?: string | null;
  inspectionDate?: string | null; // ISO string
  technician?: string | null;
  advisor?: string | null;
  shopName?: string | null;
  counts: { required: number; suggested: number; ok: number; info: number };
  items: ParsedDviItem[];
  /** Media-only links (AutoOps share links) carry the media URL here. */
  mediaUrls?: string[];
}

export interface DetectedDviLink {
  provider: DviLinkProvider;
  /** Normalized URL (trimmed, no trailing punctuation). */
  url: string;
}

export interface DviParseResult {
  ok: boolean;
  report?: ParsedDviReport;
  error?: string;
}
