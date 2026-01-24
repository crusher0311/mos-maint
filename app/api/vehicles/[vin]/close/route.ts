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
    const vin = params.vin?.toUpperCase();

    if (!vin) {
      return NextResponse.json({ error: "VIN required" }, { status: 400 });
    }

    const db = await getDb();
    const now = new Date();

    const vehicleQuery = {
      vin,
      $or: [{ shopId }, { shopId: Number(shopId) }]
    };

    const existingVehicle = await db.collection("vehicles").findOne(vehicleQuery);

    if (existingVehicle) {
      await db.collection("vehicles").updateOne(
        { _id: existingVehicle._id },
        {
          $set: {
            "status.active": false,
            "status.closedAt": now,
            "status.lastClosedAt": now,
            updatedAt: now
          }
        }
      );
    } else {
      await db.collection("vehicles").insertOne({
        vin,
        shopId,
        source: "integration",
        status: {
          active: false,
          closedAt: now,
          lastClosedAt: now
        },
        createdAt: now,
        updatedAt: now
      });
    }

    return NextResponse.json({ ok: true, closedAt: now });
  } catch (error: any) {
    console.error("Error closing vehicle:", error);
    return NextResponse.json({ error: error.message || "Failed to close vehicle" }, { status: 500 });
  }
}
