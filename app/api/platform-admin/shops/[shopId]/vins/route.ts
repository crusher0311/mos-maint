import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  const shopId = Number(params.shopId);
  if (isNaN(shopId)) {
    return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
  }

  try {
    const { action, value } = await req.json();
    const db = await getDb();

    // Try to find shop by numeric or string shopId
    const shopQuery = { $or: [{ shopId: shopId }, { shopId: String(shopId) }] };

    if (action === "setLimit") {
      const limit = Number(value);
      if (isNaN(limit) || limit < 0) {
        return NextResponse.json({ error: "Invalid limit value" }, { status: 400 });
      }

      // Check current value first
      const currentShop = await db.collection("shops").findOne(shopQuery);
      console.log(`[VIN Limit] Shop ${shopId} current state:`, JSON.stringify({
        found: !!currentShop,
        billingVinLimit: currentShop?.billing?.vinLimit,
        trialVinLimit: currentShop?.trialVinLimit,
        newLimit: limit
      }));

      // Update billing.vinLimit (takes precedence in display) AND trialVinLimit for consistency
      const result = await db.collection("shops").updateOne(
        shopQuery,
        { $set: { "billing.vinLimit": limit, trialVinLimit: limit } }
      );

      console.log(`[VIN Limit] Set limit for shopId ${shopId}: matched=${result.matchedCount}, modified=${result.modifiedCount}`);

      if (result.matchedCount === 0) {
        return NextResponse.json({ error: "Shop not found" }, { status: 404 });
      }

      return NextResponse.json({ ok: true, message: `VIN limit set to ${limit}` });
    }

    if (action === "resetLimit") {
      const result = await db.collection("shops").updateOne(
        shopQuery,
        { $unset: { trialVinLimit: "", "billing.vinLimit": "" } }
      );

      if (result.matchedCount === 0) {
        return NextResponse.json({ error: "Shop not found" }, { status: 404 });
      }

      return NextResponse.json({ ok: true, message: "VIN limit reset to default" });
    }

    if (action === "resetViews") {
      const result = await db.collection("viewed_vins").deleteMany({ 
        $or: [{ shopId: shopId }, { shopId: String(shopId) }] 
      });

      return NextResponse.json({ 
        ok: true, 
        message: `Reset ${result.deletedCount} viewed VINs` 
      });
    }

    if (action === "addViews") {
      const addAmount = Number(value);
      if (isNaN(addAmount) || addAmount <= 0) {
        return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
      }

      const shop = await db.collection("shops").findOne(shopQuery);
      if (!shop) {
        return NextResponse.json({ error: "Shop not found" }, { status: 404 });
      }
      
      const platformSettings = await db.collection("platform_settings").findOne({ key: "trial" });
      const defaultLimit = platformSettings?.vinLimit ?? 10;
      // Read from billing.vinLimit first (takes precedence), then trialVinLimit
      const currentLimit = shop?.billing?.vinLimit ?? shop?.trialVinLimit ?? defaultLimit;

      const newLimit = currentLimit + addAmount;
      await db.collection("shops").updateOne(
        shopQuery,
        { $set: { "billing.vinLimit": newLimit, trialVinLimit: newLimit } }
      );

      return NextResponse.json({ 
        ok: true, 
        message: `Added ${addAmount} VINs (new limit: ${newLimit})` 
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  } catch (err: any) {
    console.error("Shop VIN management error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
