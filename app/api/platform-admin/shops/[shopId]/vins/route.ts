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

    if (action === "setLimit") {
      const limit = Number(value);
      if (isNaN(limit) || limit < 0) {
        return NextResponse.json({ error: "Invalid limit value" }, { status: 400 });
      }

      await db.collection("shops").updateOne(
        { shopId },
        { $set: { trialVinLimit: limit } }
      );

      return NextResponse.json({ ok: true, message: `VIN limit set to ${limit}` });
    }

    if (action === "resetLimit") {
      await db.collection("shops").updateOne(
        { shopId },
        { $unset: { trialVinLimit: "" } }
      );

      return NextResponse.json({ ok: true, message: "VIN limit reset to default" });
    }

    if (action === "resetViews") {
      const result = await db.collection("viewed_vins").deleteMany({ shopId });

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

      const shop = await db.collection("shops").findOne({ shopId });
      const platformSettings = await db.collection("platform_settings").findOne({ key: "trial" });
      const defaultLimit = platformSettings?.vinLimit ?? 10;
      const currentLimit = shop?.trialVinLimit ?? defaultLimit;

      await db.collection("shops").updateOne(
        { shopId },
        { $set: { trialVinLimit: currentLimit + addAmount } }
      );

      return NextResponse.json({ 
        ok: true, 
        message: `Added ${addAmount} VINs (new limit: ${currentLimit + addAmount})` 
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  } catch (err: any) {
    console.error("Shop VIN management error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
