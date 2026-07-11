// lib/vehicle-display.ts
//
// Shared client-safe helpers for resolving a row's vehicle year/make/model,
// preferring structured `vehicle.*` fields and falling back to parsing the
// legacy `displayVehicle` string ("2018 Ford F-150"). This is the single
// source of truth for the parse — it was previously copy-pasted three times
// inside app/dashboard/DashboardClient.tsx (sticker/keytag quick-print,
// Job Lookup, Common Failures) and had to be fixed in lockstep.

export interface ResolvedVehicleFields {
  year?: number;
  make?: string;
  model?: string;
}

/**
 * Parse a legacy display string like "2018 Ford F-150" into year + the
 * remaining whitespace-split parts. Exported so callers with different
 * make/model policies (e.g. two-word-make logo matching) can share the same
 * year/split behavior.
 */
export function splitDisplayVehicle(display: unknown): {
  year?: number;
  parts: string[];
} {
  const vehicleStr = display ? String(display) : "";
  const yearMatch = vehicleStr.match(/^(\d{4})/);
  const year = yearMatch ? parseInt(yearMatch[1]) : undefined;
  const afterYear = yearMatch ? vehicleStr.slice(4).trim() : vehicleStr;
  const parts = afterYear.split(" ").filter(Boolean);
  return { year, parts };
}

/**
 * Resolve year/make/model for a dashboard row: structured `vehicle.*` fields
 * win; when ALL THREE are missing, fall back to parsing `displayVehicle`
 * (first token after the year = make, remainder = model).
 */
export function resolveVehicleFields(r: any): ResolvedVehicleFields {
  let year = r?.vehicle?.year;
  let make = r?.vehicle?.make;
  let model = r?.vehicle?.model;
  if (!year && !make && !model && r?.displayVehicle) {
    const parsed = splitDisplayVehicle(r.displayVehicle || "");
    year = parsed.year;
    make = parsed.parts[0] || undefined;
    model = parsed.parts.slice(1).join(" ") || undefined;
  }
  return { year, make, model };
}
