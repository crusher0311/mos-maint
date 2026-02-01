import { NextRequest, NextResponse } from "next/server";
import { runIncrementalSyncCycle } from "@/lib/tekmetric-incremental-sync";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(req: NextRequest) {
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
    const { results, duration } = await runIncrementalSyncCycle();
    
    const totalSynced = results.reduce((sum, r) => sum + r.synced, 0);
    const totalRemoved = results.reduce((sum, r) => sum + r.removed, 0);
    const totalFromCacheVehicles = results.reduce((sum, r) => sum + r.fromCache.vehicles, 0);
    const totalFromCacheCustomers = results.reduce((sum, r) => sum + r.fromCache.customers, 0);
    const totalPagesQueued = results.reduce((sum, r) => sum + r.pagesQueued, 0);
    const errors = results.filter(r => r.error).length;
    const skipped = results.filter(r => r.skipped).length;
    
    console.log(`[Cron] Tekmetric incremental sync completed in ${duration}ms: ${totalSynced} synced, ${totalRemoved} removed, ${totalFromCacheVehicles}/${totalFromCacheCustomers} from cache, ${totalPagesQueued} pages queued, ${errors} errors, ${skipped} skipped`);

    if (CRON_SECRET) {
      try {
        const baseUrl = process.env.RENDER_EXTERNAL_URL 
          || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null)
          || `http://localhost:${process.env.PORT || 5000}`;
        
        const tekmetricShops = await sql`
          SELECT shop_id, tekmetric FROM shops
          WHERE tekmetric->>'shopId' IS NOT NULL
        `;
        
        console.log(`[Cron] Found ${tekmetricShops.length} Tekmetric shops for pregeneration`);
        
        let triggeredCount = 0;
        for (const shop of tekmetricShops as any[]) {
          const internalShopId = shop.shop_id;
          const tekmetricShopId = shop.tekmetric?.shopId;
          if (!internalShopId) continue;
          
          const woCountRows = await sql`
            SELECT COUNT(*) as count FROM tekmetric_work_orders WHERE shop_id = ${String(internalShopId)}
          `;
          const woCount = parseInt((woCountRows[0] as any)?.count || '0', 10);
          console.log(`[Cron] Shop ${internalShopId} (tek: ${tekmetricShopId}): Found ${woCount} work orders in tekmetric_work_orders`);
          
          const recentVehicles = await sql`
            SELECT vin, MAX(fetched_at) as last_updated
            FROM tekmetric_work_orders
            WHERE shop_id = ${String(internalShopId)}
            GROUP BY vin
            ORDER BY last_updated DESC NULLS LAST
            LIMIT 50
          `;
          
          console.log(`[Cron] Shop ${internalShopId}: Aggregated ${recentVehicles.length} unique VINs`);
          
          const vins = (recentVehicles as any[])
            .map((v: any) => v.vin as string)
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
