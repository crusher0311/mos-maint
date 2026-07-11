// lib/aces-fields.ts
//
// Shared, dependency-free helpers for extracting ACES identity fields from a
// DataOne decode row. This is the single source of truth for:
//   - coercing DataOne `vehicle_id` / `engine_id` to `number | null`
//     (zero/missing/ambiguous all normalize to null), and
//   - building the submodel proxy key `year|make|model|style` (lower-cased,
//     trimmed, only when all four parts are present so empty-string keys can
//     never collide).
//
// Previously this logic was duplicated verbatim in lib/job-scoring.ts
// (extractVehicleSpecs) and lib/job-index-aces.ts (acesFromDecoded) and had
// to be kept in lockstep by hand. Both now import from here. Keep this module
// pure (no imports) so it stays safe to load from scoring paths, indexers,
// scripts, and tests alike.

/**
 * Coerce a DataOne ACES id (vehicle_id / engine_id) to a positive number or
 * null. `mergeCandidates` nulls these when the squish is ambiguous, so
 * zero/missing/non-numeric are all treated as "absent".
 */
export function coerceAcesId(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

/**
 * Build the submodel proxy key `year|make|model|style` (lower-cased). Returns
 * null unless all four parts are present, so we never collide on
 * empty-string keys. DataOne doesn't expose a discrete submodel_id — `style`
 * is the closest stable label (e.g. "EX-L", "Limited 4dr SUV").
 */
export function buildSubmodelKey(
  year: unknown,
  make: unknown,
  model: unknown,
  style: unknown,
): string | null {
  if (!year || !make || !model || !style) return null;
  return `${String(year).trim()}|${String(make).trim().toLowerCase()}|${String(model).trim().toLowerCase()}|${String(style).trim().toLowerCase()}`;
}
