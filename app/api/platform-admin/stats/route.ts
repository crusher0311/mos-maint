import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    
    const [totalShops, totalUsers, usageTotals, recentShops] = await Promise.all([
      db.collection("shops").countDocuments(),
      db.collection("users").countDocuments(),
      db.collection("usage_logs").aggregate([
        {
          $group: {
            _id: null,
            totalRequests: { $sum: 1 },
            totalCost: { $sum: "$estimatedCost" },
          }
        }
      ]).toArray(),
      db.collection("shops")
        .find()
        .sort({ createdAt: -1 })
        .limit(5)
        .project({ shopId: 1, name: 1, createdAt: 1 })
        .toArray()
    ]);
    
    const usage = usageTotals[0] || { totalRequests: 0, totalCost: 0 };
    
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
