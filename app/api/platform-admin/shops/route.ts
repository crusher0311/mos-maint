import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_TRIAL_VIN_LIMIT = 10;

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
    
    const [shops, platformSettings] = await Promise.all([
      db.collection("shops").find().toArray(),
      db.collection("platform_settings").findOne({ key: "trial" })
    ]);
    
    const defaultVinLimit = platformSettings?.vinLimit ?? DEFAULT_TRIAL_VIN_LIMIT;
    const shopIds = shops.map(s => s.shopId);
    
    const allShopIdVariants = shopIds.flatMap(id => [id, String(id), Number(id)]).filter(id => id !== null && !isNaN(id as number));
    
    const [userCounts, vehicleCounts, vinViewCounts] = await Promise.all([
      db.collection("users").aggregate([
        { $match: { shopId: { $in: shopIds } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("vehicles").aggregate([
        { $match: { shopId: { $in: allShopIdVariants } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("viewed_vins").aggregate([
        { $match: { shopId: { $in: shopIds } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray()
    ]);
    
    const userCountMap = new Map(userCounts.map(u => [String(u._id), u.count]));
    const vinViewCountMap = new Map(vinViewCounts.map(v => [String(v._id), v.count]));
    
    const vehicleCountMap = new Map<string, number>();
    for (const v of vehicleCounts) {
      const key = String(v._id);
      vehicleCountMap.set(key, (vehicleCountMap.get(key) || 0) + v.count);
    }
    
    const enrichedShops = shops.map(shop => {
      const integrations: string[] = [];
      if (shop.protractor?.configured || shop.protractor?.apiKey || shop.protractorApiKey || shop.protractorConnectionId) integrations.push("Protractor");
      if (shop.tekmetric?.shopId || shop.tekmetricShopId) integrations.push("Tekmetric");
      if (shop.autoflow?.apiKey || shop.autoflow?.configured || shop.autoflowApiKey) integrations.push("AutoFlow");
      if (shop.carfax?.locationId || shop.carfax?.serviceId || shop.carfaxLocationId) integrations.push("CARFAX");
      if (shop.autovitals?.apiKey || shop.autovitals?.configured || shop.autovitalsApiKey) integrations.push("AutoVitals");
      
      const isPaid = shop.billing?.plan === "professional" || shop.billing?.plan === "enterprise";
      const vinLimit = shop.trialVinLimit ?? defaultVinLimit;
      const vinViewCount = vinViewCountMap.get(String(shop.shopId)) || 0;
      
      const protractorLocation = shop.protractor?.locations?.[0];
      
      return {
        _id: shop._id,
        shopId: shop.shopId,
        name: shop.name || `Shop ${shop.shopId}`,
        createdAt: shop.createdAt || shop._id.getTimestamp?.() || new Date(),
        userCount: userCountMap.get(String(shop.shopId)) || 0,
        vehicleCount: vehicleCountMap.get(String(shop.shopId)) || 0,
        integrations,
        isLocked: shop.isLocked || false,
        billing: {
          plan: shop.billing?.plan || "trial",
          status: shop.billing?.status || "trial",
          isPaid,
          vinLimit,
          vinViewCount,
        },
        enabledFeatures: shop.enabledFeatures || {},
        integrationDetails: {
          protractor: shop.protractor?.configured ? {
            configuredAt: shop.protractor.configuredAt,
            locationName: protractorLocation?.Name || null,
            shortName: protractorLocation?.ShortName || null,
            address: protractorLocation?.Address ? 
              `${protractorLocation.Address.Street}, ${protractorLocation.Address.City}, ${protractorLocation.Address.Province} ${protractorLocation.Address.PostalCode}` : null,
            phone: protractorLocation?.PhoneNumber || null,
            timeZone: protractorLocation?.TimeZone || null,
          } : null,
          carfax: shop.carfax?.locationId ? {
            locationId: shop.carfax.locationId,
          } : null,
          tekmetric: shop.tekmetric?.shopId ? {
            shopId: shop.tekmetric.shopId,
          } : null,
        },
      };
    });
    
    return NextResponse.json({
      ok: true,
      shops: enrichedShops.sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
      defaultVinLimit,
    });
  } catch (err: any) {
    console.error("Platform shops error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
