import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { MAX_HISTORY_EVENTS, type HistoryCoverage, type HistoryEvent } from "@/lib/vehicle-history/model";
import { normalizedHistoryEvent, type NormalizedHistoryRow } from "@/lib/vehicle-history/evidence";
import { findShopByShopId } from "./shops";
import { readLegacyVehicleHistory } from "./vehicle-history-legacy";

export interface LocationHistory { events: HistoryEvent[]; coverage: HistoryCoverage }

export async function readVehicleHistoryLocation(shopId: number, vin: string, name: string): Promise<LocationHistory> {
  const started = Date.now();
  let normalized: LocationHistory;
  try { normalized = await readNormalizedVehicleHistory(shopId, vin, name); }
  catch {
    normalized = {
      events: [], coverage: { shopId, name, state: "unavailable", hasMore: false, fetchedAt: null,
        reason: "Normalized history is unavailable." },
    };
  }
  if (Date.now() - started > 5000) return normalized;
  const shop = await findShopByShopId(shopId);
  if (Date.now() - started > 5000) return normalized;
  const provider = String(shop?.integrationProvider || shop?.smsProvider || "");
  const legacy = await readLegacyVehicleHistory(shopId, vin, name, provider);
  return {
    events: [...normalized.events, ...legacy.events],
    coverage: {
      ...normalized.coverage,
      hasMore: normalized.coverage.hasMore || legacy.hasMore,
      state: "incomplete",
      reason: [normalized.coverage.reason, ...legacy.warnings].filter(Boolean).join(" "),
    },
  };
}

/**
 * Normalized entities are PG canonical regardless of Mongo shadow flags.
 * No provider network call, regex VIN search, tenant-wide scan, or Mongo fallback.
 * Keep the expression identical to the operator-approved supporting index.
 */
export async function readNormalizedVehicleHistory(
  shopId: number, vin: string, name: string,
  database: ReturnType<typeof getDb> = getDb(),
): Promise<LocationHistory> {
  return database.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '1500ms'`);
    const result = await tx.execute(sql`
      SELECT w.shop_id, w.provenance->>'sourceSystem' AS provider,
        w.id AS work_order_id, w.work_order_number,
        CASE WHEN octet_length(w.raw_data::text) <= 16384 THEN w.raw_data ELSE NULL END AS work_order_raw,
        w.provenance AS work_order_provenance,
        j.id AS job_id, j.job_number, j.provenance AS job_provenance,
        j.title, j.job_type, j.status AS job_status, j.raw_data AS job_raw,
        j.declined_at, j.completed_at, w.closed_date,
        w.odometer_in AS odometer, w.odometer_unit
      FROM normalized_work_orders w
      JOIN normalized_service_jobs j ON j.work_order_id = w.id AND j.shop_id = w.shop_id
      LEFT JOIN normalized_vehicles v ON v.id = w.vehicle_id
      WHERE w.shop_id = ${shopId} AND (w.vehicle->>'vin') = ${vin}
        AND (v.id IS NULL OR (v.shop_id = w.shop_id AND v.vin = ${vin}))
        AND COALESCE(w.soft_delete->>'isDeleted', 'false') <> 'true'
        AND COALESCE(j.soft_delete->>'isDeleted', 'false') <> 'true'
        AND (v.id IS NULL OR COALESCE(v.soft_delete->>'isDeleted', 'false') <> 'true')
      ORDER BY w.closed_date DESC NULLS LAST, w.id, j.id
      LIMIT ${MAX_HISTORY_EVENTS + 1}`);
    const rows = Array.from(result as unknown as NormalizedHistoryRow[]);
    const hasMore = rows.length > MAX_HISTORY_EVENTS;
    return {
      events: rows.slice(0, MAX_HISTORY_EVENTS).map(row => normalizedHistoryEvent(row, name)),
      coverage: {
        shopId, name, state: "incomplete", hasMore, fetchedAt: new Date().toISOString(),
        reason: hasMore
          ? `Showing at most ${MAX_HISTORY_EVENTS} source jobs; older history is not evaluated.`
          : "Synced records only. Missing, oversized (>16 KB), or ambiguous source receipts have unknown completion status. Provider history may be incomplete.",
      },
    };
  });
}
