import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import bcrypt from "bcryptjs";

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
      if (shop.shopware?.tenantId) integrations.push("Shop-Ware");
      
      const isPaid = shop.billing?.plan === "professional" || shop.billing?.plan === "enterprise" || shop.billing?.plan === "pro" || shop.billing?.plan === "demo";
      const vinLimit = shop.billing?.vinLimit ?? shop.trialVinLimit ?? defaultVinLimit;
      const vinViewCount = vinViewCountMap.get(String(shop.shopId)) || 0;
      const hasProtractor = !!(shop.protractor?.configured || shop.protractor?.apiKey || shop.protractorApiKey || shop.protractorConnectionId);
      const hasTekmetric = !!(shop.tekmetric?.shopId || shop.tekmetricShopId);
      const activeIntegration = shop.integrationProvider === "tekmetric" ? "tekmetric" 
        : shop.integrationProvider === "protractor" ? "protractor"
        : hasTekmetric ? "tekmetric" : hasProtractor ? "protractor" : null;
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
        stickerConfig: shop.stickerConfig || {},
        enabledFeatures: shop.enabledFeatures || {},
        backfill: activeIntegration ? (() => {
          const bf = activeIntegration === "protractor" ? backfill : tekmetricBackfill;
          const completed = bf?.completed || false;
          const inProgress = bf?.inProgress === true;
          const lastActivityAt = bf?.lastActivityAt || bf?.lastAttemptedAt || bf?.lastRunAt || null;
          const lastError = bf?.lastError || null;
          const lastErrorAt = bf?.lastErrorAt || null;
          
          const STALE_THRESHOLD_MS = 10 * 60 * 1000;
          const lastActiveTime = lastActivityAt ? new Date(lastActivityAt).getTime() : 0;
          
          const tekLastRun = bf?.lastRunAt ? new Date(bf.lastRunAt).getTime() : 0;
          const tekQueued = bf?.queuedAt ? new Date(bf.queuedAt).getTime() : 0;
          const tekMostRecent = Math.max(tekLastRun, tekQueued);
          
          const isTekmetricActive = activeIntegration === "tekmetric" && !completed && 
            tekMostRecent > 0 && (Date.now() - tekMostRecent < STALE_THRESHOLD_MS);
          
          const isStale = !completed && !isTekmetricActive && (
            (activeIntegration === "protractor" && inProgress && lastActiveTime && (Date.now() - lastActiveTime > STALE_THRESHOLD_MS)) ||
            (activeIntegration === "tekmetric" && tekMostRecent > 0 && (Date.now() - tekMostRecent > STALE_THRESHOLD_MS))
          );
          
          let status: "completed" | "active" | "stale" | "error" | "pending" = "pending";
          if (completed) {
            status = "completed";
          } else if (lastError && lastErrorAt) {
            status = "error";
          } else if (inProgress || isTekmetricActive) {
            status = "active";
          } else if (isStale) {
            status = "stale";
          } else if (bf?.queuedAt || bf?.currentChunkEnd) {
            status = "active";
          }
          
          return {
            completed,
            inProgress: inProgress || isTekmetricActive || false,
            status,
            isStale,
            totalJobsIndexed: jobIndexCount || bf?.totalJobsIndexed || 0,
            currentChunkDate: bf?.currentChunkEnd || bf?.currentChunkStart || null,
            source: activeIntegration,
            lastAttemptedAt: bf?.lastAttemptedAt || bf?.lastRunAt || null,
            lastActivityAt: lastActivityAt || bf?.lastRunAt || null,
            lastError,
            lastErrorAt,
            processedCount: bf?.processedCount || 0,
          };
        })() : null,
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

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { shopName, ownerEmail, ownerPassword, ownerName, plan, status, vinLimit, features } = body;

    if (!shopName || !ownerEmail || !ownerPassword) {
      return NextResponse.json({ error: "Shop name, owner email, and password are required" }, { status: 400 });
    }

    const db = await getDb();

    const existingUser = await db.collection("users").findOne({ email: ownerEmail.toLowerCase().trim() });
    if (existingUser) {
      return NextResponse.json({ error: "A user with this email already exists" }, { status: 409 });
    }

    const counter = await db.collection("counters").findOneAndUpdate(
      { _id: "shopId" as any },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" }
    );
    let newShopId = counter?.seq || counter?.value?.seq;
    if (!newShopId || newShopId < 1001) {
      const lastShop = await db.collection("shops")
        .find({}, { projection: { shopId: 1 } })
        .sort({ shopId: -1 })
        .limit(1)
        .toArray();
      const maxId = (lastShop.length > 0 && typeof lastShop[0].shopId === 'number') 
        ? lastShop[0].shopId : 1000;
      newShopId = maxId + 1;
      await db.collection("counters").updateOne(
        { _id: "shopId" as any },
        { $set: { seq: newShopId } },
        { upsert: true }
      );
    }

    const now = new Date();
    const shopDoc = {
      shopId: newShopId,
      name: shopName.trim(),
      billing: {
        plan: plan || "trial",
        status: status || "trial",
      },
      trialVinLimit: vinLimit ? Number(vinLimit) : 10,
      enabledFeatures: features || { maintenance: true },
      createdAt: now,
      updatedAt: now,
      createdBy: session.email,
    };

    await db.collection("shops").insertOne(shopDoc);

    const hashedPassword = await bcrypt.hash(ownerPassword, 12);
    const userDoc = {
      email: ownerEmail.toLowerCase().trim(),
      passwordHash: hashedPassword,
      name: ownerName?.trim() || ownerEmail.split("@")[0],
      shopId: newShopId,
      role: "admin",
      createdAt: now,
      updatedAt: now,
    };

    await db.collection("users").insertOne(userDoc);

    await db.collection("audit_logs").insertOne({
      type: "shop_created",
      shopId: newShopId,
      shopName: shopName.trim(),
      ownerEmail: ownerEmail.toLowerCase().trim(),
      plan: plan || "trial",
      adminEmail: session.email,
      createdAt: now,
    });

    return NextResponse.json({ 
      ok: true, 
      shop: { shopId: newShopId, name: shopName.trim() },
      message: `Shop "${shopName.trim()}" created with ID ${newShopId}`
    });
  } catch (err: any) {
    console.error("Create shop error:", err);
    return NextResponse.json({ error: err?.message || "Failed to create shop" }, { status: 500 });
  }
}
