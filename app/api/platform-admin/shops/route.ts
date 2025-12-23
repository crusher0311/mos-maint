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
    
    const shops = await db.collection("shops").find().toArray();
    
    const shopIds = shops.map(s => s.shopId);
    
    const [userCounts, vehicleCounts] = await Promise.all([
      db.collection("users").aggregate([
        { $match: { shopId: { $in: shopIds } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("vehicles").aggregate([
        { $match: { shopId: { $in: shopIds.map(String) } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray()
    ]);
    
    const userCountMap = new Map(userCounts.map(u => [String(u._id), u.count]));
    const vehicleCountMap = new Map(vehicleCounts.map(v => [String(v._id), v.count]));
    
    const enrichedShops = shops.map(shop => {
      const integrations: string[] = [];
      if (shop.protractor?.apiKey) integrations.push("Protractor");
      if (shop.tekmetric?.shopId) integrations.push("Tekmetric");
      if (shop.autoflow?.apiKey) integrations.push("AutoFlow");
      if (shop.carfax?.serviceId) integrations.push("CARFAX");
      if (shop.autovitals?.apiKey) integrations.push("AutoVitals");
      
      return {
        _id: shop._id,
        shopId: shop.shopId,
        name: shop.name || `Shop ${shop.shopId}`,
        createdAt: shop.createdAt || shop._id.getTimestamp?.() || new Date(),
        userCount: userCountMap.get(String(shop.shopId)) || 0,
        vehicleCount: vehicleCountMap.get(String(shop.shopId)) || 0,
        integrations,
      };
    });
    
    return NextResponse.json({
      ok: true,
      shops: enrichedShops.sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
    });
  } catch (err: any) {
    console.error("Platform shops error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
