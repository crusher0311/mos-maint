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
    
    const [shops, platformSettings, enterprises] = await Promise.all([
      db.collection("shops").find().toArray(),
      db.collection("platform_settings").findOne({ key: "trial" }),
      db.collection("enterprise_accounts").find().toArray()
    ]);
    
    // Build enterprise lookup map
    const enterpriseMap = new Map(enterprises.map(e => [e._id.toString(), e]));
    
    const defaultVinLimit = platformSettings?.vinLimit ?? DEFAULT_TRIAL_VIN_LIMIT;
    const shopIds = shops.map(s => s.shopId);
    
    const allShopIdVariants = shopIds.flatMap(id => [id, String(id), Number(id)]).filter(id => id !== null && !isNaN(id as number));
    
    // Get first day of current month for monthly sticker counts
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    
    const [userCounts, vehicleCounts, vinViewCounts, backfillProgress, tekmetricBackfillProgress, jobHistoryCounts, jobIndexCounts, stickerCounts, stickerCountsThisMonth] = await Promise.all([
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
      ]).toArray(),
      db.collection("backfill_progress").find({ shopId: { $in: shopIds.map(Number) } }).toArray(),
      db.collection("tekmetric_backfill_progress").find({ shopId: { $in: shopIds.map(Number) } }).toArray(),
      db.collection("job_history").aggregate([
        { $match: { shopId: { $in: allShopIdVariants } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("job_index").aggregate([
        { $match: { shopId: { $in: allShopIdVariants } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("sticker_generations").aggregate([
        { $match: { shopId: { $in: allShopIdVariants } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("sticker_generations").aggregate([
        { $match: { shopId: { $in: allShopIdVariants }, generatedAt: { $gte: monthStart } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray()
    ]);
    
    const userCountMap = new Map(userCounts.map(u => [String(u._id), u.count]));
    const vinViewCountMap = new Map(vinViewCounts.map(v => [String(v._id), v.count]));
    const backfillMap = new Map(backfillProgress.map(b => [String(b.shopId), b]));
    const tekmetricBackfillMap = new Map(tekmetricBackfillProgress.map(b => [String(b.shopId), b]));
    
    const jobHistoryCountMap = new Map<string, number>();
    for (const j of jobHistoryCounts) {
      const key = String(j._id);
      jobHistoryCountMap.set(key, (jobHistoryCountMap.get(key) || 0) + j.count);
    }
    
    const jobIndexCountMap = new Map<string, number>();
    for (const j of jobIndexCounts) {
      const key = String(j._id);
      jobIndexCountMap.set(key, (jobIndexCountMap.get(key) || 0) + j.count);
    }
    
    const stickerCountMap = new Map<string, number>();
    for (const s of stickerCounts) {
      const key = String(s._id);
      stickerCountMap.set(key, (stickerCountMap.get(key) || 0) + s.count);
    }
    
    const stickerCountThisMonthMap = new Map<string, number>();
    for (const s of stickerCountsThisMonth) {
      const key = String(s._id);
      stickerCountThisMonthMap.set(key, (stickerCountThisMonthMap.get(key) || 0) + s.count);
    }
    
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
      
      const isPaid = shop.billing?.plan === "professional" || shop.billing?.plan === "enterprise" || shop.billing?.plan === "pro" || shop.billing?.plan === "demo";
      const vinLimit = shop.billing?.vinLimit ?? shop.trialVinLimit ?? defaultVinLimit;
      const vinViewCount = vinViewCountMap.get(String(shop.shopId)) || 0;
      const hasProtractor = !!(shop.protractor?.configured || shop.protractor?.apiKey || shop.protractorApiKey || shop.protractorConnectionId);
      const hasTekmetric = !!(shop.tekmetric?.shopId || shop.tekmetricShopId);
      const backfill = backfillMap.get(String(shop.shopId));
      const tekmetricBackfill = tekmetricBackfillMap.get(String(shop.shopId));
      const jobHistoryCount = jobHistoryCountMap.get(String(shop.shopId)) || 0;
      const jobIndexCount = jobIndexCountMap.get(String(shop.shopId)) || 0;
      
      const protractorLocation = shop.protractor?.locations?.[0];
      
      // Get enterprise info if this shop belongs to one
      const enterprise = shop.enterpriseId ? enterpriseMap.get(shop.enterpriseId.toString()) : null;
      
      return {
        _id: shop._id,
        shopId: shop.shopId,
        name: shop.name || `Shop ${shop.shopId}`,
        locationIdentifier: shop.locationIdentifier || null,
        enterpriseId: shop.enterpriseId?.toString() || null,
        enterpriseName: enterprise?.name || null,
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
        stickerCount: stickerCountMap.get(String(shop.shopId)) || 0,
        stickerCountThisMonth: stickerCountThisMonthMap.get(String(shop.shopId)) || 0,
        enabledFeatures: shop.enabledFeatures || {},
        backfill: (hasProtractor || hasTekmetric) ? {
          completed: hasProtractor 
            ? (backfill?.completed || false) 
            : (tekmetricBackfill?.completed === true),
          inProgress: hasProtractor
            ? (backfill && !backfill.completed)
            : (tekmetricBackfill && !tekmetricBackfill.completed),
          totalJobsIndexed: hasProtractor 
            ? (jobIndexCount || backfill?.totalJobsIndexed || 0) 
            : (jobIndexCount || tekmetricBackfill?.totalJobsIndexed || 0),
          currentChunkDate: hasProtractor 
            ? (backfill?.currentChunkEnd || backfill?.currentChunkStart || null)
            : (tekmetricBackfill?.currentChunkEnd || tekmetricBackfill?.currentChunkStart || null),
          source: hasProtractor ? "protractor" : "tekmetric",
        } : null,
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
