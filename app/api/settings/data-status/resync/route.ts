import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { detectBackfillProvider } from "@/lib/backfill/trigger";
import { queueResyncRequest } from "@/lib/resync-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Customer-requested re-sync (task #629 follow-on).
//
// A shop user who notices their history looks incomplete can ask us to
// re-pull everything. We only QUEUE the request here — the heavy backfill is
// drained overnight by the daily-all cron so it never slows down the shop
// during the day.
//
// Scoping mirrors the data-status GET: a normal session is locked to its own
// shop; a platform admin may pass `?shopId=` to queue on a shop's behalf.
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const requestedShopId = req.nextUrl.searchParams.get("shopId");
    let shopId = Number(session.shopId);
    let actingAsAdmin = false;

    if (requestedShopId) {
      if (!session.isPlatformAdmin) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const parsed = Number(requestedShopId);
      if (!Number.isFinite(parsed)) {
        return NextResponse.json({ error: "Invalid shopId" }, { status: 400 });
      }
      shopId = parsed;
      actingAsAdmin = true;
    }

    if (!Number.isFinite(shopId)) {
      return NextResponse.json(
        { error: "No shop associated with this session" },
        { status: 400 },
      );
    }

    const db = await getDb();
    const shop = await db
      .collection("shops")
      .findOne({ shopId: { $in: [shopId, String(shopId)] } });

    const provider = detectBackfillProvider(shop);
    if (!provider) {
      return NextResponse.json(
        {
          ok: false,
          status: "no_integration",
          message:
            "There's no connected shop system to re-sync. Connect Protractor, Tekmetric, or Shop-Ware first.",
        },
        { status: 400 },
      );
    }

    const result = await queueResyncRequest(db, {
      shopId,
      provider,
      requestedBy: session.email ?? null,
      source: actingAsAdmin ? "admin" : "customer",
    });

    if (!result.ok && result.status === "cooldown") {
      return NextResponse.json(
        {
          ok: false,
          status: "cooldown",
          message:
            "A re-sync already ran recently. Please try again later — your data also keeps updating automatically.",
          retryAfter: result.retryAfter?.toISOString() ?? null,
        },
        { status: 429 },
      );
    }

    await db.collection("audit_logs").insertOne({
      type: "resync_requested",
      shopId,
      provider,
      source: actingAsAdmin ? "admin" : "customer",
      requestedBy: session.email ?? null,
      result: result.status,
      createdAt: new Date(),
    });

    return NextResponse.json({
      ok: true,
      status: result.status,
      provider,
      scheduledFor: result.request?.scheduledFor?.toISOString?.() ?? null,
      message:
        result.status === "already_queued"
          ? "A re-sync is already scheduled. We'll refresh your full history overnight."
          : "Got it — we'll re-sync your full history overnight so it won't slow down your day.",
    });
  } catch (err: any) {
    console.error("[DataStatus] Re-sync request error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to queue re-sync" },
      { status: 500 },
    );
  }
}
