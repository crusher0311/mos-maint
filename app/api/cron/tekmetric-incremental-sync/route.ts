import { NextRequest, NextResponse } from "next/server";
import { runIncrementalSyncCycle, ensureCacheIndexes } from "@/lib/tekmetric-incremental-sync";

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
