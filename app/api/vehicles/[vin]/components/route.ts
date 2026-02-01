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
    SELECT has_components FROM vehicles 
    WHERE shop_id = ${String(shopId)} AND vin = ${vin.toUpperCase()}
    LIMIT 1
  `;

  return NextResponse.json({
    ok: true,
    hasComponents: rows[0]?.has_components || {},
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

  const body = await req.json();
  const { componentKey, hasComponent } = body;

  if (!componentKey || typeof hasComponent !== "boolean") {
    return NextResponse.json(
      { error: "componentKey and hasComponent (boolean) required" },
      { status: 400 }
    );
  }

  const result = await sql`
    UPDATE vehicles 
    SET has_components = jsonb_set(
      COALESCE(has_components, '{}'::jsonb),
      ${`{${componentKey}}`}::text[],
      ${JSON.stringify(hasComponent)}::jsonb
    ),
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

  return NextResponse.json({ ok: true });
}
