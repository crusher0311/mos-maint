import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requireSession } from "@/lib/auth";

export async function POST(
  request: NextRequest,
  { params }: { params: { vin: string } }
) {
  try {
    const session = await requireSession();
    const shopId = String(session.shopId);
    const vin = params.vin;

    if (!vin) {
      return NextResponse.json({ error: "VIN required" }, { status: 400 });
    }

    const db = await getDb();

    const query: any = {
      vin: vin.toUpperCase(),
      $or: [{ shopId }, { shopId: Number(shopId) }]
    };

    const vehicle = await db.collection("vehicles").findOne(query);

    if (!vehicle) {
      return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
    }

    const now = new Date();
    await db.collection("vehicles").updateOne(
      { _id: vehicle._id },
      {
        $set: {
          "status.active": false,
          "status.closedAt": now,
          "status.lastClosedAt": now,
          updatedAt: now
        }
      }
    );

    return NextResponse.json({ ok: true, closedAt: now });
  } catch (error: any) {
    console.error("Error closing vehicle:", error);
    return NextResponse.json({ error: error.message || "Failed to close vehicle" }, { status: 500 });
  }
}
