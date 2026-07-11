// Repository for the `normalized_work_orders` collection (read shapes only).
//
// The normalization pipeline (webhooks / backfill) owns the writes and stays
// on the legacy allowlist; app routes must come through here so they never
// reach into the Mongo driver directly (enforced by
// `scripts/check-direct-db.cjs`).
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import { prefixRegex, vinPrefix } from "@/lib/dashboard-search";

const COLLECTION = "normalized_work_orders";

async function collection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(COLLECTION);
}

export interface WorkOrderPickerItem {
  id: string;
  workOrderNumber: string;
  status: string | null;
  vin: string | null;
  vehicle: { year: number | null; make: string | null; model: string | null };
  customerName: string | null;
  updatedAt: Date | null;
  closedAt: Date | null;
}

/**
 * Search/browse a shop's synced work orders for the Estimate Audit picker,
 * recent-first. With no search term this is a straight "most recently
 * updated" listing; with a term, every `$or` branch is an anchored (prefix)
 * expression via `lib/dashboard-search.ts`, so each branch is index-eligible
 * (companion indexes in `scripts/ensure-indexes.ts`) instead of a
 * leading-wildcard COLLSCAN — same pattern as the dashboard archived-WO
 * search.
 *
 * Because this reads `normalized_work_orders` (the same collection the audit
 * route resolves against), everything returned here is auditable — picking
 * from this list can't hit the audit's RO_NOT_SYNCED dead end.
 */
export async function searchWorkOrdersForPicker(
  shopId: number,
  search: string,
  limit: number,
): Promise<WorkOrderPickerItem[]> {
  const col = await collection();

  const query: Record<string, unknown> = {
    shopId,
    "softDelete.isDeleted": { $ne: true },
  };

  const term = search.trim();
  if (term) {
    const or: Record<string, unknown>[] = [
      { workOrderNumber: prefixRegex(term) },
      { vin: vinPrefix(term) },
      { "customer.name": prefixRegex(term) },
      { "vehicle.make": prefixRegex(term) },
      { "vehicle.model": prefixRegex(term) },
    ];
    query.$or = or;
  }

  const docs = await col
    .find(query)
    .sort({ updatedAt: -1 })
    .limit(limit)
    .project({
      _id: 1,
      workOrderNumber: 1,
      status: 1,
      vin: 1,
      "vehicle.year": 1,
      "vehicle.make": 1,
      "vehicle.model": 1,
      "customer.name": 1,
      updatedAt: 1,
      closedAt: 1,
    })
    .toArray();

  return docs.map((wo: any) => ({
    id: String(wo._id),
    workOrderNumber: wo.workOrderNumber ? String(wo.workOrderNumber) : "",
    status: wo.status ?? null,
    vin: wo.vin ?? null,
    vehicle: {
      year: wo.vehicle?.year ?? null,
      make: wo.vehicle?.make ?? null,
      model: wo.vehicle?.model ?? null,
    },
    customerName: wo.customer?.name ?? null,
    updatedAt: wo.updatedAt ?? null,
    closedAt: wo.closedAt ?? null,
  }));
}
