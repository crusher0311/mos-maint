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
  // Two-tier sort: never-ran-a-page shops FIRST (oldest queue wins),
  // then everyone else by least-recently-run. Without the tier split,
  // the bare `lastFullPageRunAt || fullPageQueuedAt` fallback ties
  // never-ran shops against shops that DID run yesterday — which lets
  // the same 1-2 shops dominate the cron's per-tick budget while
  // never-ran shops (8 of 14 in diagnosis #443, some queued 9 days ago)
  // never get a turn. Promoting null-lastFullPageRunAt to the front
  // guarantees every flagged shop sees a first page within a few ticks.
  type SortKey = { tier: 0 | 1; t: number };
  const sortKeyByShop = new Map<number, SortKey>(
    progressRows.map((r: any) => {
      const neverRan = !r.lastFullPageRunAt;
      const t = new Date(
        r.lastFullPageRunAt || r.fullPageQueuedAt || 0,
      ).getTime();
      return [Number(r.shopId), { tier: neverRan ? 0 : 1, t }] as [
        number,
        SortKey,
      ];
    }),
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
    .sort((a: ShopRow, b: ShopRow) => {
      const ka = sortKeyByShop.get(a.shopId) || { tier: 1, t: 0 };
      const kb = sortKeyByShop.get(b.shopId) || { tier: 1, t: 0 };
      if (ka.tier !== kb.tier) return ka.tier - kb.tier;
      return ka.t - kb.t;
    });
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
// site stays clean. The `lockOwner` is forwarded so the chunker can bump
// the in-flight-lock heartbeat after each page write — a wedged run that
// stops writing pages within 3 minutes is now stealable by the next tick
// (see lib/integrations/tekmetric/inflight-lock.ts).
async function runForShop(db: any, shop: ShopRow, lockOwner: string) {
  return runFullPageBackfillChunk(
    db,
    shop.shopId,
    shop.tekmetricShopId,
    lockOwner,
  );
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
    if ((lock as any).stolenFromStaleHolder) {
      console.warn(
        `[Tekmetric Full-Page Cron] Shop ${shop.shopId}: took over wedged lock from ${(lock as any).previousOwner} (heartbeat stale).`,
      );
    }
    try {
      const result = await runForShop(db, shop, lock.owner);
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
  let deadlineHit = false;

  try {
    // Drain pages for this single shop until either complete OR the request
    // deadline. The chunk function caps each call at MAX_PAGES_PER_RUN pages,
    // so we loop until we run out of time or hit completion.
    if ((lock as any).stolenFromStaleHolder) {
      console.warn(
        `[Tekmetric Full-Page POST] Shop ${targetShopId}: took over wedged lock from ${(lock as any).previousOwner} (heartbeat stale).`,
      );
    }
    while (Date.now() < deadlineMs) {
      const result = await runFullPageBackfillChunk(
        db,
        targetShopId,
        tekmetricShopId,
        lock.owner,
      );
      results.push({
        pagesProcessed: result.pagesProcessed,
        jobsIndexed: result.jobsIndexed,
        complete: result.complete,
        message: result.message,
      });
      if (result.complete || !result.ok || result.pagesProcessed === 0) break;
    }
    if (Date.now() >= deadlineMs) {
      deadlineHit = true;
    }
  } finally {
    // Owner-scoped + deadline-aware release. We DELIBERATELY do not release
    // on the route-level deadline-driven exit — that path leaves the lock
    // in place so the TTL is the only recovery mechanism for runaway
    // promises (Render kills the response at ~280s but the Node promise
    // can keep running on the server, and we don't want stacked manual
    // retries to all start within seconds of each other). Normal
    // completion/error/throw paths still release immediately.
    if (deadlineHit) {
      console.log(
        `[Tekmetric Full-Page POST] Shop ${targetShopId}: deadline reached after ${Math.round((Date.now() - startTime) / 1000)}s — leaving in-flight lock for TTL (~6 min) so stacked retries can't re-trigger.`,
      );
    } else {
      await releaseInFlightLock(db, targetShopId, lock.owner);
    }
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
