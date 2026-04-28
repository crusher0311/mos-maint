import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  prewarmShopWareJobsCacheForOnboarding,
  PrewarmShopWareJobsCacheResult,
} from "@/lib/shopware-jobs-prewarm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Bulk pre-warm runs the per-shop Shop-Ware worker serially across shops
// so we don't multiply Shop-Ware quota pressure beyond a single shop's
// in-flight footprint (the SW worker mostly issues one paginated
// /repair_orders list + per-RO fallback fetches; no internal fan-out to
// preserve here, just don't double up across shops). Each per-shop pass
// already takes seconds to a couple of minutes; we mirror the Tekmetric
// bulk endpoint's 5-minute platform ceiling and stop launching new shops
// once we're inside 30s of the limit so a busy shop mid-warm completes
// cleanly instead of getting cut off by the platform's hard kill.
export const maxDuration = 300;

const SOFT_TIME_BUDGET_MS = 270_000;

// Projection shape returned by the never-warmed-shops query below.
// `shopId` is sometimes stored as a string and sometimes as a number
// across collections (mirrors how the sync-health route keys its joins
// on `String(shopId)`), so we accept both at the type level and narrow
// before use.
interface NeverWarmedShopWareShopDoc {
  shopId: number | string;
  name?: string | null;
  shopware?: {
    tenantId?: number | string | null;
    swShopId?: number | string | null;
  } | null;
}

type PerShopStatus = "warmed" | "skipped" | "errored" | "deferred";

interface PerShopResultEntry {
  shopId: number | string;
  shopName: string | null;
  status: PerShopStatus;
  reason?: string;
  result?: PrewarmShopWareJobsCacheResult;
  error?: string;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Failed to re-warm Shop-Ware jobs cache";
}

export async function POST(_req: NextRequest) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const db = await getDb();

  // "Never warmed" = shop has a Shop-Ware integration but no
  // `shopware.jobsCachePrewarm` stamp. Mirror the join the
  // sync-health view uses (see app/api/admin/sync-health/route.ts) so
  // the bulk action sees exactly the same set of shops the operator
  // sees in the "X never warmed" badge.
  const shops = await db
    .collection<NeverWarmedShopWareShopDoc>("shops")
    .find(
      {
        "shopware.tenantId": { $exists: true, $ne: null },
        $or: [
          { "shopware.jobsCachePrewarm": { $exists: false } },
          { "shopware.jobsCachePrewarm": null },
        ],
      },
      {
        projection: {
          shopId: 1,
          name: 1,
          "shopware.tenantId": 1,
          "shopware.swShopId": 1,
          _id: 0,
        },
      },
    )
    .toArray();

  console.log(
    `[Platform Admin] Bulk Shop-Ware jobs-cache pre-warm requested for ${shops.length} never-warmed shop(s) by ${session.email}`,
  );

  await db.collection("audit_logs").insertOne({
    type: "shopware_jobs_cache_rewarm_all_started",
    adminEmail: session.email,
    candidateShopCount: shops.length,
    createdAt: new Date(),
  });

  const perShop: PerShopResultEntry[] = [];

  let warmed = 0;
  let skipped = 0;
  let errored = 0;
  let deferred = 0;

  for (const shop of shops) {
    const rawShopId = shop.shopId;
    const shopId = Number(rawShopId);
    const shopName: string | null = shop.name ?? null;

    if (Number.isNaN(shopId)) {
      perShop.push({
        shopId: rawShopId,
        shopName,
        status: "skipped",
        reason: "Non-numeric platform shopId",
      });
      skipped++;
      continue;
    }

    const tenantId = Number(shop.shopware?.tenantId);
    const swShopId = Number(shop.shopware?.swShopId);
    if (!tenantId || Number.isNaN(tenantId)) {
      perShop.push({
        shopId,
        shopName,
        status: "skipped",
        reason: "Shop is not connected to Shop-Ware (missing tenantId)",
      });
      skipped++;
      continue;
    }
    if (!swShopId || Number.isNaN(swShopId)) {
      perShop.push({
        shopId,
        shopName,
        status: "skipped",
        reason: "Shop is not connected to Shop-Ware (missing swShopId)",
      });
      skipped++;
      continue;
    }

    // Soft time budget: if we're close to the platform's hard kill, stop
    // launching new shops and report the rest as deferred so the operator
    // can re-click to drain the remainder.
    if (Date.now() - startTime > SOFT_TIME_BUDGET_MS) {
      perShop.push({
        shopId,
        shopName,
        status: "deferred",
        reason: "Time budget exhausted; re-run to continue",
      });
      deferred++;
      continue;
    }

    await db.collection("audit_logs").insertOne({
      type: "shopware_jobs_cache_rewarm",
      shopId,
      tenantId,
      swShopId,
      shopName,
      adminEmail: session.email,
      bulk: true,
      createdAt: new Date(),
    });

    try {
      const result = await prewarmShopWareJobsCacheForOnboarding(
        shopId,
        tenantId,
        swShopId,
      );
      perShop.push({
        shopId,
        shopName,
        status: "warmed",
        result,
      });
      warmed++;
    } catch (err) {
      const message = describeError(err);
      console.error(
        `[Platform Admin] Bulk Shop-Ware pre-warm: shop ${shopId} failed:`,
        err,
      );
      perShop.push({
        shopId,
        shopName,
        status: "errored",
        error: message,
      });
      errored++;
    }
  }

  const duration = Date.now() - startTime;

  const aggregate = {
    candidateShopCount: shops.length,
    warmed,
    skipped,
    errored,
    deferred,
    rosFetchedTotal: perShop.reduce(
      (n, r) => n + (r.result?.rosFetched ?? 0),
      0,
    ),
    rosStoredTotal: perShop.reduce(
      (n, r) => n + (r.result?.rosStored ?? 0),
      0,
    ),
    jobsIndexedTotal: perShop.reduce(
      (n, r) => n + (r.result?.jobsIndexed ?? 0),
      0,
    ),
    jobsSkippedTotal: perShop.reduce(
      (n, r) => n + (r.result?.jobsSkipped ?? 0),
      0,
    ),
    vehiclesStoredTotal: perShop.reduce(
      (n, r) => n + (r.result?.vehiclesStored ?? 0),
      0,
    ),
    customersStoredTotal: perShop.reduce(
      (n, r) => n + (r.result?.customersStored ?? 0),
      0,
    ),
    perShopErrorsTotal: perShop.reduce(
      (n, r) => n + (r.result?.errors ?? 0),
      0,
    ),
    cappedShopCount: perShop.filter((r) => r.result?.capped).length,
    cursorAdvancedShopCount: perShop.filter(
      (r) => r.result?.cursorAdvanced,
    ).length,
  };

  await db.collection("audit_logs").insertOne({
    type: "shopware_jobs_cache_rewarm_all_completed",
    adminEmail: session.email,
    durationMs: duration,
    ...aggregate,
    createdAt: new Date(),
  });

  console.log(
    `[Platform Admin] Bulk Shop-Ware jobs-cache pre-warm done: ` +
      `warmed=${warmed} errored=${errored} skipped=${skipped} deferred=${deferred} ` +
      `(candidates=${shops.length}, ${duration}ms)`,
  );

  return NextResponse.json({
    ok: true,
    duration: `${duration}ms`,
    durationMs: duration,
    ...aggregate,
    perShop,
  });
}
