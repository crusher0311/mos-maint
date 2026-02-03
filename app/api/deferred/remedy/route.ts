import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getServerSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession();
    if (!session?.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { vin, deferredId, carfaxDate, carfaxDescription, carfaxLocation } = body;

    if (!vin || !deferredId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const db = await getDb();
    const now = new Date();

    await db.collection("remedied_deferred_work").updateOne(
      { 
        shopId: session.shopId, 
        vin: vin.toUpperCase(), 
        deferredId 
      },
      {
        $set: {
          shopId: session.shopId,
          vin: vin.toUpperCase(),
          deferredId,
          carfaxDate,
          carfaxDescription,
          carfaxLocation,
          remediedAt: now,
          remediedBy: session.userId || session.email || "unknown",
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    await db.collection("plan_cache").deleteOne({
      shopId: session.shopId,
      vin: vin.toUpperCase(),
    });

    console.log(`[Deferred] Marked ${deferredId} as remedied for VIN ${vin} by shop ${session.shopId}`);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[Deferred Remedy] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
