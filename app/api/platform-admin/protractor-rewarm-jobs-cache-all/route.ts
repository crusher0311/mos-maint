import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  prewarmProtractorJobsCacheForOnboarding,
  PrewarmProtractorJobsCacheResult,
} from "@/lib/protractor-jobs-prewarm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Bulk pre-warm runs the per-shop Protractor worker serially so we
// don't multiply Protractor quota pressure beyond the single-shop
// /Invoice/{id} concurrency cap (3) inside the worker. Each per-shop
// pass already has its own multi-minute ceiling, so we mirror the
// 5-minute platform ceiling the Tekmetric/Shop-Ware bulk endpoints
// use and stop launching new shops once we're inside 30s of the limit
// — that way a busy shop mid-warm completes cleanly instead of
// getting cut off by the platform's hard kill.
export const maxDuration = 300;

const SOFT_TIME_BUDGET_MS = 270_000;

// Projection shape returned by the never-warmed-shops query below.
// `shopId` is sometimes stored as a string and sometimes as a number
// across collections (mirrors how the sync-health route keys its joins
// on `String(shopId)`), so we accept both at the type level and narrow
// before use.
interface NeverWarmedProtractorShopDoc {
  shopId: number | string;
  name?: string | null;
  protractor?: { connectionId?: string | null } | null;
}

type PerShopStatus = "warmed" | "skipped" | "errored" | "deferred";

interface PerShopResultEntry {
  shopId: number | string;
  shopName: string | null;
  status: PerShopStatus;
  reason?: string;
  result?: PrewarmProtractorJobsCacheResult;
  error?: string;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Failed to re-warm Protractor invoice cache";
}

export async function POST(_req: NextRequest) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const db = await getDb();

  // "Never warmed" = shop has a Protractor integration (`configured:
  // true`) but no `protractor.invoiceCachePrewarm` stamp. Mirror the
  // join the sync-health view uses (see
  // app/api/admin/sync-health/route.ts) so the bulk action sees
  // exactly the same set of shops the operator sees in the "X never
  // warmed" badge.
  const shops = await db
    .collection<NeverWarmedProtractorShopDoc>("shops")
    .find(
      {
        "protractor.configured": true,
        $or: [
          { "protractor.invoiceCachePrewarm": { $exists: false } },
          { "protractor.invoiceCachePrewarm": null },
        ],
      },
      {
        projection: {
          shopId: 1,
          name: 1,
          "protractor.connectionId": 1,
          _id: 0,
        },
      },
    )
    .toArray();

  console.log(
    `[Platform Admin] Bulk Protractor invoice-cache pre-warm requested for ${shops.length} never-warmed shop(s) by ${session.email}`,
  );

  await db.collection("audit_logs").insertOne({
    type: "protractor_invoice_cache_rewarm_all_started",
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

    // Soft time budget: if we're close to the platform's hard kill,
    // stop launching new shops and report the rest as deferred so the
    // operator can re-click to drain the remainder.
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
      type: "protractor_invoice_cache_rewarm",
      shopId,
      shopName,
      adminEmail: session.email,
      bulk: true,
      createdAt: new Date(),
    });

    try {
      const result = await prewarmProtractorJobsCacheForOnboarding(shopId);
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
        `[Platform Admin] Bulk Protractor pre-warm: shop ${shopId} failed:`,
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
    invoicesScannedTotal: perShop.reduce(
      (n, r) => n + (r.result?.invoicesScanned ?? 0),
      0,
    ),
    invoicesCachedTotal: perShop.reduce(
      (n, r) => n + (r.result?.invoicesCached ?? 0),
      0,
    ),
    alreadyCachedTotal: perShop.reduce(
      (n, r) => n + (r.result?.alreadyCached ?? 0),
      0,
    ),
    perShopErrorsTotal: perShop.reduce(
      (n, r) => n + (r.result?.errors ?? 0),
      0,
    ),
    cappedShopCount: perShop.filter((r) => r.result?.capped).length,
  };

  await db.collection("audit_logs").insertOne({
    type: "protractor_invoice_cache_rewarm_all_completed",
    adminEmail: session.email,
    durationMs: duration,
    ...aggregate,
    createdAt: new Date(),
  });

  console.log(
    `[Platform Admin] Bulk Protractor invoice-cache pre-warm done: ` +
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
