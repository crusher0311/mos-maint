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
import { enqueueTekmetricFullPage } from "@/lib/queue/producer";
import { decideQueueFor } from "@/lib/queue/feature-flag";
import {
  prepareQuietWindowGate,
  applyQuietWindowGate,
  applyConservativeFallbackGate,
} from "@/lib/data/repositories/activity-profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

// Fairness knobs for the GET drain loop (see `getFlaggedShops` for the
// ordering they pair with).
//   - PER_SHOP_SLICE_MS bounds how long any single shop may hold a tick so
//     one shop's pre-pass can't consume the whole ~270s budget and starve
//     everyone behind it (the shop-99 head-of-line stall: its pre-pass ate
//     the full 240s SOFT_DEADLINE every tick for ~13 days while 15 shops
//     never got a first page).
//   - A "giant" (prePassTotalPages >= GIANT_PREPASS_PAGES) is capped to
//     MAX_GIANTS_PER_TICK slices per tick, reserving the rest of the budget
//     for normal shops so the long tail keeps moving.
const PER_SHOP_SLICE_MS = 60 * 1000;
const GIANT_PREPASS_PAGES = 1500;
const MAX_GIANTS_PER_TICK = 1;

type ShopRow = {
  shopId: number;
  name: string;
  tekmetricShopId: number;
  // Last-known pre-pass page count for this shop (0 until the pre-pass has
  // reported one). Used to classify "giant" shops for the per-tick cap.
  prePassTotalPages: number;
};

async function getFlaggedShops(db: any): Promise<ShopRow[]> {
  const progressRows = await db
    .collection("tekmetric_backfill_progress")
    .find({ fullPageMode: true, completed: { $ne: true } })
    .project({
      shopId: 1,
      fullPageQueuedAt: 1,
      lastFullPageRunAt: 1,
      lastPrePassRunAt: 1,
      prePassTotalPages: 1,
    })
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
  // Fairness ordering: process the LEAST-recently-touched shop first, where
  // "touched" is the most recent of EITHER backfill phase —
  // `lastFullPageRunAt` (the RO loop) OR `lastPrePassRunAt` (the bulk
  // pre-pass). Tie-break by oldest `fullPageQueuedAt` so a never-touched shop
  // still wins by waiting longest.
  //
  // Why both stamps: completion is gated on the full-page reindex, but a giant
  // shop can sit in the PRE-PASS phase for days, and the pre-pass never stamps
  // `lastFullPageRunAt`. The old tier sort (never-ran-full-page first, by
  // queue time) therefore pinned that one giant to the head of the line every
  // tick — it took the whole budget on its pre-pass and the shops behind it
  // never got a turn (shop 99's pre-pass stuck at 6116/6352 pages starved 15
  // never-started shops for ~13 days). Keying off the freshest of the two run
  // stamps rotates a shop to the BACK the moment it gets a slice, so every
  // flagged shop reaches the head within a few ticks.
  type SortKey = { touchedAt: number; queuedAt: number; prePassTotalPages: number };
  const sortKeyByShop = new Map<number, SortKey>(
    progressRows.map((r: any) => {
      const fp = r.lastFullPageRunAt ? new Date(r.lastFullPageRunAt).getTime() : 0;
      const pp = r.lastPrePassRunAt ? new Date(r.lastPrePassRunAt).getTime() : 0;
      const queuedAt = new Date(r.fullPageQueuedAt || 0).getTime();
      return [
        Number(r.shopId),
        {
          touchedAt: Math.max(fp, pp),
          queuedAt,
          prePassTotalPages: Number(r.prePassTotalPages) || 0,
        },
      ] as [number, SortKey];
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
        prePassTotalPages:
          sortKeyByShop.get(Number(s.shopId))?.prePassTotalPages || 0,
      } as ShopRow;
    })
    .filter((s: ShopRow | null): s is ShopRow => s !== null)
    .sort((a: ShopRow, b: ShopRow) => {
      const ka =
        sortKeyByShop.get(a.shopId) || { touchedAt: 0, queuedAt: 0, prePassTotalPages: 0 };
      const kb =
        sortKeyByShop.get(b.shopId) || { touchedAt: 0, queuedAt: 0, prePassTotalPages: 0 };
      if (ka.touchedAt !== kb.touchedAt) return ka.touchedAt - kb.touchedAt;
      return ka.queuedAt - kb.queuedAt;
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
        undefined,
        deadlineMs,
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
async function runForShop(
  db: any,
  shop: ShopRow,
  lockOwner: string,
  deadlineMs?: number,
) {
  return runFullPageBackfillChunk(
    db,
    shop.shopId,
    shop.tekmetricShopId,
    lockOwner,
    deadlineMs,
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

  // NOTE 2026-05-28: removed the `tekmetric_drain_lock` early-return
  // here. The original deferral assumed the drain worker also drives
  // the full-page worker, but `scripts/backfill-drain-worker.ts` only
  // spawns the date-window chunker (`drain:tekmetric-backfill`), and
  // the chunker explicitly early-returns for shops where
  // `fullPageMode === true`. Net effect: with the drain worker holding
  // the global lease ~continuously, the full-page cron was a no-op on
  // every tick and shops 82 / 118 / 122 (and others) never advanced
  // past their 2026-05-10 cursor despite 23 shops being flagged.
  //
  // Safety: this route uses a per-shop in-flight lock
  // (`acquireInFlightLock` on the progress doc) so it does not race
  // the chunker drain — the two paths touch disjoint shops (chunker
  // skips `fullPageMode=true`; this route ONLY runs `fullPageMode=true`
  // via `getFlaggedShops`'s filter).
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

  // Smart per-shop quiet-window gate (task #662), mirroring the standard
  // `/api/cron/tekmetric-backfill` route. OFF by default: when the
  // SMART_BACKFILL_TIMING flag is unset/off `prepareQuietWindowGate` does no
  // Mongo read and emits no logging, and `shopsToRun === shops` —
  // byte-for-byte the previous behavior. In observe mode it logs the
  // would-ALLOW/would-BLOCK decision per shop; only enforce mode defers
  // out-of-quiet-window shops (respecting the SMART_BACKFILL_TIMING_SHOP_IDS
  // canary allowlist and the confidence floor — low-confidence shops fall
  // back to the generic schedule and are never starved). Deferred shops are
  // simply not handled this tick and naturally count toward shopsRemaining,
  // so the next tick picks them up.
  const quietGate = await prepareQuietWindowGate(
    shops.map((s) => Number(s.shopId)),
  );
  const shopsToRun =
    quietGate.mode === "off"
      ? shops
      : shops.filter(
          (shop) =>
            !applyQuietWindowGate(quietGate, Number(shop.shopId), "tekmetric")
              .shouldSkip,
        );

  const results: any[] = [];

  // ── Pass 1: fast queue hand-off (Task #513 fairness fix) ───────────
  // Enqueue EVERY queue-enabled shop before spending any of the tick
  // budget on in-process work. Enqueuing is a couple of O(1) Redis
  // writes (deduped by the `tekmetric-fullpage:<shopId>` jobId), so it
  // can never blow the deadline — and doing it up front guarantees
  // allowlisted shops always reach the queue even when a backlog of
  // giant in-process shops would otherwise eat the whole budget first.
  //
  // Why this is its own pass: with the hand-off interleaved into the
  // single fairness-ordered loop, an early giant's chunk overran its
  // per-shop slice and consumed the entire ~270s budget, so the loop
  // hit the deadline and `break`'d before ever reaching the allowlisted
  // shop further down the order. The canary (River Valley #134) sat at
  // rank 9 of 27 behind six 3k–6k-page giants and was never enqueued —
  // the cron timed out on the first giant every tick. Splitting the
  // hand-off out fixes this for the canary today and for the whole
  // fleet once BACKFILL_QUEUE_ENABLED flips on.
  //
  // Shops that are NOT queue-routed (flag off for them) — or whose
  // enqueue fails because Redis is down / BullMQ rejected it — fall
  // through to `inlineShops` and run in-process below, preserving the
  // fail-open contract.
  const inlineShops: ShopRow[] = [];
  for (const shop of shopsToRun) {
    if (!decideQueueFor(shop.shopId).useQueue) {
      inlineShops.push(shop);
      continue;
    }
    const enq = await enqueueTekmetricFullPage({
      shopId: shop.shopId,
      tekmetricShopId: shop.tekmetricShopId,
      enqueuedAt: new Date().toISOString(),
      trigger: "cron",
    });
    if (enq.enqueued || enq.reason === "duplicate") {
      results.push({
        shopId: shop.shopId,
        name: shop.name,
        ok: true,
        routedTo: "queue",
        jobId: enq.enqueued ? enq.jobId : undefined,
        duplicate: !enq.enqueued && enq.reason === "duplicate",
      });
      continue;
    }
    // queue_unavailable — fall back to the in-process path for this shop.
    console.warn(
      `[Tekmetric Full-Page Cron] Shop ${shop.shopId}: queue unavailable (${enq.reason}), falling back to in-process path`,
    );
    inlineShops.push(shop);
  }

  // ── Pass 2: in-process drain for shops not routed to the queue ─────
  // Giant shops get at most MAX_GIANTS_PER_TICK slices per tick (see the
  // knob comments up top). Counter is per-tick, reset each GET.
  let giantsProcessed = 0;
  for (const shop of inlineShops) {
    // Conservative-fallback gate (task #1072): shops WITHOUT a confident
    // activity profile (no_profile / low_confidence / no_quiet_window — i.e.
    // exactly the brand-new shops whose initial catch-up is the heaviest
    // work) must never run this INLINE lane on the web instance outside a
    // conservative default quiet window (01:00–06:00 shop-local, Central
    // when unknown). The queue hand-off above is intentionally NOT gated by
    // this — the BullMQ worker lane doesn't touch web p95. Confident-profile
    // shops are untouched (their call was already made by the standard gate
    // in `shopsToRun`). OFF/observe modes never skip, same as the standard
    // gate, and deferred shops count toward shopsRemaining so the night
    // ticks pick them up.
    const fallbackGate = applyConservativeFallbackGate(
      quietGate,
      Number(shop.shopId),
      "tekmetric-fullpage",
    );
    if (fallbackGate.shouldSkip) {
      results.push({
        shopId: shop.shopId,
        name: shop.name,
        ok: true,
        skipped: true,
        reason: "fallback_outside_conservative_window",
      });
      continue;
    }
    if (Date.now() >= deadlineMs) {
      console.log(
        `[Tekmetric Full-Page Cron] Deadline reached after ${results.length} shop(s) handled (${inlineShops.length} eligible for in-process this tick)`,
      );
      break;
    }
    // Giant-shop lane: a shop whose pre-pass is known to be huge gets at
    // most MAX_GIANTS_PER_TICK slices per tick so it can't crowd out the
    // smaller shops behind it. prePassTotalPages is 0 until the pre-pass
    // reports a page count, so a never-measured shop is treated as normal
    // (and re-classified next tick once its size is known).
    const isGiant = (shop.prePassTotalPages || 0) >= GIANT_PREPASS_PAGES;
    if (isGiant && giantsProcessed >= MAX_GIANTS_PER_TICK) {
      results.push({
        shopId: shop.shopId,
        name: shop.name,
        ok: true,
        skipped: true,
        reason: "giant_deferred",
      });
      continue;
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
    if (isGiant) giantsProcessed += 1;
    try {
      // Per-shop time slice: bound how long this single shop may run so its
      // pre-pass can't consume the whole tick. The chunk honours
      // min(its own soft budget, this deadline), so control returns here in
      // time to give the next shop a turn.
      const shopDeadlineMs = Math.min(
        deadlineMs,
        Date.now() + PER_SHOP_SLICE_MS,
      );
      const result = await runForShop(db, shop, lock.owner, shopDeadlineMs);
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

  // Task #513: feature-flagged queue hand-off for manual POST triggers,
  // same contract as the GET cron path above. When the flag is on for
  // this shop, the request returns 202 immediately and the worker
  // picks up the chunk. Operators see the job in `/platform-admin/queues`.
  const queueDecision = decideQueueFor(targetShopId);
  if (queueDecision.useQueue) {
    const enq = await enqueueTekmetricFullPage({
      shopId: targetShopId,
      tekmetricShopId,
      enqueuedAt: new Date().toISOString(),
      trigger: "admin",
    });
    if (enq.enqueued) {
      return NextResponse.json(
        {
          ok: true,
          routedTo: "queue",
          jobId: enq.jobId,
          shopId: targetShopId,
          message: `Enqueued to ${enq.queue} queue. Track progress at /platform-admin/queues.`,
        },
        { status: 202 },
      );
    }
    if (enq.reason === "duplicate") {
      return NextResponse.json(
        {
          ok: true,
          routedTo: "queue",
          duplicate: true,
          shopId: targetShopId,
          message: `A job is already queued or in-flight for shop ${targetShopId}. See /platform-admin/queues.`,
        },
        { status: 202 },
      );
    }
    console.warn(
      `[Tekmetric Full-Page POST] Shop ${targetShopId}: queue unavailable (${enq.reason}), falling back to in-process path`,
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
        deadlineMs,
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
