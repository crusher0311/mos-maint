import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = session.shopId;
  const body = await req.json();
  const { vin, workOrderId, provider } = body;

  if (!vin || !workOrderId || !provider) {
    return NextResponse.json(
      { error: "Missing required fields: vin, workOrderId, provider" },
      { status: 400 }
    );
  }

  const db = await getDb();

  const vehicle = await db.collection("vehicles").findOne({
    $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
    vin: vin.toUpperCase(),
  });

  if (!vehicle) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  }

  const existingSources = vehicle.status?.sources || [];
  
  const updatedSources = existingSources.filter(
    (s: any) => !(s.provider === provider && String(s.workOrderId) === String(workOrderId))
  );

  const hasActiveSources = updatedSources.length > 0;

  await db.collection("vehicles").updateOne(
    { _id: vehicle._id },
    {
      $set: {
        "status.active": hasActiveSources,
        "status.sources": updatedSources,
        "status.updatedAt": new Date(),
        ...(hasActiveSources ? {} : { "status.lastClosedAt": new Date() }),
      },
    }
  );

  return NextResponse.json({
    ok: true,
    vin,
    active: hasActiveSources,
    remainingSources: updatedSources.length,
  });
}
