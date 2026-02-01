import sql from "@/lib/db/postgres";

export async function getLatestMilesForVin(vin: string): Promise<number | null> {
  const cleanVin = (vin || "").toUpperCase();

  const roRows = await sql`
    SELECT mileage FROM work_orders
    WHERE vin = ${cleanVin}
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT 1
  `;
  const mRO = toPosNum(roRows[0]?.mileage);

  const afRows = await sql`
    SELECT 
      COALESCE(
        payload->'ticket'->>'mileage',
        payload->>'mileage',
        payload->'vehicle'->>'mileage',
        payload->'vehicle'->>'miles',
        payload->'vehicle'->>'odometer'
      )::text as miles
    FROM events
    WHERE UPPER(COALESCE(vehicle_vin, vin, payload->'vehicle'->>'vin')) = ${cleanVin}
      AND (provider = 'autoflow' OR (provider = 'ui' AND type = 'manual_closed'))
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const mAF = toPosNum(afRows[0]?.miles);

  const vehRows = await sql`
    SELECT odometer, last_miles FROM vehicles
    WHERE vin = ${cleanVin}
    LIMIT 1
  `;
  const mVeh = toPosNum(vehRows[0]?.odometer) ?? toPosNum(vehRows[0]?.last_miles);

  return mRO ?? mAF ?? mVeh ?? null;
}

function toPosNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
