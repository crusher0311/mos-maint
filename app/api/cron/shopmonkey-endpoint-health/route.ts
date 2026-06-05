import { NextRequest, NextResponse } from "next/server";
import { getConfiguredShopmonkeyShops } from "@/lib/integrations/shopmonkey/incremental-sync";
import { testConnection } from "@/lib/integrations/shopmonkey/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Shopmonkey endpoint health cron — mirror of
 * /api/cron/tekmetric-endpoint-health.
 *
 * For each configured Shopmonkey shop, performs a lightweight connection probe
 * (`testConnection`) and reports per-shop reachability + the API key's
 * validity. Useful for catching revoked/expired per-shop API keys before they
 * surface as silent webhook gaps.
 *
 * PROD-SAFE: no-op (shopsConsidered:0) when zero shops are configured. Only
 * probes shops that have explicitly opted into Shopmonkey.
 *
 * Auth: standard `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shops = await getConfiguredShopmonkeyShops();
  if (shops.length === 0) {
    return NextResponse.json({
      ok: true,
      shopsConsidered: 0,
      note: "no Shopmonkey shops configured",
    });
  }

  const start = Date.now();
  const results: Array<{ shopId: number; ok: boolean; latencyMs: number; error?: string }> = [];

  for (const shop of shops) {
    const t0 = Date.now();
    try {
      const res = await testConnection(shop.shopId);
      results.push({
        shopId: shop.shopId,
        ok: !!res.ok,
        latencyMs: Date.now() - t0,
        error: res.ok ? undefined : res.error,
      });
    } catch (err: any) {
      results.push({ shopId: shop.shopId, ok: false, latencyMs: Date.now() - t0, error: err?.message || "unknown" });
    }
  }

  const healthy = results.filter((r) => r.ok).length;
  const unhealthy = results.length - healthy;

  console.log(
    `[Cron] Shopmonkey endpoint health: ${healthy}/${results.length} healthy, ${unhealthy} unhealthy (${Date.now() - start}ms)`,
  );

  return NextResponse.json({
    ok: unhealthy === 0,
    shopsConsidered: shops.length,
    healthy,
    unhealthy,
    duration: `${Date.now() - start}ms`,
    shops: results,
  });
}
