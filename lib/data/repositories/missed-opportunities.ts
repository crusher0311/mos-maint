// Repository for the `missed_opportunity_reports` Mongo cache collection
// (Task #1146) plus the cached-VHI-plan lookup the report evaluator needs.
//
// The report itself is computed from the canonical PG normalized stores
// (see lib/missed-opportunities-service.ts); this module owns every Mongo
// touch so app code never imports the driver directly (enforced by
// scripts/check-direct-db.cjs).
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import { getCachedPlan, getCachedPlans, type CachedPlan } from "@/lib/plan-cache";
import type { MissedOpportunityReport } from "@/lib/missed-opportunities";

const COLLECTION = "missed_opportunity_reports";

async function collection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(COLLECTION);
}

export interface MissedOppReportCacheDoc {
  shopId: number;
  windowDays: number;
  report: MissedOpportunityReport;
  generatedAt: Date;
}

/** Latest cached report for (shop, window), or null. */
export async function getCachedMissedOppReport(
  shopId: number,
  windowDays: number,
): Promise<MissedOppReportCacheDoc | null> {
  const col = await collection();
  const doc = await col.findOne(
    { shopId, windowDays },
    { projection: { _id: 0 } },
  );
  return (doc as unknown as MissedOppReportCacheDoc) ?? null;
}

/** Upsert the cached report for (shop, window). */
export async function setCachedMissedOppReport(
  shopId: number,
  windowDays: number,
  report: MissedOpportunityReport,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { shopId, windowDays },
    { $set: { shopId, windowDays, report, generatedAt: new Date() } },
    { upsert: true },
  );
}

/**
 * Task #1184 — shops (and their largest requested window) that have ever
 * loaded the Missed Opportunities report. Viewing the report always writes a
 * cache doc (even when the report is empty), so this is a self-selecting
 * warm-target list: the plan pre-warm only spends work on shops that actually
 * use the report.
 */
export async function listMissedOppReportShops(): Promise<
  Array<{ shopId: number; windowDays: number }>
> {
  const col = await collection();
  const rows = await col
    .aggregate([
      { $group: { _id: "$shopId", windowDays: { $max: "$windowDays" } } },
      { $limit: 500 },
    ])
    .toArray();
  return rows
    .map((r) => ({ shopId: Number(r._id), windowDays: Number(r.windowDays) }))
    .filter((r) => Number.isFinite(r.shopId) && Number.isFinite(r.windowDays));
}

/** Read-only production-readiness inspection; never creates or changes indexes. */
export async function checkMissedOpportunityMongoIndexes(): Promise<{
  reportCache: boolean;
  planCache: boolean;
  indexes: { reportCache: string[]; planCache: string[] };
}> {
  const db = await getDb();
  const readIndexes = async (name: string) => {
    try {
      return await db.collection(name).listIndexes().toArray();
    } catch (err: any) {
      if (err?.codeName === "NamespaceNotFound" || err?.code === 26) return [];
      throw err;
    }
  };
  const [reportIndexes, planIndexes] = await Promise.all([
    readIndexes(COLLECTION),
    readIndexes("cached_plans"),
  ]);
  const hasPrefix = (
    indexes: Array<{ key?: Record<string, number> }>,
    expected: Array<[string, number]>,
  ) => indexes.some((index) => {
    const entries = Object.entries(index.key || {});
    return expected.every(
      ([field, direction], position) =>
        entries[position]?.[0] === field && entries[position]?.[1] === direction,
    );
  });
  return {
    reportCache: hasPrefix(reportIndexes, [["shopId", 1], ["windowDays", 1]]),
    planCache:
      hasPrefix(planIndexes, [["shopId", 1], ["vin", 1], ["createdAt", -1]]) ||
      hasPrefix(planIndexes, [["vin", 1], ["shopId", 1], ["createdAt", -1]]),
    indexes: {
      reportCache: reportIndexes.map((index) => index.name),
      planCache: planIndexes.map((index) => index.name),
    },
  };
}

/**
 * Cache-only VHI plan lookup for one vehicle. Never triggers a rebuild —
 * a miss means the RO is reported as "not evaluated". Mirrors the
 * Estimate Assist audit's read (`getCachedPlan`), including its validity
 * semantics (expiry, schema version, mileage tolerance).
 */
export async function findCachedPlanForVehicle(
  shopId: number,
  vin: string,
  mileage: number | null,
): Promise<CachedPlan | null> {
  const db = await getDb();
  return getCachedPlan(db, vin.toUpperCase(), shopId, mileage);
}

/** Cache-only batched VHI lookup; validity semantics are shared with getCachedPlan. */
export async function findCachedPlansForVehicles(
  shopId: number,
  vehicles: Array<{ vin: string; mileage: number | null }>,
): Promise<Map<string, CachedPlan | null>> {
  const db = await getDb();
  return getCachedPlans(
    db,
    shopId,
    vehicles.map(({ vin, mileage }) => ({ vin, currentMiles: mileage })),
  );
}
