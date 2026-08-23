import { getDb } from "./mongo";
import {
  pgInsertExtensionAnalytics,
  pgPushToROStats,
} from "@/lib/db/repositories/wave1";

export interface PushToROEvent {
  shopId: number;
  userId?: string;
  enterpriseId?: string;
  vin?: string;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  jobTitle: string;
  jobSource:
    | "plan"
    | "failures"
    | "lookup"
    | "canned"
    | "autocomplete"
    | "deferred"
    | "extension_protractor"
    | "canned_extension_protractor";
  repairOrderId?: string;
  laborAmount?: number;
  partsAmount?: number;
  totalAmount?: number;
  timestamp: Date;
}

export async function trackPushToRO(event: Omit<PushToROEvent, "timestamp">): Promise<void> {
  const timestamp = new Date();
  const doc = { eventType: "push_to_ro", ...event, timestamp };

  // Wave 1 dual-write: PG (canonical — must succeed) + Mongo (legacy
  // best-effort mirror, retained for the W1.5 soak window).
  await pgInsertExtensionAnalytics(doc);
  try {
    const db = await getDb();
    await db.collection("extension_analytics").insertOne(doc);
  } catch (err) {
    console.error("[extension-analytics] Mongo mirror failed (non-fatal):", err);
  }
}

export async function getPushToROStats(params: {
  shopId?: number;
  enterpriseId?: string;
  startDate?: Date;
  endDate?: Date;
}): Promise<{
  totalPushes: number;
  bySource: Record<string, number>;
  byDay: Array<{ date: string; count: number }>;
  topJobs: Array<{ jobTitle: string; count: number }>;
}> {
  // Wave 1: read path is PG-only.
  return pgPushToROStats(params);
}
