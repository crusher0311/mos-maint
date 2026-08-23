import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DeclinedServiceEntry {
  serviceKey: string;
  serviceName?: string;
  mileage: number | null;
  reason: string | null;
  declinedAt: Date;
  declinedBy: string;
}

interface VehicleDeclinedDoc {
  vin?: string;
  shopId?: string | number;
  declinedServices?: DeclinedServiceEntry[];
  updatedAt?: Date;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ vin: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { vin } = await params;
  const shopId = session.shopId;
  const db = await getDb();

  const vehicle = await db.collection("vehicles").findOne(
    { 
      $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
      vin: vin.toUpperCase() 
    },
    { projection: { declinedServices: 1 } }
  );

  return NextResponse.json({
    ok: true,
    declinedServices: vehicle?.declinedServices || [],
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ vin: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { vin } = await params;
  const shopId = session.shopId;
  const db = await getDb();

  const body = await req.json();
  const { serviceKey, serviceName, mileage, reason } = body;

  if (!serviceKey || !serviceName) {
    return NextResponse.json(
      { error: "serviceKey and serviceName required" },
      { status: 400 }
    );
  }

  const declinedEntry: DeclinedServiceEntry = {
    serviceKey,
    serviceName,
    mileage: mileage || null,
    reason: reason || null,
    declinedAt: new Date(),
    declinedBy: session.email,
  };

  const result = await db.collection<VehicleDeclinedDoc>("vehicles").updateOne(
    { 
      $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
      vin: vin.toUpperCase() 
    },
    {
      $push: { declinedServices: declinedEntry },
      $set: { updatedAt: new Date() },
    }
  );

  if (result.matchedCount === 0) {
    return NextResponse.json(
      { error: "Vehicle not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true, entry: declinedEntry });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ vin: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { vin } = await params;
  const shopId = session.shopId;
  const db = await getDb();

  const body = await req.json();
  const { serviceKey } = body;

  if (!serviceKey) {
    return NextResponse.json({ error: "serviceKey required" }, { status: 400 });
  }

  await db.collection<VehicleDeclinedDoc>("vehicles").updateOne(
    { 
      $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
      vin: vin.toUpperCase() 
    },
    {
      $pull: { declinedServices: { serviceKey } },
      $set: { updatedAt: new Date() },
    }
  );

  return NextResponse.json({ ok: true });
}
