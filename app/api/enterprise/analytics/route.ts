import { NextRequest, NextResponse } from "next/server";
import { getEnterpriseAnalytics, getEnterpriseById, getShopsForEnterprise } from "@/lib/enterprise";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!["owner", "admin"].includes(session.role || "")) {
    return NextResponse.json({ error: "Forbidden - admin access required" }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const enterpriseId = searchParams.get("enterpriseId");
    const startDateStr = searchParams.get("startDate");
    const endDateStr = searchParams.get("endDate");
    
    if (!enterpriseId) {
      return NextResponse.json({ error: "Enterprise ID is required" }, { status: 400 });
    }
    
    const startDate = startDateStr ? new Date(startDateStr) : undefined;
    const endDate = endDateStr ? new Date(endDateStr) : undefined;
    
    const analytics = await getEnterpriseAnalytics(enterpriseId, startDate, endDate);
    
    if (!analytics) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }
    
    const shops = await getShopsForEnterprise(enterpriseId);
    
    const db = await getDb();
    const enterprise = await getEnterpriseById(enterpriseId);
    
    const vehicleCounts = await db.collection("vehicles").aggregate([
      { $match: { shopId: { $in: enterprise?.shopIds?.map(String) || [] } } },
      { $group: { _id: "$shopId", count: { $sum: 1 }, activeCount: { $sum: { $cond: [{ $eq: ["$status.active", true] }, 1, 0] } } } }
    ]).toArray();
    
    const vehicleMap = new Map(vehicleCounts.map((v: any) => [String(v._id), v]));
    
    const shopsWithVehicles = shops.map((shop: any) => {
      const counts = vehicleMap.get(String(shop.shopId)) || { count: 0, activeCount: 0 };
      return {
        ...shop,
        totalVehicles: counts.count,
        activeVehicles: counts.activeCount
      };
    });
    
    return NextResponse.json({
      ...analytics,
      shops: shopsWithVehicles
    });
  } catch (err: any) {
    console.error("Enterprise analytics error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
