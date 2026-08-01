import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requirePlatformAdmin } from "@/lib/auth";
import { findAllProgress as findAllBackfillProgress } from "@/lib/data/repositories/protractor-backfill-progress";
import {
  buildChunkSpeed,
  computeStuckDiagnostics,
  loadChunkSpeedAlertsByKey,
  SLOW_P95_THRESHOLD_MS,
} from "../_shared";

// Protractor slice of the sync-health payload. See
// `app/api/admin/sync-health/_shared.ts` for the rationale behind splitting
// the original monolithic endpoint (task #288).
export async function GET() {
  try {
    await requirePlatformAdmin();

    const db = await getDb();

    const [
      protractorBackfillProgress,
      protractorShopDocs,
      chunkSpeedAlertsByKey,
    ] = await Promise.all([
      findAllBackfillProgress(),
      // Per-shop Protractor invoice-cache pre-warm overlay. Stamped by
      // lib/protractor-jobs-prewarm.ts at onboarding under
      // `shops.protractor.invoiceCachePrewarm`. Restricted to shops with
      // a configured Protractor connection so we don't join against the
      // entire shops collection.
      db.collection("shops").find(
        { "protractor.configured": true },
        {
          projection: {
            shopId: 1,
            "protractor.connectionId": 1,
            "protractor.invoiceCachePrewarm": 1,
            _id: 0,
          },
        },
      ).toArray(),
      loadChunkSpeedAlertsByKey(db),
    ]);

    const protractorShopsComplete = protractorBackfillProgress.filter((p: any) => p.completed).length;
    const protractorShopsTotal = protractorBackfillProgress.length;

    const protractorDiagnostics = computeStuckDiagnostics(protractorBackfillProgress);
    const protractorStuckCount = protractorDiagnostics.filter((d: any) => d.stuck).length;

    const { rows: protractorChunkSpeed, slowChunkShopCount: protractorSlowChunkShopCount } =
      buildChunkSpeed("protractor", protractorBackfillProgress, chunkSpeedAlertsByKey);

    // Per-shop Protractor invoice-cache prewarm overlay. Same join-by-shopId
    // logic as the Tekmetric overlay. The prewarm record's shape is defined
    // by `PrewarmProtractorJobsCacheResult` in lib/protractor-jobs-prewarm.ts
    // (`invoicesScanned`, `invoicesCached`, `alreadyCached`, `errors`,
    // `capped`, etc.).
    const protractorPrewarmByShopId = new Map<string, any>();
    for (const s of protractorShopDocs as any[]) {
      protractorPrewarmByShopId.set(String(s.shopId), {
        connectionId: s?.protractor?.connectionId ?? null,
        record: s?.protractor?.invoiceCachePrewarm || null,
      });
    }
    const protractorInvoiceCachePrewarm = protractorBackfillProgress
      .map((p: any) => {
        const entry = protractorPrewarmByShopId.get(String(p.shopId));
        const record = entry?.record || null;
        return {
          shopId: p.shopId,
          connectionId: entry?.connectionId ?? null,
          completed: !!p.completed,
          // `hasPrewarmRecord: false` is the actionable "this shop was
          // onboarded before the Protractor prewarm rolled out" signal.
          hasPrewarmRecord: !!record,
          completedAt: record?.completedAt || null,
          lookbackDays: record?.lookbackDays ?? null,
          invoicesScanned: record?.invoicesScanned ?? null,
          alreadyCached: record?.alreadyCached ?? null,
          invoicesCached: record?.invoicesCached ?? null,
          errors: record?.errors ?? null,
          capped: !!record?.capped,
          durationMs: record?.durationMs ?? null,
        };
      })
      // Same sort priority as the Tekmetric overlay: never-warmed first,
      // then capped/errored, then most-recent prewarm.
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
    const protractorInvoiceCachePrewarmMissingCount = protractorInvoiceCachePrewarm
      .filter((p: any) => !p.hasPrewarmRecord).length;
    const protractorInvoiceCachePrewarmCappedCount = protractorInvoiceCachePrewarm
      .filter((p: any) => p.capped).length;
    const protractorInvoiceCachePrewarmErrorsCount = protractorInvoiceCachePrewarm
      .filter((p: any) => (p.errors ?? 0) > 0).length;

    return NextResponse.json({
      complete: protractorShopsComplete,
      total: protractorShopsTotal,
      stuck: protractorStuckCount,
      progress: protractorBackfillProgress.map((p: any) => ({
        shopId: p.shopId,
        completed: p.completed,
        currentChunkEnd: p.currentChunkEnd,
        totalJobsIndexed: p.totalJobsIndexed,
        lastRunAt: p.lastRunAt,
      })),
      diagnostics: protractorDiagnostics,
      chunkSpeed: protractorChunkSpeed,
      chunkSpeedShopCount: protractorChunkSpeed.length,
      slowChunkShopCount: protractorSlowChunkShopCount,
      slowChunkP95ThresholdMs: SLOW_P95_THRESHOLD_MS,
      // Per-shop Protractor invoice-cache pre-warm status
      // (lib/protractor-jobs-prewarm.ts). NOTE: since the bulk-fetch
      // rewrite the backfill extracts line items straight from the
      // `/Invoice/` list, so the "Jobs cache" column on the Protractor
      // chunk-speed table now reflects the list-extraction rate
      // (invoices served without a `/Invoice/{id}` detail fallback — see
      // `buildProtractorChunkMetrics`), NOT this prewarm cache's hit
      // rate. The prewarm now only accelerates the rare detail-on-mismatch
      // fallback; this overlay still shows which shops were warmed at
      // onboarding.
      invoiceCachePrewarm: protractorInvoiceCachePrewarm,
      invoiceCachePrewarmShopCount: protractorInvoiceCachePrewarm.length,
      invoiceCachePrewarmMissingCount: protractorInvoiceCachePrewarmMissingCount,
      invoiceCachePrewarmCappedCount: protractorInvoiceCachePrewarmCappedCount,
      invoiceCachePrewarmErrorsCount: protractorInvoiceCachePrewarmErrorsCount,
    });
  } catch (error: any) {
    console.error("[Admin SyncHealth/Protractor] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
