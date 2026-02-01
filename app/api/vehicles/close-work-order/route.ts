import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { sql } from "@/lib/db/postgres";

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

  const rows = await sql`
    SELECT id, status FROM vehicles 
    WHERE shop_id = ${String(shopId)} AND vin = ${vin.toUpperCase()}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  }

  const vehicle = rows[0];
  const status = (vehicle.status as any) || {};
  const existingSources = status.sources || [];
  
  const updatedSources = existingSources.filter(
    (s: any) => !(s.provider === provider && String(s.workOrderId) === String(workOrderId))
  );

  const hasActiveSources = updatedSources.length > 0;

  const newStatus = {
    ...status,
    active: hasActiveSources,
    sources: updatedSources,
    updatedAt: new Date().toISOString(),
    ...(hasActiveSources ? {} : { lastClosedAt: new Date().toISOString() }),
  };

  await sql`
    UPDATE vehicles 
    SET status = ${JSON.stringify(newStatus)}::jsonb, updated_at = NOW()
    WHERE id = ${vehicle.id}
  `;

  return NextResponse.json({
    ok: true,
    vin,
    active: hasActiveSources,
    remainingSources: updatedSources.length,
  });
}
