import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let cachedStats: { totalRequests: number; totalCost: number; cachedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const db = await getDb();
    
    // Fast queries that use indexes
    const [totalShops, totalUsers, recentShops] = await Promise.all([
      db.collection("shops").estimatedDocumentCount(),
      db.collection("users").estimatedDocumentCount(),
      db.collection("shops")
        .find()
        .sort({ createdAt: -1 })
        .limit(5)
        .project({ shopId: 1, name: 1, createdAt: 1 })
        .toArray()
    ]);
    
    // Use cached usage stats or compute in background
    let usage = { totalRequests: 0, totalCost: 0 };
    const now = Date.now();
    
    if (cachedStats && (now - cachedStats.cachedAt) < CACHE_TTL_MS) {
      usage = { totalRequests: cachedStats.totalRequests, totalCost: cachedStats.totalCost };
    } else {
      // Use estimated count for requests (instant) and skip expensive cost aggregation
      const estimatedRequests = await db.collection("usage_logs").estimatedDocumentCount();
      usage = { totalRequests: estimatedRequests, totalCost: cachedStats?.totalCost || 0 };
      
      // Update cost in background (don't block response)
      db.collection("usage_logs").aggregate([
        { $group: { _id: null, totalCost: { $sum: "$estimatedCost" } } }
      ]).toArray().then(result => {
        cachedStats = {
          totalRequests: estimatedRequests,
          totalCost: result[0]?.totalCost || 0,
          cachedAt: Date.now()
        };
      }).catch(err => console.error("Background stats error:", err));
    }
    
    return NextResponse.json({
      ok: true,
      totalShops,
      totalUsers,
      totalRequests: usage.totalRequests,
      totalCost: usage.totalCost,
      recentShops,
    });
  } catch (err: any) {
    console.error("Platform stats error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
