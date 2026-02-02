import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

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
    const [shops, platformSettingsResult, enterprises] = await Promise.all([
      sql`SELECT * FROM shops`,
      sql`SELECT * FROM platform_settings WHERE key = 'trial' LIMIT 1`,
      sql`SELECT * FROM enterprise_accounts`
    ]);
    
    const enterpriseMap = new Map(enterprises.map(e => [e.id, e]));
    const platformSettings = platformSettingsResult[0];
    const settingsValue = platformSettings?.value as Record<string, unknown> | null;
    const defaultVinLimit = (settingsValue?.vinLimit as number) ?? DEFAULT_TRIAL_VIN_LIMIT;
    
    const shopIds = shops.map(s => s.shop_id).filter(Boolean);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    
    const shopUuids = shops.map(s => s.id).filter(Boolean);
    
    const [userCounts, vehicleCounts, vinViewCounts, backfillProgress, tekmetricBackfillProgress, jobIndexCounts, stickerCounts, stickerCountsThisMonth] = await Promise.all([
      shopIds.length > 0 ? sql`SELECT shop_id, COUNT(*) as count FROM users WHERE shop_id = ANY(${shopIds}) GROUP BY shop_id` : Promise.resolve([]),
      shopUuids.length > 0 ? sql`SELECT shop_id, COUNT(*) as count FROM vehicles WHERE shop_id = ANY(${shopUuids}) GROUP BY shop_id` : Promise.resolve([]),
      shopUuids.length > 0 ? sql`SELECT shop_id, COUNT(*) as count FROM viewed_vins WHERE shop_id = ANY(${shopUuids}) GROUP BY shop_id` : Promise.resolve([]),
      shopIds.length > 0 ? sql`SELECT * FROM backfill_progress WHERE shop_id::text = ANY(${shopIds})` : Promise.resolve([]),
      shopIds.length > 0 ? sql`SELECT * FROM tekmetric_backfill_progress WHERE shop_id::text = ANY(${shopIds})` : Promise.resolve([]),
      shopUuids.length > 0 ? sql`SELECT shop_id, COUNT(*) as count FROM job_index WHERE shop_id = ANY(${shopUuids}) GROUP BY shop_id` : Promise.resolve([]),
      shopUuids.length > 0 ? sql`SELECT shop_id, COUNT(*) as count FROM sticker_generations WHERE shop_id = ANY(${shopUuids}) GROUP BY shop_id` : Promise.resolve([]),
      shopUuids.length > 0 ? sql`SELECT shop_id, COUNT(*) as count FROM sticker_generations WHERE shop_id = ANY(${shopUuids}) AND created_at >= ${monthStart} GROUP BY shop_id` : Promise.resolve([])
    ]);
    
    const userCountMap = new Map(userCounts.map(u => [String(u.shop_id), parseInt(u.count as string, 10)]));
    const vinViewCountMap = new Map(vinViewCounts.map(v => [String(v.shop_id), parseInt(v.count as string, 10)]));
    const backfillMap = new Map(backfillProgress.map(b => [String(b.shop_id), b]));
    const tekmetricBackfillMap = new Map(tekmetricBackfillProgress.map(b => [String(b.shop_id), b]));
    
    const vehicleCountMap = new Map<string, number>();
    for (const v of vehicleCounts) {
      vehicleCountMap.set(String(v.shop_id), parseInt(v.count as string, 10));
    }
    
    const jobIndexCountMap = new Map<string, number>();
    for (const j of jobIndexCounts) {
      jobIndexCountMap.set(String(j.shop_id), parseInt(j.count as string, 10));
    }
    
    const stickerCountMap = new Map<string, number>();
    for (const s of stickerCounts) {
      stickerCountMap.set(String(s.shop_id), parseInt(s.count as string, 10));
    }
    
    const stickerCountThisMonthMap = new Map<string, number>();
    for (const s of stickerCountsThisMonth) {
      stickerCountThisMonthMap.set(String(s.shop_id), parseInt(s.count as string, 10));
    }
    
    const enrichedShops = shops.map(shop => {
      const settings = shop.settings as Record<string, unknown> | null;
      const billing = shop.billing as Record<string, unknown> | null;
      const tekmetricConfig = shop.tekmetric as Record<string, unknown> | null;
      const protractorConfig = shop.protractor as Record<string, unknown> | null;
      const carfaxConfig = shop.carfax as Record<string, unknown> | null;
      const autoflowConfig = shop.autoflow as Record<string, unknown> | null;
      const autovitalsConfig = shop.autovitals as Record<string, unknown> | null;
      const enabledFeatures = settings?.enabledFeatures as Record<string, boolean> | null;
      const stickerConfig = shop.sticker_config as Record<string, unknown> | null;
      
      const integrations: string[] = [];
      if (protractorConfig?.configured || protractorConfig?.apiKey) integrations.push("Protractor");
      if (tekmetricConfig?.shopId) integrations.push("Tekmetric");
      if (autoflowConfig?.apiKey || autoflowConfig?.configured) integrations.push("AutoFlow");
      if (carfaxConfig?.locationId || carfaxConfig?.serviceId) integrations.push("CARFAX");
      if (autovitalsConfig?.apiKey || autovitalsConfig?.configured) integrations.push("AutoVitals");
      
      const isPaid = ["professional", "enterprise", "pro", "demo", "starter", "plus", "elite"].includes(billing?.plan as string || "");
      const vinLimit = (billing?.vinLimit as number) ?? (settings?.trialVinLimit as number) ?? defaultVinLimit;
      const vinViewCount = vinViewCountMap.get(String(shop.shop_id)) || 0;
      const hasProtractor = !!(protractorConfig?.configured || protractorConfig?.apiKey);
      const hasTekmetric = !!tekmetricConfig?.shopId;
      const backfill = backfillMap.get(String(shop.shop_id));
      const tekmetricBackfill = tekmetricBackfillMap.get(String(shop.shop_id));
      const jobIndexCount = jobIndexCountMap.get(shop.id) || 0;
      
      const protractorLocations = protractorConfig?.locations as Array<Record<string, unknown>> | null;
      const protractorLocation = protractorLocations?.[0];
      
      const enterprise = shop.enterprise_id ? enterpriseMap.get(shop.enterprise_id) : null;
      
      return {
        _id: shop.id,
        shopId: shop.shop_id ? parseInt(shop.shop_id, 10) : null,
        name: shop.name || `Shop ${shop.shop_id}`,
        locationIdentifier: shop.location_identifier || null,
        enterpriseId: shop.enterprise_id || null,
        enterpriseName: enterprise?.name || null,
        createdAt: shop.created_at || new Date(),
        userCount: userCountMap.get(String(shop.shop_id)) || 0,
        vehicleCount: vehicleCountMap.get(shop.id) || 0,
        integrations,
        isLocked: shop.is_locked || false,
        billing: {
          plan: billing?.plan || "trial",
          status: billing?.status || "trial",
          isPaid,
          vinLimit,
          vinViewCount,
        },
        stickerCount: stickerCountMap.get(shop.id) || 0,
        stickerCountThisMonth: stickerCountThisMonthMap.get(shop.id) || 0,
        stickerConfig: stickerConfig || {},
        enabledFeatures: enabledFeatures || {},
        backfill: (hasProtractor || hasTekmetric) ? (() => {
          const bf = hasProtractor ? backfill : tekmetricBackfill;
          const completed = bf?.completed || false;
          const inProgress = bf?.in_progress === true;
          const lastActivityAt = bf?.last_activity_at || bf?.last_attempted_at || null;
          const lastError = bf?.last_error || null;
          const lastErrorAt = bf?.last_error_at || null;
          
          const STALE_THRESHOLD_MS = 5 * 60 * 1000;
          const isStale = inProgress && lastActivityAt && 
            (Date.now() - new Date(lastActivityAt as string).getTime() > STALE_THRESHOLD_MS);
          
          let status: "completed" | "active" | "stale" | "error" | "pending" = "pending";
          if (completed) {
            status = "completed";
          } else if (lastError && lastErrorAt) {
            status = "error";
          } else if (isStale) {
            status = "stale";
          } else if (inProgress) {
            status = "active";
          }
          
          return {
            completed,
            inProgress,
            status,
            isStale,
            totalJobsIndexed: jobIndexCount || (bf?.total_jobs_indexed as number) || 0,
            currentChunkDate: bf?.current_chunk_end || bf?.current_chunk_start || null,
            source: hasProtractor ? "protractor" : "tekmetric",
            lastAttemptedAt: bf?.last_attempted_at || bf?.last_run_at || null,
            lastActivityAt,
            lastError,
            lastErrorAt,
            processedCount: bf?.processed_count || 0,
          };
        })() : null,
        integrationDetails: {
          protractor: protractorConfig?.configured ? {
            configuredAt: protractorConfig.configuredAt,
            locationName: (protractorLocation?.Name as string) || null,
            shortName: (protractorLocation?.ShortName as string) || null,
            address: protractorLocation?.Address ? (() => {
              const addr = protractorLocation.Address as Record<string, string>;
              return `${addr.Street}, ${addr.City}, ${addr.Province} ${addr.PostalCode}`;
            })() : null,
            phone: (protractorLocation?.PhoneNumber as string) || null,
            timeZone: (protractorLocation?.TimeZone as string) || null,
          } : null,
          carfax: carfaxConfig?.locationId ? {
            locationId: carfaxConfig.locationId,
          } : null,
          tekmetric: tekmetricConfig?.shopId ? {
            shopId: tekmetricConfig.shopId,
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Platform shops error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
