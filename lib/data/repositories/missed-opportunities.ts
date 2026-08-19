// Repository for the `missed_opportunity_reports` Mongo cache collection
// (Task #1146) plus the cached-VHI-plan lookup the report evaluator needs.
//
// The report itself is computed from the canonical PG normalized stores
// (see lib/missed-opportunities-service.ts); this module owns every Mongo
// touch so app code never imports the driver directly (enforced by
// scripts/check-direct-db.cjs).
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import { getCachedPlan, type CachedPlan } from "@/lib/plan-cache";
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
