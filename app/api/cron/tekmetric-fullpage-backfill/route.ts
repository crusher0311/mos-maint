/**
 * Tekmetric Full-Page Backfill Cron
 *
 * Companion to `/api/cron/tekmetric-backfill`. Runs the no-date-filter
 * pagination worker (`runFullPageBackfillChunk`) for every shop whose
 * `tekmetric_backfill_progress.fullPageMode === true`. The regular chunker's
 * early-return guard means these two routes never touch the same shop in
 * the same tick.
 *
 * GET = drain mode, processes all flagged shops (one at a time to keep the
 *       Tekmetric 5 RPS budget unfragmented per shop).
 * POST {shopId} = single-shop trigger, used by the platform-admin button.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { runFullPageBackfillChunk } from "@/lib/integrations/tekmetric/full-page-backfill";
import {
  acquireInFlightLock,
  releaseInFlightLock,
} from "@/lib/integrations/tekmetric/inflight-lock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

type ShopRow = {
  shopId: number;
  name: string;
  tekmetricShopId: number;
};

async function getFlaggedShops(db: any): Promise<ShopRow[]> {
  const progressRows = await db
    .collection("tekmetric_backfill_progress")
    .find({ fullPageMode: true, completed: { $ne: true } })
    .project({ shopId: 1, fullPageQueuedAt: 1, lastFullPageRunAt: 1 })
    .toArray();
  if (progressRows.length === 0) return [];
  const shopIds = progressRows.map((r: any) => Number(r.shopId));
  const shops = await db
    .collection("shops")
    .find({ shopId: { $in: shopIds } })
    .project({
      shopId: 1,
      name: 1,
      "tekmetric.shopId": 1,
      tekmetricShopId: 1,
    })
    .toArray();
  // Sort by least-recently-run so all flagged shops make progress when more
  // than one is queued at the same time.
  const lastRunByShop = new Map(
    progressRows.map((r: any) => [
      Number(r.shopId),
      new Date(
        r.lastFullPageRunAt || r.fullPageQueuedAt || 0,
      ).getTime(),
    ]),
  );
  return shops
    .map((s: any) => {
      const tekmetricShopId =
        Number(s.tekmetric?.shopId) || Number(s.tekmetricShopId);
      if (!Number.isFinite(tekmetricShopId) || tekmetricShopId <= 0)
        return null;
      return {
        shopId: Number(s.shopId),
        name: s.name || `Shop ${s.shopId}`,
        tekmetricShopId,
      } as ShopRow;
    })
    .filter((s: ShopRow | null): s is ShopRow => s !== null)
    .sort(
      (a: ShopRow, b: ShopRow) =>
        (lastRunByShop.get(a.shopId) || 0) -
        (lastRunByShop.get(b.shopId) || 0),
    );
}

async function processShops(shops: ShopRow[], deadlineMs: number) {
  const results: any[] = [];
  for (const shop of shops) {
    if (Date.now() >= deadlineMs) {
      console.log(
        `[Tekmetric Full-Page Cron] Deadline reached, ${shops.length - results.length} shop(s) deferred to next tick`,
      );
      break;
    }
    try {
      const result = await runFullPageBackfillChunk(
        null as any,
        shop.shopId,
        shop.tekmetricShopId,
      );
      results.push({ shopId: shop.shopId, name: shop.name, ...result });
    } catch (err: any) {
      console.error(
        `[Tekmetric Full-Page Cron] Shop ${shop.shopId} threw:`,
        err,
      );
      results.push({
        shopId: shop.shopId,
        name: shop.name,
        ok: false,
        complete: false,
        error: (err?.message || String(err)).slice(0, 400),
      });
    }
  }
  return results;
}

// `runFullPageBackfillChunk` accepts db as first arg but the cron resolves
// it once and threads the resolved Db handle through. Wrap so the call
// site stays clean.
async function runForShop(db: any, shop: ShopRow) {
  return runFullPageBackfillChunk(db, shop.shopId, shop.tekmetricShopId);
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (
    !process.env.TEKMETRIC_CLIENT_ID ||
    !process.env.TEKMETRIC_CLIENT_SECRET
  ) {
    return NextResponse.json(
      { error: "Tekmetric OAuth credentials not configured" },
      { status: 500 },
    );
  }

  const db = await getDb();

  // Defer to drain lock, mirroring the regular backfill cron. The drain
  // worker's lease covers ALL Tekmetric backfill writes, including the
  // full-page progress fields.
  const drainLock = await db
    .collection("tekmetric_drain_lock")
    .findOne({ _id: "global" as any });
  if (
    drainLock &&
    drainLock.expiresAt &&
    new Date(drainLock.expiresAt) > new Date()
  ) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "drain_in_progress",
      message:
        "Tekmetric drain worker holds an exclusive lease; full-page cron tick is a no-op.",
    });
  }

  const startTime = Date.now();
  const deadlineMs = startTime + 270 * 1000; // leave ~30s headroom under maxDuration
  const shops = await getFlaggedShops(db);

  if (shops.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "No shops flagged for full-page reindex",
      shopsRemaining: 0,
      duration: `${Date.now() - startTime}ms`,
    });
  }

  const results: any[] = [];
  for (const shop of shops) {
    if (Date.now() >= deadlineMs) {
      console.log(
        `[Tekmetric Full-Page Cron] Deadline reached after ${results.length}/${shops.length} shops`,
      );
      break;
    }
    // Per-shop in-flight lock. If a manual POST or a slow previous tick
    // is still running this shop, skip and move on rather than racing.
    const lock = await acquireInFlightLock(db, shop.shopId);
    if (!lock.acquired) {
      console.log(
        `[Tekmetric Full-Page Cron] Shop ${shop.shopId}: skipped — in-flight lock held by ${lock.heldBy} until ${lock.heldUntil?.toISOString?.() || lock.heldUntil}`,
      );
      results.push({
        shopId: shop.shopId,
        name: shop.name,
        ok: true,
        skipped: true,
        reason: "in_flight",
        heldBy: lock.heldBy,
        heldUntil: lock.heldUntil,
      });
      continue;
    }
    try {
      const result = await runForShop(db, shop);
      results.push({ shopId: shop.shopId, name: shop.name, ...result });
    } catch (err: any) {
      console.error(
        `[Tekmetric Full-Page Cron] Shop ${shop.shopId} threw:`,
        err,
      );
      results.push({
        shopId: shop.shopId,
        name: shop.name,
        ok: false,
        complete: false,
        error: (err?.message || String(err)).slice(0, 400),
      });
    } finally {
      await releaseInFlightLock(db, shop.shopId, lock.owner);
    }
  }

  return NextResponse.json({
    ok: true,
    processed: results,
    shopsRemaining: shops.length - results.length,
    duration: `${Date.now() - startTime}ms`,
  });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (
    !process.env.TEKMETRIC_CLIENT_ID ||
    !process.env.TEKMETRIC_CLIENT_SECRET
  ) {
    return NextResponse.json(
      { error: "Tekmetric OAuth credentials not configured" },
      { status: 500 },
    );
  }

  const db = await getDb();
  const body = await req.json().catch(() => ({}));
  const targetShopId = body.shopId ? Number(body.shopId) : null;
  if (!targetShopId || !Number.isFinite(targetShopId)) {
    return NextResponse.json(
      { error: "shopId required" },
      { status: 400 },
    );
  }

  const shop = await db.collection("shops").findOne({ shopId: targetShopId });
  if (!shop) {
    return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  }
  const tekmetricShopId =
    Number(shop.tekmetric?.shopId) || Number(shop.tekmetricShopId);
  if (!Number.isFinite(tekmetricShopId) || tekmetricShopId <= 0) {
    return NextResponse.json(
      { error: "Shop has no Tekmetric shopId configured" },
      { status: 400 },
    );
  }

  // Per-shop in-flight lock. Manual retries during ops debugging
  // (Render's edge times out at ~280s but the Node promise keeps running
  // server-side) used to stack 4+ concurrent runs on the same shop, all
  // reading the same `prePassNextPage` and competing for the shared
  // 8 RPS Tekmetric budget. 409 here means a previous POST or cron tick
  // is still running — wait for the TTL, or check `catchup-status` for
  // live progress.
  const lock = await acquireInFlightLock(db, targetShopId);
  if (!lock.acquired) {
    const heldUntilIso =
      lock.heldUntil instanceof Date
        ? lock.heldUntil.toISOString()
        : lock.heldUntil;
    const startedAtIso =
      lock.startedAt instanceof Date
        ? lock.startedAt.toISOString()
        : lock.startedAt;
    const startedAgoSec = lock.startedAt
      ? Math.round(
          (Date.now() - new Date(lock.startedAt).getTime()) / 1000,
        )
      : null;
    const heldUntilSec = lock.heldUntil
      ? Math.round(
          (new Date(lock.heldUntil).getTime() - Date.now()) / 1000,
        )
      : null;
    return NextResponse.json(
      {
        ok: false,
        error: "in_flight",
        message: `Shop ${targetShopId} is already running${startedAgoSec !== null ? ` (started ${startedAgoSec}s ago` : ""}${heldUntilSec !== null ? `, lock held for ${heldUntilSec}s more` : startedAgoSec !== null ? "" : ""}${startedAgoSec !== null ? ")" : ""}. Wait for it to finish or for the TTL to expire.`,
        heldBy: lock.heldBy,
        heldUntil: heldUntilIso,
        startedAt: startedAtIso,
      },
      { status: 409 },
    );
  }

  const startTime = Date.now();
  const deadlineMs = startTime + 270 * 1000;
  const results: any[] = [];

  try {
    // Drain pages for this single shop until either complete OR the request
    // deadline. The chunk function caps each call at MAX_PAGES_PER_RUN pages,
    // so we loop until we run out of time or hit completion.
    while (Date.now() < deadlineMs) {
      const result = await runFullPageBackfillChunk(
        db,
        targetShopId,
        tekmetricShopId,
      );
      results.push({
        pagesProcessed: result.pagesProcessed,
        jobsIndexed: result.jobsIndexed,
        complete: result.complete,
        message: result.message,
      });
      if (result.complete || !result.ok || result.pagesProcessed === 0) break;
    }
  } finally {
    await releaseInFlightLock(db, targetShopId, lock.owner);
  }

  const totalJobs = results.reduce(
    (sum, r) => sum + (r.jobsIndexed || 0),
    0,
  );
  const complete = results.length > 0 && results[results.length - 1].complete;

  return NextResponse.json({
    ok: true,
    shopId: targetShopId,
    shopName: shop.name,
    chunks: results,
    totalJobsIndexed: totalJobs,
    complete,
    duration: `${Date.now() - startTime}ms`,
    message: complete
      ? "Full-page reindex complete"
      : `${results.length} chunk(s) processed, more pages remain — cron will continue automatically`,
  });
}
