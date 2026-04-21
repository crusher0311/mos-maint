import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { tekmetricRequest } from "@/lib/integrations/tekmetric/client";
import { resolveProtractorConfig, protractorFetch } from "@/lib/integrations/protractor";
import { getRepairOrders } from "@/lib/integrations/shopware/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;
const SAMPLES_PER_SHOP = 6;
const DELTA_TOLERANCE = 0.02;
const YEARS = 5;

function isAuthorized(req: NextRequest): boolean {
  if (!CRON_SECRET) return true;
  const header = req.headers.get("authorization");
  const param = req.nextUrl.searchParams.get("secret");
  return header === `Bearer ${CRON_SECRET}` || param === CRON_SECRET;
}

function randomSampleWindows(years: number, count: number): { start: Date; end: Date }[] {
  const now = new Date();
  const oldest = new Date();
  oldest.setFullYear(oldest.getFullYear() - years);
  const totalMs = now.getTime() - oldest.getTime();
  const out: { start: Date; end: Date }[] = [];
  for (let i = 0; i < count; i++) {
    const startOffset = Math.random() * (totalMs - 30 * 86400_000);
    const start = new Date(oldest.getTime() + startOffset);
    const end = new Date(start.getTime() + 30 * 86400_000);
    out.push({ start, end });
  }
  return out;
}

async function reconcileTekmetricShop(db: any, shopId: number, tekmetricShopId: number) {
  const samples = randomSampleWindows(YEARS, SAMPLES_PER_SHOP);
  const audits: any[] = [];
  let worstDeltaWindow: { start: Date; end: Date; delta: number } | null = null;

  for (const w of samples) {
    const startStr = w.start.toISOString();
    const endStr = w.end.toISOString();

    const params = new URLSearchParams({
      shop: String(tekmetricShopId),
      page: "0",
      size: "1",
      updatedDateStart: startStr,
      updatedDateEnd: endStr,
    });
    let upstreamTotal = 0;
    try {
      const res = await tekmetricRequest<{ totalElements?: number }>(`/repair-orders?${params}`);
      upstreamTotal = (res as any)?.totalElements || 0;
    } catch (err: any) {
      audits.push({ window: { start: startStr, end: endStr }, error: err.message });
      continue;
    }

    const ourROIds: string[] = await db.collection("job_index").distinct("workOrderId", {
      shopId,
      sourceSystem: "tekmetric",
      closedAt: { $gte: startStr, $lte: endStr },
    });
    const ourCount = ourROIds.length;

    const delta = upstreamTotal === 0 ? 0 : Math.abs(upstreamTotal - ourCount) / upstreamTotal;
    audits.push({
      window: { start: startStr.split("T")[0], end: endStr.split("T")[0] },
      upstream: upstreamTotal,
      ours: ourCount,
      delta: Number(delta.toFixed(3)),
    });

    if (delta > DELTA_TOLERANCE && (!worstDeltaWindow || delta > worstDeltaWindow.delta)) {
      worstDeltaWindow = { start: w.start, end: w.end, delta };
    }
  }

  if (worstDeltaWindow) {
    // Re-queue: pull cursor back so the worst-delta window will be reprocessed.
    await db.collection("tekmetric_backfill_progress").updateOne(
      { shopId },
      {
        $set: {
          completed: false,
          currentChunkEnd: worstDeltaWindow.end,
          reconciliationGapDetected: true,
          reconciliationLastRunAt: new Date(),
        },
      }
    );
    await db.collection("shops").updateOne(
      { shopId },
      { $set: { tekmetricBackfillComplete: false } }
    );
  } else {
    await db.collection("tekmetric_backfill_progress").updateOne(
      { shopId },
      { $set: { reconciliationLastRunAt: new Date(), reconciliationGapDetected: false } }
    );
  }

  return { provider: "tekmetric", shopId, samples: audits, requeued: !!worstDeltaWindow };
}

async function reconcileProtractorShop(db: any, shopId: number) {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) return { provider: "protractor", shopId, skipped: "not configured" };

  const samples = randomSampleWindows(YEARS, SAMPLES_PER_SHOP);
  const audits: any[] = [];
  let worstDeltaWindow: { start: Date; end: Date; delta: number } | null = null;

  for (const w of samples) {
    const startStr = w.start.toISOString().split("T")[0];
    const endStr = w.end.toISOString().split("T")[0];
    const params = new URLSearchParams({
      startDate: startStr,
      endDate: endStr,
      take: "1",
      skip: "0",
    });

    let upstreamTotal = 0;
    try {
      const res = await protractorFetch<{ ItemCollection?: any[]; Count?: number; TotalCount?: number }>(
        `/Invoice/?${params.toString()}`,
        config
      );
      if (!res.ok || !res.data) {
        audits.push({ window: { start: startStr, end: endStr }, error: res.error || "no data" });
        continue;
      }
      upstreamTotal = (res.data as any).TotalCount ?? (res.data as any).Count ?? (res.data.ItemCollection?.length ?? 0);
    } catch (err: any) {
      audits.push({ window: { start: startStr, end: endStr }, error: err.message });
      continue;
    }

    const ourInvoiceIds: string[] = await db.collection("job_index").distinct("workOrderId", {
      shopId,
      sourceSystem: "protractor",
      closedAt: { $gte: w.start.toISOString(), $lte: w.end.toISOString() },
    });
    const ourCount = ourInvoiceIds.length;

    const delta = upstreamTotal === 0 ? 0 : Math.abs(upstreamTotal - ourCount) / upstreamTotal;
    audits.push({ window: { start: startStr, end: endStr }, upstream: upstreamTotal, ours: ourCount, delta: Number(delta.toFixed(3)) });

    if (delta > DELTA_TOLERANCE && (!worstDeltaWindow || delta > worstDeltaWindow.delta)) {
      worstDeltaWindow = { start: w.start, end: w.end, delta };
    }
  }

  if (worstDeltaWindow) {
    await db.collection("backfill_progress").updateOne(
      { shopId },
      {
        $set: {
          completed: false,
          currentChunkEnd: worstDeltaWindow.end,
          reconciliationGapDetected: true,
          reconciliationLastRunAt: new Date(),
        },
      }
    );
    await db.collection("shops").updateOne(
      { shopId },
      { $set: { protractorBackfillComplete: false } }
    );
  } else {
    await db.collection("backfill_progress").updateOne(
      { shopId },
      { $set: { reconciliationLastRunAt: new Date(), reconciliationGapDetected: false } }
    );
  }

  return { provider: "protractor", shopId, samples: audits, requeued: !!worstDeltaWindow };
}

async function reconcileShopwareShop(db: any, shopId: number, tenantId: number, swShopId: number) {
  const samples = randomSampleWindows(YEARS, Math.min(3, SAMPLES_PER_SHOP));
  const audits: any[] = [];
  let worstDeltaWindow: { start: Date; end: Date; delta: number } | null = null;

  for (const w of samples) {
    let upstreamTotal = 0;
    try {
      const ros = await getRepairOrders(tenantId, shopId, {
        shop_id: swShopId,
        updated_after: w.start.toISOString(),
        associations: "",
      });
      upstreamTotal = ros.filter((ro) => {
        const u = ro.updated_at ? new Date(ro.updated_at) : null;
        return !u || u <= w.end;
      }).length;
    } catch (err: any) {
      audits.push({ window: { start: w.start.toISOString().split("T")[0], end: w.end.toISOString().split("T")[0] }, error: err.message });
      continue;
    }

    const ourCount = await db.collection("shopware_repair_orders").countDocuments({
      mosShopId: shopId,
      updatedAt: { $gte: w.start, $lte: w.end },
    });

    const delta = upstreamTotal === 0 ? 0 : Math.abs(upstreamTotal - ourCount) / upstreamTotal;
    audits.push({
      window: { start: w.start.toISOString().split("T")[0], end: w.end.toISOString().split("T")[0] },
      upstream: upstreamTotal,
      ours: ourCount,
      delta: Number(delta.toFixed(3)),
    });

    if (delta > DELTA_TOLERANCE && (!worstDeltaWindow || delta > worstDeltaWindow.delta)) {
      worstDeltaWindow = { start: w.start, end: w.end, delta };
    }
  }

  if (worstDeltaWindow) {
    await db.collection("shopware_backfill_progress").updateOne(
      { shopId },
      {
        $set: {
          completed: false,
          currentChunkEnd: worstDeltaWindow.end,
          reconciliationGapDetected: true,
          reconciliationLastRunAt: new Date(),
        },
      }
    );
    await db.collection("shops").updateOne(
      { shopId: { $in: [shopId, String(shopId)] as any } },
      { $set: { "backfill.status": "incomplete_after_reconciliation" } }
    );
  } else {
    await db.collection("shopware_backfill_progress").updateOne(
      { shopId },
      { $set: { reconciliationLastRunAt: new Date(), reconciliationGapDetected: false } }
    );
  }

  return { provider: "shopware", shopId, samples: audits, requeued: !!worstDeltaWindow };
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const db = await getDb();
  const provider = req.nextUrl.searchParams.get("provider");
  const targetShopParam = req.nextUrl.searchParams.get("shopId");
  const targetShopId = targetShopParam ? Number(targetShopParam) : null;

  const results: any[] = [];

  try {
    if (!provider || provider === "tekmetric") {
      const shopFilter: any = { tekmetricBackfillComplete: true };
      if (targetShopId) shopFilter.shopId = targetShopId;
      const shops = await db.collection("shops").find(shopFilter).limit(targetShopId ? 1 : 5).toArray();
      for (const shop of shops) {
        const tekmetricShopId = shop.tekmetric?.shopId || shop.tekmetricShopId;
        if (!tekmetricShopId) continue;
        try {
          results.push(await reconcileTekmetricShop(db, Number(shop.shopId), Number(tekmetricShopId)));
        } catch (err: any) {
          results.push({ provider: "tekmetric", shopId: shop.shopId, error: err.message });
        }
      }
    }

    if (!provider || provider === "protractor") {
      const shopFilter: any = { protractorBackfillComplete: true };
      if (targetShopId) shopFilter.shopId = targetShopId;
      const shops = await db.collection("shops").find(shopFilter).limit(targetShopId ? 1 : 5).toArray();
      for (const shop of shops) {
        try {
          results.push(await reconcileProtractorShop(db, Number(shop.shopId)));
        } catch (err: any) {
          results.push({ provider: "protractor", shopId: shop.shopId, error: err.message });
        }
      }
    }

    if (!provider || provider === "shopware") {
      const shopFilter: any = { "backfill.status": "completed", "shopware.tenantId": { $exists: true, $ne: null } };
      if (targetShopId) shopFilter.shopId = { $in: [targetShopId, String(targetShopId)] };
      const shops = await db.collection("shops").find(shopFilter).limit(targetShopId ? 1 : 5).toArray();
      for (const shop of shops) {
        const tenantId = shop.shopware?.tenantId;
        const swShopId = shop.shopware?.swShopId;
        if (!tenantId) continue;
        try {
          results.push(await reconcileShopwareShop(db, Number(shop.shopId), Number(tenantId), Number(swShopId)));
        } catch (err: any) {
          results.push({ provider: "shopware", shopId: shop.shopId, error: err.message });
        }
      }
    }

    return NextResponse.json({
      ok: true,
      duration: `${Date.now() - startTime}ms`,
      reconciled: results.length,
      requeued: results.filter((r) => r.requeued).length,
      results,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
