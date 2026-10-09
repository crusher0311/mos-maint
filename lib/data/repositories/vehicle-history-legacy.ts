import { sql } from "drizzle-orm";
import { getDb as getMongoDb } from "@/lib/data/db";
import { getDb as getPgDb } from "@/lib/db/drizzle";
import { isLegacyVehiclesPgCanonical } from "@/lib/db/legacy-store-write-mode";
import { isProtractorOpsPgCanonical } from "@/lib/db/integration-ops-write-mode";
import { classifyComponents, deferredSnapshotEvent } from "@/lib/vehicle-history/evidence";
import { eventDate, eventIdentity, MAX_HISTORY_EVENTS, type HistoryEvent } from "@/lib/vehicle-history/model";
import { historyBudget } from "@/lib/vehicle-history/budget";

export interface LegacyHistoryResult {
  events: HistoryEvent[];
  hasMore: boolean;
  warnings: string[];
}
export const historyLegacyDependencies = {
  getMongoDb, getPgDb, isLegacyVehiclesPgCanonical, isProtractorOpsPgCanonical,
};

/** Exact local ownership; do NOT reuse the legacy PG helper's shopId IS NULL fallback. */
async function manualDeclines(shopId: number, vin: string): Promise<any[]> {
  if (historyLegacyDependencies.isLegacyVehiclesPgCanonical()) {
    return historyLegacyDependencies.getPgDb().transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '1500ms'`);
      const rows = await tx.execute(sql`
        SELECT payload->'declinedServices' AS items FROM pre_normalized_vehicles
        WHERE shop_id = ${shopId} AND vin = ${vin} LIMIT 2`);
      // Duplicate/conflicting identities are not auto-linked.
      return rows.length === 1 && Array.isArray((rows[0] as any).items) ? (rows[0] as any).items : [];
    });
  }
  const db = await historyLegacyDependencies.getMongoDb();
  const rows = await db.collection("vehicles").find(
    { shopId: { $in: [shopId, String(shopId)] }, vin },
    { projection: { declinedServices: 1 } },
  ).limit(2).maxTimeMS(1500).toArray();
  return rows.length === 1 && Array.isArray(rows[0].declinedServices) ? rows[0].declinedServices : [];
}

async function protractorSnapshot(shopId: number, vin: string): Promise<any | null> {
  if (historyLegacyDependencies.isProtractorOpsPgCanonical()) {
    return historyLegacyDependencies.getPgDb().transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '1500ms'`);
      const rows = await tx.execute(sql`
        SELECT payload FROM protractor_deferred_work
        WHERE shop_id = ${shopId} AND deferred_work_id = ${`vin:${vin}`} LIMIT 1`);
      return (rows[0] as any)?.payload ?? null;
    });
  }
  const db = await historyLegacyDependencies.getMongoDb();
  return db.collection("protractor_deferred_work").findOne(
    { shopId, vin }, { maxTimeMS: 1500 },
  );
}

/** job_index is still the canonical legacy Tekmetric decline source (not its PG mirror). */
async function tekmetricDeclines(shopId: number, vin: string): Promise<any[]> {
  const db = await historyLegacyDependencies.getMongoDb();
  return db.collection("job_index").find({
    shopId: { $in: [shopId, String(shopId)] },
    "vehicle.vin": vin, authorized: false, "metadata.sourceType": "tekmetric",
  }, { projection: { servicePackageId: 1, workOrderNumber: 1, performedAt: 1, job: 1, workOrderId: 1 } })
    .sort({ performedAt: -1 }).limit(MAX_HISTORY_EVENTS + 1).maxTimeMS(1500).toArray();
}

export async function readLegacyVehicleHistory(
  shopId: number, vin: string, location: string, provider: string,
): Promise<LegacyHistoryResult> {
  const result: LegacyHistoryResult = { events: [], hasMore: false, warnings: [] };
  const budget = historyBudget(4000);
  try {
    const rows = await budget(() => manualDeclines(shopId, vin));
    result.hasMore ||= rows.length > MAX_HISTORY_EVENTS;
    rows.slice(0, MAX_HISTORY_EVENTS).forEach((item, index) => {
      const title = String(item.serviceName || item.serviceKey || "Manually declined work");
      const semantic = classifyComponents(title);
      const jobId = String(item.id || `${item.serviceKey}:${item.declinedAt ?? "undated"}:${index}`);
      result.events.push({
        id: eventIdentity(shopId, "manual", null, jobId), shopId, location,
        provider: "manual", workOrderId: null, jobId, title, date: eventDate(item.declinedAt),
        mileage: typeof item.mileage === "number" ? item.mileage : null,
        // Old manual decline entries did not record their mileage unit.
        mileageUnit: null, status: "declined", origin: "manual",
        components: semantic.components, componentsComplete: semantic.complete, readOnly: true,
      });
    });
  } catch { result.warnings.push("Manual declined-work records are unavailable."); }
  if (provider === "protractor") {
    try {
      const snapshot = await budget(() => protractorSnapshot(shopId, vin));
      if (!snapshot || Number(snapshot.shopId) !== shopId || snapshot.vin !== vin ||
          !Array.isArray(snapshot.items)) {
        result.warnings.push("No usable Protractor deferred-work snapshot. Absence is not proof of completion.");
      } else {
        result.hasMore ||= snapshot.items.length > MAX_HISTORY_EVENTS;
        result.events.push(...snapshot.items.slice(0, MAX_HISTORY_EVENTS)
          .map((item: any, index: number) => deferredSnapshotEvent(item, index, shopId, location, provider)));
        const fetched = eventDate(snapshot.fetchedAt);
        result.warnings.push(`Protractor snapshot fetched ${fetched ?? "at an unknown time"}; snapshots may omit prior deferred events.`);
      }
    } catch { result.warnings.push("Protractor deferred-work snapshot is unavailable."); }
  } else if (provider === "tekmetric") {
    try {
      const rows = await budget(() => tekmetricDeclines(shopId, vin));
      result.hasMore ||= rows.length > MAX_HISTORY_EVENTS;
      rows.slice(0, MAX_HISTORY_EVENTS).forEach(row => {
        const event = deferredSnapshotEvent({
          id: row.servicePackageId || String(row._id), title: row.job?.title,
          originalWorkOrderId: row.workOrderId, date: row.performedAt,
        }, 0, shopId, location, "tekmetric");
        event.origin = "legacy_job_index";
        result.events.push(event);
      });
    } catch { result.warnings.push("Legacy Tekmetric deferred-work records are unavailable."); }
  } else {
    result.warnings.push(`${provider || "Unknown provider"} deferred coverage is limited to normalized and manual evidence.`);
  }
  return result;
}
