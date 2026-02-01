import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const shopParam = url.searchParams.get("shop") ?? "";
  if (!shopParam) {
    return NextResponse.json({ ok: false, error: "missing ?shop" }, { status: 400 });
  }

  const shopId = String(shopParam);

  const countResult = await sql`
    SELECT COUNT(*) as count 
    FROM customers 
    WHERE shop_id = ${shopId}
      AND status NOT IN ('closed', 'Close', 'CLOSED', 'Appointment')
      AND (vin IS NOT NULL AND vin != '')
  `;
  const count = Number(countResult[0]?.count) || 0;

  const sample = await sql`
    SELECT id, name, status, last_status, last_ticket_id, updated_at,
           vin, year, make, model, odometer, license
    FROM customers
    WHERE shop_id = ${shopId}
      AND status NOT IN ('closed', 'Close', 'CLOSED', 'Appointment')
      AND (vin IS NOT NULL AND vin != '')
    ORDER BY updated_at DESC
    LIMIT 10
  `;

  const formattedSample = sample.map(c => ({
    _id: c.id,
    name: c.name,
    status: c.status,
    lastStatus: c.last_status,
    lastTicketId: c.last_ticket_id,
    updatedAt: c.updated_at,
    lastVin: c.vin,
    vehicle: {
      year: c.year,
      make: c.make,
      model: c.model,
      vin: c.vin,
      odometer: c.odometer,
      license: c.license,
    }
  }));

  return NextResponse.json({
    ok: true,
    shop: shopId,
    count,
    sample: formattedSample,
  });
}
