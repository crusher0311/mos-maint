import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db/postgres";
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

  const rows = await sql`
    SELECT declined_services FROM vehicles 
    WHERE shop_id = ${String(shopId)} AND vin = ${vin.toUpperCase()}
    LIMIT 1
  `;

  return NextResponse.json({
    ok: true,
    declinedServices: rows[0]?.declined_services || [],
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

  const body = await req.json();
  const { serviceKey, serviceName, mileage, reason } = body;

  if (!serviceKey || !serviceName) {
    return NextResponse.json(
      { error: "serviceKey and serviceName required" },
      { status: 400 }
    );
  }

  const declinedEntry = {
    serviceKey,
    serviceName,
    mileage: mileage || null,
    reason: reason || null,
    declinedAt: new Date().toISOString(),
    declinedBy: session.userId,
  };

  const result = await sql`
    UPDATE vehicles 
    SET declined_services = COALESCE(declined_services, '[]'::jsonb) || ${JSON.stringify(declinedEntry)}::jsonb,
        updated_at = NOW()
    WHERE shop_id = ${String(shopId)} AND vin = ${vin.toUpperCase()}
    RETURNING id
  `;

  if (result.length === 0) {
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

  const body = await req.json();
  const { serviceKey } = body;

  if (!serviceKey) {
    return NextResponse.json({ error: "serviceKey required" }, { status: 400 });
  }

  await sql`
    UPDATE vehicles 
    SET declined_services = (
      SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
      FROM jsonb_array_elements(COALESCE(declined_services, '[]'::jsonb)) elem
      WHERE elem->>'serviceKey' != ${serviceKey}
    ),
    updated_at = NOW()
    WHERE shop_id = ${String(shopId)} AND vin = ${vin.toUpperCase()}
  `;

  return NextResponse.json({ ok: true });
}
