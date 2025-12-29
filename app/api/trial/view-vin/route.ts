import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { checkAndTrackVin, getViewedVinCount } from "@/lib/plan-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_TRIAL_VIN_LIMIT = 10;

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { vin } = await req.json();
    
    if (!vin || typeof vin !== "string") {
      return NextResponse.json({ error: "VIN required" }, { status: 400 });
    }

    const shopId = Number(session.shopId);
    const db = await getDb();

    const shop = await db.collection("shops").findOne({ shopId });
    const isPaid = shop?.billing?.plan === "professional" || shop?.billing?.plan === "enterprise";

    if (isPaid) {
      return NextResponse.json({
        ok: true,
        allowed: true,
        isPaid: true,
        viewedCount: 0,
        limit: null,
        remaining: null,
        isNewView: false,
        requiresUpgrade: false,
      });
    }

    const platformSettings = await db.collection("platform_settings").findOne({ key: "trial" });
    const defaultLimit = platformSettings?.vinLimit ?? DEFAULT_TRIAL_VIN_LIMIT;
    const shopLimit = shop?.trialVinLimit ?? defaultLimit;

    const { count, isNew, allowed } = await checkAndTrackVin(db, shopId, vin.toUpperCase(), shopLimit);

    const remaining = Math.max(0, shopLimit - count);

    return NextResponse.json({
      ok: true,
      allowed,
      isPaid: false,
      viewedCount: count,
      limit: shopLimit,
      remaining,
      isNewView: isNew,
      requiresUpgrade: !allowed,
    });

  } catch (err) {
    console.error("Error tracking VIN view:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const db = await getDb();

    const shop = await db.collection("shops").findOne({ shopId });
    const isPaid = shop?.billing?.plan === "professional" || shop?.billing?.plan === "enterprise";

    if (isPaid) {
      return NextResponse.json({
        ok: true,
        isPaid: true,
        viewedCount: 0,
        limit: null,
        remaining: null,
      });
    }

    const platformSettings = await db.collection("platform_settings").findOne({ key: "trial" });
    const defaultLimit = platformSettings?.vinLimit ?? DEFAULT_TRIAL_VIN_LIMIT;
    const shopLimit = shop?.trialVinLimit ?? defaultLimit;

    const count = await getViewedVinCount(db, shopId);
    const remaining = Math.max(0, shopLimit - count);

    return NextResponse.json({
      ok: true,
      isPaid: false,
      viewedCount: count,
      limit: shopLimit,
      remaining,
      requiresUpgrade: count >= shopLimit,
    });

  } catch (err) {
    console.error("Error getting trial status:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
