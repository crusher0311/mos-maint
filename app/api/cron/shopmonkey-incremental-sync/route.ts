import { NextRequest, NextResponse } from "next/server";
import { runIncrementalSyncCycle, getConfiguredShopmonkeyShops } from "@/lib/integrations/shopmonkey/incremental-sync";
import { runWithShopmonkeyBackoffTracking } from "@/lib/integrations/shopmonkey/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Shopmonkey incremental sync cron — mirror of
 * /api/cron/tekmetric-incremental-sync.
 *
 * PROD-SAFE: this is a no-op until a shop opts into Shopmonkey by setting
 * `shopmonkey.apiKey`. With zero configured shops (the current fleet state)
 * the cycle returns `{ ok: true, disabled: true }` and makes NO API calls and
 * NO writes. There is no auto-enrollment of the existing fleet.
 *
 * Auth: standard `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(req: NextRequest) {
  if (process.env.DISABLE_SHOPMONKEY_SYNC === "true") {
    return NextResponse.json({
      ok: true,
      message: "Shopmonkey sync disabled via DISABLE_SHOPMONKEY_SYNC environment variable",
      disabled: true,
    });
  }

  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shops = await getConfiguredShopmonkeyShops();
  if (shops.length === 0) {
    return NextResponse.json({
      ok: true,
      disabled: true,
      message: "No Shopmonkey shops configured — incremental sync is a no-op",
      shopsConsidered: 0,
    });
  }

  return runWithShopmonkeyBackoffTracking(async (backoff) => {
    try {
      const start = Date.now();
      const result = await runIncrementalSyncCycle();
      const duration = Date.now() - start;

      console.log(
        `[Cron] Shopmonkey incremental sync completed in ${duration}ms (backoff ${backoff.ms}ms): ${result.shopsSynced}/${result.shopsConsidered} synced, ${result.totalRecords} records`,
      );

      return NextResponse.json({
        ok: true,
        duration: `${duration}ms`,
        rateLimitBackoffMs: backoff.ms,
        summary: {
          shopsConsidered: result.shopsConsidered,
          shopsSynced: result.shopsSynced,
          totalRecords: result.totalRecords,
        },
        shops: result.perShop,
      });
    } catch (err: any) {
      console.error(`[Cron] Shopmonkey incremental sync error:`, err);
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  });
}
