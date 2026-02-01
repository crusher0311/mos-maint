// app/api/dashboard/recent/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import sql from "@/lib/db/postgres";

export const dynamic = "force-dynamic";

type Row = {
  updatedAt?: Date | string | null;
  af?: { status?: string; createdAt?: Date | string; miles?: number | null } | null;
  displayName: string | null;
  displayVehicle: string | null;
  displayVin: string | null;
  displayMiles: number | null;
  displayRo: string | null;
  dviDone: boolean;
};

export async function GET() {
  try {
    const store = await cookies();
    const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
    if (!sid) return NextResponse.json({ items: [] }, { status: 401 });

    const now = new Date();
    const sessRows = await sql`
      SELECT user_id FROM sessions WHERE token = ${sid} AND expires_at > ${now} LIMIT 1
    `;
    if (!sessRows[0]) return NextResponse.json({ items: [] }, { status: 401 });

    const userRows = await sql`
      SELECT email, role, shop_id FROM users WHERE id = ${sessRows[0].user_id} LIMIT 1
    `;
    const user = userRows[0];
    if (!user) return NextResponse.json({ items: [] }, { status: 401 });

    const shopId = String(user.shop_id);

    // Fetch AutoFlow events
    const eventRows = await sql`
      SELECT e.*, 
             COALESCE(e.received_at, e.created_at) as created_at_date,
             UPPER(COALESCE(e.vehicle_vin, e.vin, e.payload->'vehicle'->>'vin')) as vin_norm,
             COALESCE(e.payload->'ticket'->>'status', e.status, e.payload->>'status', e.type) as status_raw
      FROM events e
      WHERE e.shop_id = ${shopId}
        AND e.provider = 'autoflow'
      ORDER BY UPPER(COALESCE(e.vehicle_vin, e.vin, e.payload->'vehicle'->>'vin')) ASC,
               COALESCE(e.received_at, e.created_at) DESC
    `;

    // Group by VIN, get latest per VIN
    const vinGroups = new Map<string, any>();
    for (const e of eventRows) {
      const vin = e.vin_norm;
      if (!vin || typeof vin !== 'string' || vin === '') continue;
      if (!vinGroups.has(vin)) {
        vinGroups.set(vin, e);
      }
    }

    // Filter out closed/appointment statuses and map to display format
    const items: Row[] = [];
    for (const [vin, e] of vinGroups.entries()) {
      const status = e.status_raw || '';
      if (/close|appoint/i.test(status)) continue;

      const payload = e.payload || {};
      const firstName = payload.customer?.firstname || '';
      const lastName = payload.customer?.lastname || '';
      const fullName = `${firstName} ${lastName}`.trim() || payload.customer?.name || null;

      const vYear = payload.vehicle?.year;
      const vMake = payload.vehicle?.make || '';
      const vModel = payload.vehicle?.model || '';
      const displayVehicle = [vYear, vMake, vModel].filter(Boolean).join(' ').trim();

      const miles = payload.ticket?.mileage || payload.mileage || 
                    payload.vehicle?.mileage || payload.vehicle?.miles || 
                    payload.vehicle?.odometer || null;

      const roNumber = payload.ticket?.roNumber || null;

      // Check DVI presence
      let dviDone = false;
      if (roNumber) {
        const dviCheck = await sql`
          SELECT 1 FROM dvi_results WHERE ro_number = ${String(roNumber)} LIMIT 1
        `;
        if (!dviCheck[0]) {
          const dviAltCheck = await sql`
            SELECT 1 FROM dvi WHERE ro_number = ${String(roNumber)} LIMIT 1
          `;
          dviDone = !!dviAltCheck[0];
        } else {
          dviDone = true;
        }
      }

      items.push({
        updatedAt: e.created_at_date,
        displayName: fullName,
        displayVehicle: displayVehicle || null,
        displayVin: vin,
        displayMiles: miles,
        displayRo: roNumber,
        dviDone,
        af: {
          createdAt: e.created_at_date,
          status: e.status_raw,
          miles
        }
      });
    }

    // Sort by updated time desc and limit to 100
    items.sort((a, b) => {
      const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bTime - aTime;
    });

    return NextResponse.json({ items: items.slice(0, 100) });
  } catch (err: any) {
    console.error("dashboard/recent error:", err);
    return NextResponse.json({ items: [], error: err?.message ?? "error" }, { status: 500 });
  }
}
