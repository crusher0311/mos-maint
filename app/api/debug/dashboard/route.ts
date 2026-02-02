import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const shopParam = url.searchParams.get("shop") ?? "";
  if (!shopParam) {
    return NextResponse.json({ ok: false, error: "missing ?shop" }, { status: 400 });
  }

  const shopIdNum = Number(shopParam);
  const shopIdStr = String(shopParam);
  const db = await getDb();

  // Wide filter:
  // - shopId matches number OR string
  // - exclude obvious closed/appointment
  // - require either vehicle.vin OR lastVin
  const filter = {
    $and: [
      { $or: [{ shopId: shopIdNum }, { shopId: shopIdStr }] },
      { status: { $nin: ["closed", "Close", "CLOSED", "Appointment"] } },
      {
        $or: [
          { "vehicle.vin": { $exists: true, $ne: "" } },
          { lastVin: { $exists: true, $ne: "" } },
        ],
      },
    ],
  };

  const projection = {
    name: 1,
    status: 1,
    lastStatus: 1,
    lastTicketId: 1,
    updatedAt: 1,
    lastVin: 1,
    vehicle: { year: 1, make: 1, model: 1, vin: 1, odometer: 1, license: 1 },
  };

  const coll = db.collection("customers");
  const count = await coll.countDocuments(filter);
  const sample = await coll
    .find(filter, { projection })
    .sort({ updatedAt: -1 })
    .limit(10)
    .toArray();

  return NextResponse.json({
    ok: true,
    shop: shopIdStr,
    count,
    sample,
  });
}
