import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  
  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId: String(shopId) });
  
  if (!shop?.platformAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const collections = [
    'normalized_vehicles',
    'normalized_customers',
    'normalized_work_orders',
    'normalized_service_jobs',
    'normalized_payments',
    'normalized_inspections',
    'normalized_recommendations',
  ];

  // Run the per-collection counts/aggregations concurrently — the serial
  // version got linearly slower as collections grew.
  const collectStats = async (collName: string) => {
    const collection = db.collection(collName);

    const [totalCount, bySourceAgg, recentCount] = await Promise.all([
      collection.countDocuments({ deletedAt: null }),
      collection.aggregate([
        { $match: { deletedAt: null } },
        { $group: { _id: '$provenance.sourceSystem', count: { $sum: 1 } } }
      ]).toArray(),
      collection.countDocuments({
        deletedAt: null,
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }),
    ]);

    const bySource: Record<string, number> = {};
    for (const item of bySourceAgg) {
      bySource[item._id || 'unknown'] = item.count;
    }

    return {
      total: totalCount,
      bySource,
      last24Hours: recentCount,
    };
  };

  const [perCollection, jobIndexCount, coverageByShop] = await Promise.all([
    Promise.all(collections.map(async (name) => [name, await collectStats(name)] as const)),
    db.collection('job_index').countDocuments(),
    db.collection('normalized_work_orders').aggregate([
      { $match: { deletedAt: null } },
      { $group: { _id: '$shopId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 }
    ]).toArray(),
  ]);

  const stats: Record<string, any> = {};
  for (const [name, s] of perCollection) {
    stats[name] = s;
  }
  stats.legacy_job_index = { total: jobIndexCount };

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    stats,
    coverageByShop: coverageByShop.map(s => ({ shopId: s._id, workOrders: s.count })),
  });
}
