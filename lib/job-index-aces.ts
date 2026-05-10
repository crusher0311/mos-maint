// lib/job-index-aces.ts
//
// Task #382 — Shared ACES-enrichment helper used by every job_index writer
// (Tekmetric, Shop-Ware, Protractor) and by the historical backfill script.
//
// We attach four pieces of provenance to a job_index doc's `vehicle` sub-doc:
//   - acesVehicleId     — DataOne `vehicle_id` (null when ambiguous/missing)
//   - acesEngineId      — DataOne `engine_id`  (null when ambiguous/missing)
//   - submodelKey       — `year|make|model|style` (lower-cased), used by
//                          the scorer's submodel-match tier (Tier C)
//   - acesDecodedAt     — stamped on every successful lookup so we can tell
//                          a "decoded but unresolvable" doc from a
//                          "never tried" one (the latter is what the
//                          backfill script targets)
//
// The DataOne lookup is local-PG-cached (`batchDecodeSquishes` reads from
// `dataone_vin_reference`), so on-write enrichment is effectively free.
// The helper soft-fails on any error so an indexer outage path never
// blocks the primary job_index write.

import {
  batchDecodeSquishes,
  toSquishPublic,
  type VinReferenceData,
} from "@/lib/integrations/dataone-local";

export interface AcesEnrichment {
  acesVehicleId: number | null;
  acesEngineId: number | null;
  submodelKey: string | null;
  acesDecodedAt: Date;
  // Task #382 — DataOne is the authority on year/make/model when the
  // squish resolves. Callers should prefer these over source-supplied
  // values (Tekmetric / SW / Protractor / SMS often disagree on
  // make spelling, trim formatting, etc). Null when DataOne couldn't
  // resolve a unique row.
  year: number | null;
  make: string | null;
  model: string | null;
}

/**
 * Resolve ACES IDs for a single VIN. Returns null when the VIN is missing
 * or malformed (so callers can leave the existing fields untouched);
 * returns an enrichment object with `acesVehicleId === null` /
 * `acesEngineId === null` when DataOne couldn't resolve a unique variant
 * — the `acesDecodedAt` stamp still lands so the backfill knows we tried.
 */
export async function enrichVinWithAces(
  vin: string | null | undefined,
): Promise<AcesEnrichment | null> {
  if (!vin || typeof vin !== "string" || vin.length < 11) return null;
  let squish: string;
  try {
    squish = toSquishPublic(vin);
  } catch {
    return null;
  }
  try {
    const decoded = await batchDecodeSquishes([squish]);
    const row = decoded.get(squish);
    return acesFromDecoded(row);
  } catch (err) {
    // Soft-fail: indexer/backfill should still write the underlying row.
    console.warn(
      `[ACES enrich] DataOne lookup failed for VIN ${vin.slice(0, 8)}…: ${(err as Error)?.message || err}`,
    );
    return null;
  }
}

/**
 * Bulk variant — single DataOne batch lookup for many VINs at once. Returns
 * a Map keyed by the original VIN string (preserving the caller's casing).
 * Use this from the historical backfill so a 10k-row Mongo page becomes one
 * PG round-trip instead of ten thousand.
 */
export async function enrichVinsWithAces(
  vins: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, AcesEnrichment>> {
  const result = new Map<string, AcesEnrichment>();
  if (vins.length === 0) return result;

  const squishToVin = new Map<string, string>();
  for (const v of vins) {
    if (!v || typeof v !== "string" || v.length < 11) continue;
    try {
      const sq = toSquishPublic(v);
      if (!squishToVin.has(sq)) squishToVin.set(sq, v);
    } catch {
      /* skip unparseable */
    }
  }
  if (squishToVin.size === 0) return result;

  let decoded: Map<string, VinReferenceData>;
  try {
    decoded = await batchDecodeSquishes([...squishToVin.keys()]);
  } catch (err) {
    console.warn(
      `[ACES enrich] Bulk DataOne lookup failed (${vins.length} VINs): ${(err as Error)?.message || err}`,
    );
    return result;
  }

  for (const [sq, vin] of squishToVin) {
    const row = decoded.get(sq);
    const enriched = acesFromDecoded(row);
    if (enriched) result.set(vin, enriched);
  }
  return result;
}

/**
 * Pure helper — exported for the smoke tests so they can exercise the
 * field-extraction logic without spinning up a DataOne PG connection.
 */
export function acesFromDecoded(
  row: VinReferenceData | null | undefined,
): AcesEnrichment | null {
  if (!row) return null;
  const acesVehicleId =
    typeof row.vehicle_id === "number" && row.vehicle_id > 0
      ? row.vehicle_id
      : null;
  const acesEngineId =
    typeof row.engine_id === "number" && row.engine_id > 0
      ? row.engine_id
      : null;
  let submodelKey: string | null = null;
  if (row.year && row.make && row.model && row.style) {
    submodelKey = `${String(row.year).trim()}|${String(row.make).trim().toLowerCase()}|${String(row.model).trim().toLowerCase()}|${String(row.style).trim().toLowerCase()}`;
  }
  const year = typeof row.year === "number" && row.year > 1900 ? row.year : null;
  const make = typeof row.make === "string" && row.make.trim().length > 0 ? row.make.trim() : null;
  const model = typeof row.model === "string" && row.model.trim().length > 0 ? row.model.trim() : null;
  return {
    acesVehicleId,
    acesEngineId,
    submodelKey,
    acesDecodedAt: new Date(),
    year,
    make,
    model,
  };
}

// ---------------------------------------------------------------------------
// PCDB part-line helpers (Task #382)
// ---------------------------------------------------------------------------
//
// Tekmetric and Shop-Ware sometimes carry PartsTech/PCDB IDs on raw part
// payloads (the field names vary by integration vintage — Tekmetric has
// surfaced `pcdbPartTypeId` / `pcdbPartTypeName` / `partsTechPartId` on
// some part payloads since the catalog refresh; Shop-Ware exposes them
// inside `integrator_tags`). We attach whichever fields are present and
// leave the rest absent — never invent a PCDB ID we don't have. The
// Protractor extractor in lib/job-index.ts intentionally skips this:
// Protractor doesn't surface PCDB at all and we don't want the absence to
// look like a coverage regression.

export interface PcdbPartFields {
  pcdbPartTypeId?: number;
  pcdbPartTypeName?: string;
  partsTechPartId?: string;
}

const TAG_KEYS_PARTSTECH_ID = new Set([
  "partstech_part_id",
  "partstechpartid",
  "parts_tech_part_id",
]);
const TAG_KEYS_PCDB_ID = new Set([
  "pcdb_part_type_id",
  "pcdbparttypeid",
  "pcdb_id",
]);
const TAG_KEYS_PCDB_NAME = new Set([
  "pcdb_part_type_name",
  "pcdbparttypename",
  "pcdb_name",
]);

/**
 * Extract PCDB / PartsTech IDs from a Tekmetric raw part record. Returns
 * an empty object when none are present so callers can spread the result
 * directly onto the line item without sprinkling `?? undefined`.
 */
export function extractTekmetricPcdb(part: any): PcdbPartFields {
  if (!part || typeof part !== "object") return {};
  const out: PcdbPartFields = {};
  const pcdbId = part.pcdbPartTypeId ?? part.pcdb_part_type_id;
  const pcdbName = part.pcdbPartTypeName ?? part.pcdb_part_type_name;
  const ptId = part.partsTechPartId ?? part.parts_tech_part_id;
  if (typeof pcdbId === "number" && pcdbId > 0) out.pcdbPartTypeId = pcdbId;
  else if (typeof pcdbId === "string" && /^\d+$/.test(pcdbId)) out.pcdbPartTypeId = parseInt(pcdbId, 10);
  if (typeof pcdbName === "string" && pcdbName.length > 0) out.pcdbPartTypeName = pcdbName;
  if (typeof ptId === "string" && ptId.length > 0) out.partsTechPartId = ptId;
  else if (typeof ptId === "number" && ptId > 0) out.partsTechPartId = String(ptId);
  return out;
}

/**
 * Extract PCDB / PartsTech IDs from a Shop-Ware raw part record. Shop-Ware
 * stores integration metadata in `integrator_tags` (an array of `{name,
 * value}` records) so we walk the tag list looking for the PCDB / PartsTech
 * names. Names are case-insensitive and accept underscores or no separator.
 */
export function extractShopWarePcdb(part: any): PcdbPartFields {
  if (!part || typeof part !== "object") return {};
  const out: PcdbPartFields = {};
  // Direct fields take precedence over tag-derived values when both exist.
  const directId = part.pcdbPartTypeId ?? part.pcdb_part_type_id;
  if (typeof directId === "number" && directId > 0) out.pcdbPartTypeId = directId;
  const directName = part.pcdbPartTypeName ?? part.pcdb_part_type_name;
  if (typeof directName === "string" && directName.length > 0) out.pcdbPartTypeName = directName;
  const directPt = part.partsTechPartId ?? part.parts_tech_part_id;
  if (typeof directPt === "string" && directPt.length > 0) out.partsTechPartId = directPt;

  const tags = Array.isArray(part.integrator_tags) ? part.integrator_tags : [];
  for (const tag of tags) {
    if (!tag || typeof tag !== "object") continue;
    const name = String(tag.name || "").toLowerCase().replace(/\s+/g, "_");
    const value = tag.value;
    if (TAG_KEYS_PARTSTECH_ID.has(name) && out.partsTechPartId == null) {
      if (typeof value === "string" && value.length > 0) out.partsTechPartId = value;
      else if (typeof value === "number" && value > 0) out.partsTechPartId = String(value);
    } else if (TAG_KEYS_PCDB_ID.has(name) && out.pcdbPartTypeId == null) {
      if (typeof value === "number" && value > 0) out.pcdbPartTypeId = value;
      else if (typeof value === "string" && /^\d+$/.test(value)) out.pcdbPartTypeId = parseInt(value, 10);
    } else if (TAG_KEYS_PCDB_NAME.has(name) && out.pcdbPartTypeName == null) {
      if (typeof value === "string" && value.length > 0) out.pcdbPartTypeName = value;
    }
  }
  return out;
}
