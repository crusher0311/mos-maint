import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  findAllShopmonkeyBackfillProgress,
  findShopmonkeyShopSummaries,
} from "@/lib/data/repositories/shopmonkey-ops";
import { computeStuckDiagnostics } from "../_shared";

// Shopmonkey slice of the sync-health payload (task #1030). Mirrors the
// Shop-Ware slice but is intentionally lighter: the Shopmonkey fleet is 0-1
// shops, so instead of chunk-speed/prewarm overlays we expose exactly what
// on-call needed and didn't have when a "connected but not syncing" shop was
// diagnosed by hand — backfill progress, last incremental sync, id-detection
// validation state, and how many order rows we actually hold.
export async function GET() {
  try {
    await requirePlatformAdmin();

    const [progress, shops] = await Promise.all([
      findAllShopmonkeyBackfillProgress(),
      findShopmonkeyShopSummaries(),
    ]);

    // The Shopmonkey progress doc uses `complete` (not `completed`) —
    // normalize so the shared renderer/diagnostics see the field they expect.
    const normalizedProgress = progress.map((p: any) => ({
      ...p,
      completed: !!(p.completed ?? p.complete),
      lastRunAt: p.lastRunAt ?? p.lastChunkAt ?? null,
    }));

    const complete = normalizedProgress.filter((p: any) => p.completed).length;
    const diagnostics = computeStuckDiagnostics(normalizedProgress);
    const stuck = diagnostics.filter((d: any) => d.stuck).length;

    return NextResponse.json({
      complete,
      total: normalizedProgress.length,
      stuck,
      progress: normalizedProgress.map((p: any) => ({
        shopId: p.shopId,
        completed: p.completed,
        totalJobsIndexed: p.totalJobsIndexed ?? null,
        chunksProcessed: p.chunksProcessed ?? null,
        lastRunAt: p.lastRunAt,
      })),
      diagnostics,
      backfillEnabled: process.env.SHOPMONKEY_BACKFILL_ENABLED === "true",
      // Connected-shop summaries: connection metadata + webhook/sync inflow,
      // so "Connected" on the Integrations page is verifiable here.
      shops,
    });
  } catch (error: any) {
    console.error("[Admin SyncHealth/Shopmonkey] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
