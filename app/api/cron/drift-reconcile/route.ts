import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { reconcileProtractorDrift, reconcileTekmetricDrift } from "@/lib/dashboard/drift-reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Task #757 — periodic drift backstop for the normalized dashboard read model.
 *
 * This used to run synchronously on every `/api/dashboard/data-v2` load: each
 * dashboard read reconciled the shop's Protractor/Tekmetric snapshots against
 * `normalized_work_orders` and re-ingested any drifted RO inline, adding
 * meaningful latency to the hottest page in the app. The webhook path already
 * normalizes inline (Task #517/#519), so the reconcile is a rare safety net —
 * it belongs on a schedule, not the user's critical path.
 *
 * Each shop's reconcile is bounded to snapshots touched in the last 24h and is
 * idempotent (it only re-normalizes rows whose snapshot is >2 min newer than
 * their normalized counterpart), so a periodic sweep of every configured shop
 * detects and corrects the same drift the read path did, off the read path.
 *
 * Supports `?provider=protractor|tekmetric` and `?shopId=<n>` for targeted
 * manual runs (mirrors `/api/cron/backfill-reconcile`).
 */

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get("authorization");
  const param = req.nextUrl.searchParams.get("secret");
  return header === `Bearer ${secret}` || param === secret;
}

export const __deps = { getDb };

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const db = await __deps.getDb();
  const provider = req.nextUrl.searchParams.get("provider");
  const targetShopParam = req.nextUrl.searchParams.get("shopId");
  const targetShopId = targetShopParam ? Number(targetShopParam) : null;

  let protractorShops = 0;
  let tekmetricShops = 0;
  const errors: any[] = [];

  try {
    if (!provider || provider === "protractor") {
      const filter: any = { "protractor.configured": true };
      if (targetShopId != null) filter.shopId = { $in: [targetShopId, String(targetShopId)] };
      const shops = await db.collection("shops").find(filter, { projection: { shopId: 1 } }).toArray();
      for (const shop of shops) {
        const shopId = Number(shop.shopId);
        if (!Number.isFinite(shopId)) continue;
        try {
          await reconcileProtractorDrift(db, shopId);
          protractorShops += 1;
        } catch (err: any) {
          errors.push({ provider: "protractor", shopId, error: err?.message || String(err) });
        }
      }
    }

    if (!provider || provider === "tekmetric") {
      const filter: any = { "tekmetric.configured": true };
      if (targetShopId != null) filter.shopId = { $in: [targetShopId, String(targetShopId)] };
      const shops = await db.collection("shops").find(filter, { projection: { shopId: 1 } }).toArray();
      for (const shop of shops) {
        const shopId = Number(shop.shopId);
        if (!Number.isFinite(shopId)) continue;
        try {
          await reconcileTekmetricDrift(db, shopId);
          tekmetricShops += 1;
        } catch (err: any) {
          errors.push({ provider: "tekmetric", shopId, error: err?.message || String(err) });
        }
      }
    }

    return NextResponse.json({
      ok: true,
      duration: `${Date.now() - startTime}ms`,
      protractorShops,
      tekmetricShops,
      errors,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
