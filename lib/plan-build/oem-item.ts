/**
 * Mapper that converts a raw DataOne `MaintenanceItem` row (or any
 * already-flattened `{ name, category, ... }` shape) into the `OEMItem`
 * shape that `triage()` consumes.
 *
 * Lifted out of `app/api/plan-build/route.ts` so it can be exercised from
 * deterministic smoke tests without pulling in the route's Mongo / DataOne
 * / DVI dependencies. `lib/plan-build/triage.ts` re-exports from here so
 * existing call sites keep importing `toOEMItem` from the triage module.
 *
 * Keep this file pure: no I/O, no `process.env`, no Next.js types — just a
 * straight field-by-field mapping over the input row.
 */

export interface OEMItem {
  maintenance_id?: string | number;
  name?: string;
  category?: string;
  miles?: number | null;
  months?: number | null;
  notes?: string | null;
  intervals?: Array<{ units?: string | null; value?: number | null }>;
}

export function toOEMItem(item: any): OEMItem {
  return {
    maintenance_id: item?.maintenance_id,
    name: item?.maintenance_name ?? item?.name,
    category: item?.maintenance_category ?? item?.category,
    miles: item?.miles ?? null,
    months: item?.months ?? null,
    notes: item?.maintenance_notes ?? item?.notes ?? null,
    intervals: Array.isArray(item?.intervals)
      ? item.intervals.map((iv: any) => ({
          units: iv?.units ?? null,
          value: iv?.value ?? null,
        }))
      : [],
  };
}
