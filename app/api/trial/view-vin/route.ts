import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
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

    const { vin, roId } = await req.json();
    
    if (!vin || typeof vin !== "string") {
      return NextResponse.json({ error: "VIN required" }, { status: 400 });
    }
    
    const normalizedRoId = roId && typeof roId === "string" ? roId.trim() : null;

    const shopId = String(session.shopId);

    const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${shopId}`;
    const shop = shopRows[0] as any;
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

    const platformRows = await sql`SELECT * FROM platform_settings WHERE key = 'trial'`;
    const platformSettings = platformRows[0] as any;
    const defaultLimit = platformSettings?.vin_limit ?? DEFAULT_TRIAL_VIN_LIMIT;
    const shopLimit = shop?.trial_vin_limit ?? defaultLimit;

    const { count, isNew, allowed } = await checkAndTrackVin(Number(shopId), vin.toUpperCase(), shopLimit, normalizedRoId);

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

    const shopId = String(session.shopId);

    const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${shopId}`;
    const shop = shopRows[0] as any;
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

    const platformRows = await sql`SELECT * FROM platform_settings WHERE key = 'trial'`;
    const platformSettings = platformRows[0] as any;
    const defaultLimit = platformSettings?.vin_limit ?? DEFAULT_TRIAL_VIN_LIMIT;
    const shopLimit = shop?.trial_vin_limit ?? defaultLimit;

    const count = await getViewedVinCount(Number(shopId));
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
