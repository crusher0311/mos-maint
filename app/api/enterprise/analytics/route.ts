import { NextRequest, NextResponse } from "next/server";
import { getEnterpriseAnalytics, getEnterpriseById, getShopsForEnterprise } from "@/lib/enterprise";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

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
    const enterprise = await getEnterpriseById(enterpriseId);
    
    const shopIds = enterprise?.shopIds?.map(String) || [];
    
    const vehicleCounts = shopIds.length > 0 ? await sql`
      SELECT shop_id, 
        COUNT(*)::int as count, 
        COUNT(*) FILTER (WHERE status->>'active' = 'true')::int as active_count
      FROM vehicles 
      WHERE shop_id = ANY(${shopIds})
      GROUP BY shop_id
    ` : [];
    
    const vehicleMap = new Map(vehicleCounts.map((v: any) => [String(v.shop_id), v]));
    
    const shopsWithVehicles = shops.map((shop: any) => {
      const counts = vehicleMap.get(String(shop.shopId)) || { count: 0, active_count: 0 };
      return {
        ...shop,
        totalVehicles: counts.count,
        activeVehicles: counts.active_count
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
