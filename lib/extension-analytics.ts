import { getDb } from "./mongo";

export interface PushToROEvent {
  shopId: number;
  userId?: string;
  enterpriseId?: string;
  vin?: string;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  jobTitle: string;
  jobSource: "plan" | "failures" | "lookup" | "canned" | "autocomplete";
  repairOrderId?: string;
  laborAmount?: number;
  partsAmount?: number;
  totalAmount?: number;
  timestamp: Date;
}

export async function trackPushToRO(event: Omit<PushToROEvent, "timestamp">): Promise<void> {
  const db = await getDb();
  await db.collection("extension_analytics").insertOne({
    eventType: "push_to_ro",
    ...event,
    timestamp: new Date(),
  });
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
  const db = await getDb();
  
  const matchStage: any = { eventType: "push_to_ro" };
  if (params.shopId) matchStage.shopId = params.shopId;
  if (params.enterpriseId) matchStage.enterpriseId = params.enterpriseId;
  if (params.startDate || params.endDate) {
    matchStage.timestamp = {};
    if (params.startDate) matchStage.timestamp.$gte = params.startDate;
    if (params.endDate) matchStage.timestamp.$lte = params.endDate;
  }

  const [totalResult, bySourceResult, byDayResult, topJobsResult] = await Promise.all([
    db.collection("extension_analytics").countDocuments(matchStage),
    
    db.collection("extension_analytics").aggregate([
      { $match: matchStage },
      { $group: { _id: "$jobSource", count: { $sum: 1 } } },
    ]).toArray(),
    
    db.collection("extension_analytics").aggregate([
      { $match: matchStage },
      { 
        $group: { 
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } }, 
          count: { $sum: 1 } 
        } 
      },
      { $sort: { _id: -1 } },
      { $limit: 30 },
    ]).toArray(),
    
    db.collection("extension_analytics").aggregate([
      { $match: matchStage },
      { $group: { _id: "$jobTitle", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]).toArray(),
  ]);

  const bySource: Record<string, number> = {};
  for (const row of bySourceResult) {
    bySource[row._id || "unknown"] = row.count;
  }

  return {
    totalPushes: totalResult,
    bySource,
    byDay: byDayResult.map(r => ({ date: r._id, count: r.count })),
    topJobs: topJobsResult.map(r => ({ jobTitle: r._id, count: r.count })),
  };
}
