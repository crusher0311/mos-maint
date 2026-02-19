import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServiceItem } from "@/lib/integrations/protractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const sess = await getSession();
    if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { ownerId, vin, year, make, model, submodel, color, engine, transmission, odometer, licensePlate } = body;

    if (!ownerId) {
      return NextResponse.json({ error: "Owner contact ID is required" }, { status: 400 });
    }

    const shopId = Number(sess.shopId);
    const result = await createServiceItem(shopId, {
      ownerId,
      vin: vin || undefined,
      year: year ? Number(year) : undefined,
      make: make || undefined,
      model: model || undefined,
      submodel: submodel || undefined,
      color: color || undefined,
      engine: engine || undefined,
      transmission: transmission || undefined,
      odometer: odometer ? Number(odometer) : undefined,
      licensePlate: licensePlate || undefined,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      vehicleId: result.vehicleId,
      vehicle: result.vehicle,
    });
  } catch (err: any) {
    console.error("[Create Vehicle] Error:", err);
    return NextResponse.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
