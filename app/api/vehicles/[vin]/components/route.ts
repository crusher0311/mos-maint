import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    { projection: { hasComponents: 1 } }
  );

  return NextResponse.json({
    ok: true,
    hasComponents: vehicle?.hasComponents || {},
  });
}

export async function PATCH(
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
  const { componentKey, hasComponent } = body;

  if (!componentKey || typeof hasComponent !== "boolean") {
    return NextResponse.json(
      { error: "componentKey and hasComponent (boolean) required" },
      { status: 400 }
    );
  }

  const result = await db.collection("vehicles").updateOne(
    { 
      $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
      vin: vin.toUpperCase() 
    },
    {
      $set: {
        [`hasComponents.${componentKey}`]: hasComponent,
        updatedAt: new Date(),
      },
    }
  );

  if (result.matchedCount === 0) {
    return NextResponse.json(
      { error: "Vehicle not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true });
}
