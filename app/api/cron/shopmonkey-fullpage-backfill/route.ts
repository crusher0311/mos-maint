import { NextRequest, NextResponse } from "next/server";
import { runFullPageBackfillCycle } from "@/lib/integrations/shopmonkey/full-page-backfill";
import { getConfiguredShopmonkeyShops } from "@/lib/integrations/shopmonkey/incremental-sync";
import { runWithShopmonkeyBackoffTracking } from "@/lib/integrations/shopmonkey/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Shopmonkey full-page backfill cron — mirror of
 * /api/cron/tekmetric-fullpage-backfill.
 *
 * PROD-SAFE: gated behind both an explicit opt-in flag AND per-shop config.
 * With zero Shopmonkey shops configured (current fleet state) it is a no-op.
 * Even when a shop IS configured, the backfill only runs when
 * `SHOPMONKEY_BACKFILL_ENABLED=true` so connecting a shop never silently kicks
 * off a fleet-scale history pull. There is NO migration of existing shops.
 *
 * Auth: standard `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (process.env.SHOPMONKEY_BACKFILL_ENABLED !== "true") {
    return NextResponse.json({
      ok: true,
      disabled: true,
      message: "Shopmonkey backfill disabled — set SHOPMONKEY_BACKFILL_ENABLED=true to enable",
    });
  }

  const shops = await getConfiguredShopmonkeyShops();
  if (shops.length === 0) {
    return NextResponse.json({
      ok: true,
      disabled: true,
      message: "No Shopmonkey shops configured — backfill is a no-op",
      shopsConsidered: 0,
    });
  }

  return runWithShopmonkeyBackoffTracking(async (backoff) => {
    try {
      const start = Date.now();
      const { shopsConsidered, results } = await runFullPageBackfillCycle();
      const duration = Date.now() - start;

      const ran = results.filter((r) => r.ran).length;
      const busy = results.filter((r) => r.busy).length;
      const totalJobs = results.reduce((sum, r) => sum + (r.totalJobsIndexed || 0), 0);

      console.log(
        `[Cron] Shopmonkey full-page backfill completed in ${duration}ms (backoff ${backoff.ms}ms): ${ran}/${shopsConsidered} ran, ${busy} busy, ${totalJobs} jobs indexed`,
      );

      return NextResponse.json({
        ok: true,
        duration: `${duration}ms`,
        rateLimitBackoffMs: backoff.ms,
        summary: { shopsConsidered, ran, busy, totalJobsIndexed: totalJobs },
        shops: results,
      });
    } catch (err: any) {
      console.error(`[Cron] Shopmonkey full-page backfill error:`, err);
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  });
}
