import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  buildChunkSpeed,
  computeStuckDiagnostics,
  loadChunkSpeedAlertsByKey,
  SLOW_P95_THRESHOLD_MS,
} from "../_shared";

// Shop-Ware slice of the sync-health payload. See
// `app/api/admin/sync-health/_shared.ts` for the rationale behind splitting
// the original monolithic endpoint (task #288).
export async function GET() {
  try {
    await requirePlatformAdmin();

    const db = await getDb();

    const [
      shopwareBackfillProgress,
      shopwareShopDocs,
      chunkSpeedAlertsByKey,
    ] = await Promise.all([
      db.collection("shopware_backfill_progress").find({}).toArray(),
      // Per-shop Shop-Ware jobs-cache pre-warm overlay (task #72). Stamped
      // by lib/shopware-jobs-prewarm.ts on `shops.shopware.jobsCachePrewarm`.
      db.collection("shops").find(
        { "shopware.tenantId": { $exists: true, $ne: null } },
        {
          projection: {
            shopId: 1,
            "shopware.tenantId": 1,
            "shopware.swShopId": 1,
            "shopware.jobsCachePrewarm": 1,
            _id: 0,
          },
        },
      ).toArray(),
      loadChunkSpeedAlertsByKey(db),
    ]);

    const shopwareShopsComplete = shopwareBackfillProgress.filter((p: any) => p.completed).length;
    const shopwareShopsTotal = shopwareBackfillProgress.length;

    const shopwareDiagnostics = computeStuckDiagnostics(shopwareBackfillProgress);
    const shopwareStuckCount = shopwareDiagnostics.filter((d: any) => d.stuck).length;

    const { rows: shopwareChunkSpeed, slowChunkShopCount: shopwareSlowChunkShopCount } =
      buildChunkSpeed("shopware", shopwareBackfillProgress, chunkSpeedAlertsByKey);

    // Shop-Ware prewarm overlay (task #72). The SW prewarm result has a
    // different shape than Tekmetric's (no terminal-RO breakdown, but has
    // jobs-indexed/jobs-skipped + cursor-advanced status), so we map it
    // onto the same `JobsCachePrewarmShop` view-model the renderer uses:
    //   - rosCached  ← rosStored        (ROs upserted into shopware_repair_orders)
    //   - jobsCached ← jobsIndexed      (job_index rows written)
    //   - alreadyCached ← jobsSkipped   (job_index rows skipped via contentHash)
    //   - terminalRosFound / rosScanned ← rosFetched
    // This keeps the table columns ("ROs cached", "Jobs cached", "Already
    // cached") meaningful for both providers without forking the renderer.
    const shopwarePrewarmByShopId = new Map<string, any>();
    for (const s of shopwareShopDocs as any[]) {
      shopwarePrewarmByShopId.set(String(s.shopId), {
        tenantId: s?.shopware?.tenantId ?? null,
        swShopId: s?.shopware?.swShopId ?? null,
        record: s?.shopware?.jobsCachePrewarm || null,
      });
    }
    const shopwareJobsCachePrewarm = shopwareBackfillProgress
      .map((p: any) => {
        const entry = shopwarePrewarmByShopId.get(String(p.shopId));
        const record = entry?.record || null;
        return {
          shopId: p.shopId,
          // We don't have an external "tekmetricShopId" equivalent here;
          // expose the SW tenant + shop ids the prewarm worker needs in
          // case the UI ever wants to surface them.
          shopwareTenantId: entry?.tenantId ?? null,
          shopwareShopId: entry?.swShopId ?? null,
          completed: !!p.completed,
          hasPrewarmRecord: !!record,
          completedAt: record?.completedAt || null,
          lookbackDays: record?.lookbackDays ?? null,
          rosScanned: record?.rosFetched ?? null,
          terminalRosFound: record?.rosFetched ?? null,
          alreadyCached: record?.jobsSkipped ?? null,
          rosCached: record?.rosStored ?? null,
          jobsCached: record?.jobsIndexed ?? null,
          errors: record?.errors ?? null,
          capped: !!record?.capped,
          durationMs: record?.durationMs ?? null,
        };
      })
      .sort((a: any, b: any) => {
        if (a.hasPrewarmRecord !== b.hasPrewarmRecord) {
          return a.hasPrewarmRecord ? 1 : -1;
        }
        const aProblem = (a.capped ? 1 : 0) + ((a.errors || 0) > 0 ? 1 : 0);
        const bProblem = (b.capped ? 1 : 0) + ((b.errors || 0) > 0 ? 1 : 0);
        if (aProblem !== bProblem) return bProblem - aProblem;
        const aAt = a.completedAt ? new Date(a.completedAt).getTime() : 0;
        const bAt = b.completedAt ? new Date(b.completedAt).getTime() : 0;
        return bAt - aAt;
      });
    const shopwareJobsCachePrewarmMissingCount = shopwareJobsCachePrewarm
      .filter((p: any) => !p.hasPrewarmRecord).length;
    const shopwareJobsCachePrewarmCappedCount = shopwareJobsCachePrewarm
      .filter((p: any) => p.capped).length;
    const shopwareJobsCachePrewarmErrorsCount = shopwareJobsCachePrewarm
      .filter((p: any) => (p.errors ?? 0) > 0).length;

    return NextResponse.json({
      complete: shopwareShopsComplete,
      total: shopwareShopsTotal,
      stuck: shopwareStuckCount,
      progress: shopwareBackfillProgress.map((p: any) => ({
        shopId: p.shopId,
        completed: p.completed,
        currentChunkEnd: p.currentChunkEnd,
        totalJobsIndexed: p.totalJobsIndexed,
        lastRunAt: p.lastRunAt,
      })),
      diagnostics: shopwareDiagnostics,
      chunkSpeed: shopwareChunkSpeed,
      chunkSpeedShopCount: shopwareChunkSpeed.length,
      slowChunkShopCount: shopwareSlowChunkShopCount,
      slowChunkP95ThresholdMs: SLOW_P95_THRESHOLD_MS,
      // Per-shop jobs-cache pre-warm status (task #72). Mirror of
      // Tekmetric's. `jobsCachePrewarmMissingCount` is the headline —
      // a non-zero value means there are legacy Shop-Ware shops
      // onboarded before pre-warm shipped that could be one-shot
      // bulk-warmed via /api/platform-admin/shopware-rewarm-jobs-cache-all.
      jobsCachePrewarm: shopwareJobsCachePrewarm,
      jobsCachePrewarmShopCount: shopwareJobsCachePrewarm.length,
      jobsCachePrewarmMissingCount: shopwareJobsCachePrewarmMissingCount,
      jobsCachePrewarmCappedCount: shopwareJobsCachePrewarmCappedCount,
      jobsCachePrewarmErrorsCount: shopwareJobsCachePrewarmErrorsCount,
    });
  } catch (error: any) {
    console.error("[Admin SyncHealth/Shopware] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
