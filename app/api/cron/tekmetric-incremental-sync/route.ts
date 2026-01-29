import { NextRequest, NextResponse } from "next/server";
import { runIncrementalSyncCycle, ensureCacheIndexes } from "@/lib/tekmetric-incremental-sync";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(req: NextRequest) {
  // Check if sync is disabled for this deployment
  if (process.env.DISABLE_TEKMETRIC_SYNC === "true") {
    return NextResponse.json({
      ok: true,
      message: "Tekmetric sync disabled via DISABLE_TEKMETRIC_SYNC environment variable",
      disabled: true
    });
  }

  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await ensureCacheIndexes();
    
    const { results, duration } = await runIncrementalSyncCycle();
    
    const totalSynced = results.reduce((sum, r) => sum + r.synced, 0);
    const totalRemoved = results.reduce((sum, r) => sum + r.removed, 0);
    const totalFromCacheVehicles = results.reduce((sum, r) => sum + r.fromCache.vehicles, 0);
    const totalFromCacheCustomers = results.reduce((sum, r) => sum + r.fromCache.customers, 0);
    const totalPagesQueued = results.reduce((sum, r) => sum + r.pagesQueued, 0);
    const errors = results.filter(r => r.error).length;
    const skipped = results.filter(r => r.skipped).length;
    
    console.log(`[Cron] Tekmetric incremental sync completed in ${duration}ms: ${totalSynced} synced, ${totalRemoved} removed, ${totalFromCacheVehicles}/${totalFromCacheCustomers} from cache, ${totalPagesQueued} pages queued, ${errors} errors, ${skipped} skipped`);

    // Fire-and-forget plan pre-generation for ALL dashboard-visible vehicles
    if (CRON_SECRET) {
      try {
        const baseUrl = process.env.RENDER_EXTERNAL_URL 
          || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null)
          || `http://localhost:${process.env.PORT || 5000}`;
        
        const db = await getDb();
        
        // Get all Tekmetric shops - use tekmetric.shopId as the shop identifier
        const tekmetricShops = await db.collection("shops")
          .find({ "tekmetric.shopId": { $exists: true, $ne: null } })
          .project({ _id: 0, shopId: 1, tekmetric: 1 })
          .toArray();
        
        console.log(`[Cron] Found ${tekmetricShops.length} Tekmetric shops for pregeneration`);
        
        let triggeredCount = 0;
        for (const shop of tekmetricShops) {
          // Use internal shop.shopId (NOT tekmetric.shopId) since work orders are stored with internal ID
          const internalShopId = shop.shopId;
          const tekmetricShopId = shop.tekmetric?.shopId;
          if (!internalShopId) continue;
          
          // Get top 50 vehicles by most recent work order (dashboard order)
          // Tekmetric work orders are stored with internal shopId (not tekmetric shopId)
          
          // Debug: count work orders for this shop
          const woCount = await db.collection("tekmetric_work_orders").countDocuments({
            shopId: { $in: [internalShopId, String(internalShopId), Number(internalShopId)] }
          });
          console.log(`[Cron] Shop ${internalShopId} (tek: ${tekmetricShopId}): Found ${woCount} work orders in tekmetric_work_orders`);
          
          const recentVehicles = await db.collection("tekmetric_work_orders")
            .aggregate([
              { $match: { shopId: { $in: [internalShopId, String(internalShopId), Number(internalShopId)] } } },
              { $sort: { fetchedAt: -1 } },
              { $group: { _id: "$vin", lastUpdated: { $first: "$fetchedAt" } } },
              { $sort: { lastUpdated: -1 } },
              { $limit: 50 },
            ])
            .toArray();
          
          console.log(`[Cron] Shop ${internalShopId}: Aggregated ${recentVehicles.length} unique VINs`);
          
          const vins = recentVehicles
            .map((v: any) => v._id as string)
            .filter((v: string) => v && typeof v === 'string' && v.length === 17);
          
          console.log(`[Cron] Shop ${internalShopId}: ${vins.length} valid VINs after filter`);
          
          if (vins.length > 0) {
            triggeredCount++;
            fetch(`${baseUrl}/api/internal/plan-pregenerate`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CRON_SECRET}`,
              },
              body: JSON.stringify({ shopId: internalShopId, vins }),
            }).catch(err => console.log(`[Cron] Plan pregenerate failed for shop ${internalShopId}:`, err.message));
          }
        }
        console.log(`[Cron] Triggered plan pre-generation for ${triggeredCount}/${tekmetricShops.length} Tekmetric shops with vehicles`);
      } catch (pregenerateErr: any) {
        console.error(`[Cron] Tekmetric pregenerate error:`, pregenerateErr.message);
      }
    }

    return NextResponse.json({
      ok: true,
      duration: `${duration}ms`,
      summary: {
        totalShops: results.length,
        totalSynced,
        totalRemoved,
        fromCache: {
          vehicles: totalFromCacheVehicles,
          customers: totalFromCacheCustomers,
        },
        pagesQueued: totalPagesQueued,
        errors,
        skipped,
      },
      shops: results
    });
  } catch (err: any) {
    console.error("[Cron] Tekmetric incremental sync error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
