import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requireSession } from "@/lib/auth";
import { setShopCarfaxLocationId } from "@/lib/integrations/carfax";
import { invalidateShopPlanCache } from "@/lib/plan-cache";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await requireSession();
    const shopId = Number(session.shopId);

    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { carfax: 1, carfaxLocationId: 1 } }
    );

    const hasUrl = Boolean(process.env.CARFAX_POST_URL);
    const hasPdi = Boolean(process.env.CARFAX_PDI);

    return NextResponse.json({
      locationId: shop?.carfax?.locationId || shop?.carfaxLocationId || "",
      envConfigured: hasUrl && hasPdi,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unexpected error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const shopId = Number(session.shopId);
    const body = await req.json();
    const { locationId } = body || {};

    const db = await getDb();
    const { cleared } = await setShopCarfaxLocationId(db, shopId, locationId);

    return NextResponse.json({ ok: true, cacheCleared: cleared });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unexpected error" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const session = await requireSession();
    const shopId = Number(session.shopId);

    const db = await getDb();
    const existing = await db
      .collection("shops")
      .findOne({ shopId }, { projection: { carfax: 1, carfaxLocationId: 1 } });
    const prevLoc = String(
      existing?.carfax?.locationId || existing?.carfaxLocationId || "",
    ).trim();

    await db.collection("shops").updateOne(
      { shopId },
      {
        $unset: {
          carfax: "",
          carfaxLocationId: "",
        },
        $set: { updatedAt: new Date() },
      }
    );

    // Standardize all CARFAX config transitions: removing CARFAX makes plans
    // that were built WITH service history stale, so clear them too so they
    // rebuild without CARFAX on next view.
    let cleared = null;
    if (prevLoc) {
      cleared = await invalidateShopPlanCache(db, shopId);
    }

    return NextResponse.json({ ok: true, cacheCleared: cleared });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unexpected error" }, { status: 500 });
  }
}
