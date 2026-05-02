import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getViewedVinCount, trackViewedVin } from "@/lib/plan-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Task #271: VIN-based gating removed. Plan pages always render.
// We still record every (shopId, vin, roNumber) view in `viewed_vins` so
// admins can see a running "VINs viewed: N" total.

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

    const shopId = Number(session.shopId);
    const db = await getDb();

    const { count, isNew } = await trackViewedVin(db, shopId, vin.toUpperCase(), normalizedRoId);

    return NextResponse.json({
      ok: true,
      allowed: true,
      viewedCount: count,
      isNewView: isNew,
      requiresUpgrade: false,
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
    const count = await getViewedVinCount(db, shopId);

    return NextResponse.json({
      ok: true,
      viewedCount: count,
      requiresUpgrade: false,
    });
  } catch (err) {
    console.error("Error getting trial status:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
