import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import sql from "@/lib/db/postgres";

export async function GET() {
  try {
    const store = await cookies();
    const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
    if (!sid) {
      return NextResponse.json({ error: "No session" }, { status: 401 });
    }

    const now = new Date();

    const sessRows = await sql`
      SELECT * FROM sessions WHERE token = ${sid} AND expires_at > ${now} LIMIT 1
    `;
    const sess = sessRows[0];
    if (!sess) {
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }

    const userRows = await sql`
      SELECT id, email, role, shop_id FROM users WHERE id = ${sess.user_id} LIMIT 1
    `;
    const user = userRows[0];
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const sampleEventRows = await sql`
      SELECT * FROM events 
      WHERE shop_id = ${user.shop_id} AND provider = 'autoflow'
      LIMIT 1
    `;
    const sampleEvent = sampleEventRows[0];

    const eventWithRORows = await sql`
      SELECT * FROM events 
      WHERE shop_id = ${user.shop_id} 
        AND provider = 'autoflow'
        AND (
          payload->'ticket'->>'roNumber' IS NOT NULL
          OR payload->>'roNumber' IS NOT NULL
          OR ro_number IS NOT NULL
        )
      LIMIT 1
    `;
    const eventWithRO = eventWithRORows[0];

    const rows = await sql`
      SELECT DISTINCT ON (UPPER(COALESCE(vehicle_vin, vin, payload->'vehicle'->>'vin')))
        *,
        UPPER(COALESCE(vehicle_vin, vin, payload->'vehicle'->>'vin')) as vin_norm,
        COALESCE(
          payload->'ticket'->>'roNumber',
          payload->>'roNumber',
          ro_number
        ) as display_ro
      FROM events
      WHERE shop_id = ${user.shop_id} AND provider = 'autoflow'
      ORDER BY UPPER(COALESCE(vehicle_vin, vin, payload->'vehicle'->>'vin')), created_at DESC
      LIMIT 3
    `;

    const totalCountRows = await sql`
      SELECT COUNT(*)::int as count FROM events 
      WHERE shop_id = ${user.shop_id} AND provider = 'autoflow'
    `;
    const totalEvents = totalCountRows[0]?.count || 0;

    return NextResponse.json({
      userShopId: user.shop_id,
      sampleEvent: sampleEvent ? {
        id: sampleEvent.id,
        provider: sampleEvent.provider,
        createdAt: sampleEvent.created_at,
        shopId: sampleEvent.shop_id,
        payload: {
          hasTicket: !!sampleEvent.payload?.ticket,
          ticketFields: sampleEvent.payload?.ticket ? Object.keys(sampleEvent.payload.ticket) : [],
          roNumber: sampleEvent.payload?.ticket?.roNumber,
          payloadRoNumber: sampleEvent.payload?.roNumber,
          directRoNumber: sampleEvent.ro_number
        }
      } : null,
      eventWithRO: eventWithRO ? {
        id: eventWithRO.id,
        roNumber: eventWithRO.payload?.ticket?.roNumber,
        payloadRO: eventWithRO.payload?.roNumber,
        directRO: eventWithRO.ro_number
      } : null,
      processedRows: rows.map((row: any) => ({
        vin: row.vin_norm,
        displayRo: row.display_ro,
        updatedAt: row.updated_at,
        createdAt: row.created_at,
      })),
      totalEvents
    });

  } catch (error: any) {
    console.error("Debug error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
