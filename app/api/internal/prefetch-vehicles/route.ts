import { NextResponse } from "next/server";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INTERNAL_SECRET = process.env.INTERNAL_WORKER_SECRET || "mos-prefetch-worker-2024";

export async function GET(req: Request) {
  const authHeader = req.headers.get("x-internal-secret");
  if (authHeader !== INTERNAL_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const shopId = url.searchParams.get("shopId") || "0";
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);

  if (shopId === "0") {
    return NextResponse.json({ error: "shopId required" }, { status: 400 });
  }

  try {
    const protractorVehicles = await sql`
      WITH ranked_wo AS (
        SELECT DISTINCT ON (pwo.vin)
          pwo.vin,
          COALESCE(pv.mileage, pwo.mileage) as mileage,
          pv.year,
          pv.make,
          pv.model,
          pwo.updated_at
        FROM protractor_work_orders pwo
        LEFT JOIN protractor_vehicles pv ON pwo.vehicle_id = pv.vehicle_id
        WHERE pwo.shop_id = ${shopId}
          AND pwo.vin IS NOT NULL AND pwo.vin != ''
        ORDER BY pwo.vin, pwo.updated_at DESC
      )
      SELECT * FROM ranked_wo 
      WHERE mileage IS NOT NULL AND mileage > 0
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    
    const TERMINAL_STATUSES = ['Invoice', 'Invoiced', 'Posted', 'Deleted', 'Void'];
    
    const tekmetricActiveVehicles = await sql`
      WITH ranked_wo AS (
        SELECT DISTINCT ON (vin)
          vin,
          mileage_in as mileage,
          vehicle_year as year,
          vehicle_make as make,
          vehicle_model as model,
          updated_date as updated_at,
          true as is_active
        FROM tekmetric_work_orders
        WHERE shop_id = ${shopId}
          AND vin IS NOT NULL AND vin != ''
          AND status NOT IN ('Invoice', 'Invoiced', 'Posted', 'Deleted', 'Void')
        ORDER BY vin, updated_date DESC
      )
      SELECT * FROM ranked_wo 
      WHERE mileage IS NOT NULL AND mileage > 0
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    
    const activeVins = new Set(tekmetricActiveVehicles.map((v: any) => v.vin));
    
    const tekmetricRecentVehicles = await sql`
      WITH ranked_wo AS (
        SELECT DISTINCT ON (vin)
          vin,
          mileage_in as mileage,
          vehicle_year as year,
          vehicle_make as make,
          vehicle_model as model,
          updated_date as updated_at
        FROM tekmetric_work_orders
        WHERE shop_id = ${shopId}
          AND vin IS NOT NULL AND vin != ''
        ORDER BY vin, updated_date DESC
      )
      SELECT * FROM ranked_wo 
      WHERE mileage IS NOT NULL AND mileage > 0
      ORDER BY updated_at DESC
      LIMIT ${limit * 2}
    `;
    
    const tekmetricVehicles = [
      ...tekmetricActiveVehicles,
      ...tekmetricRecentVehicles.filter((v: any) => !activeVins.has(v.vin))
    ].slice(0, limit);

    const vinMap = new Map<string, any>();
    
    for (const v of [...protractorVehicles, ...tekmetricVehicles]) {
      const vin = v.vin;
      if (!vin || vin.length !== 17) continue;
      
      if (!vinMap.has(vin) || (v.updated_at && vinMap.get(vin).updated_at && new Date(v.updated_at) > new Date(vinMap.get(vin).updated_at))) {
        vinMap.set(vin, {
          vin,
          mileage: v.mileage,
          year: v.year,
          make: v.make,
          model: v.model
        });
      }
    }

    const rows = Array.from(vinMap.values()).slice(0, limit);
    
    const cachedPlans = await sql`
      SELECT vin, mileage, plan FROM cached_plans
      WHERE shop_id = ${shopId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    
    for (const plan of cachedPlans) {
      if (plan.vin && plan.vin.length === 17 && plan.mileage > 0 && !vinMap.has(plan.vin)) {
        vinMap.set(plan.vin, {
          vin: plan.vin,
          mileage: plan.mileage,
          year: plan.plan?.vehicle?.year,
          make: plan.plan?.vehicle?.make,
          model: plan.plan?.vehicle?.model
        });
      }
    }
    
    const finalRows = Array.from(vinMap.values()).slice(0, limit);
    
    console.log(`[InternalAPI] Shop ${shopId}: Found ${protractorVehicles.length} Protractor, ${tekmetricVehicles.length} Tekmetric, ${cachedPlans.length} cached, returning ${finalRows.length}`);

    return NextResponse.json({ rows: finalRows });
  } catch (error: any) {
    console.error("[InternalAPI] Error fetching vehicles:", error.message);
    return NextResponse.json({ error: "Failed to fetch vehicles" }, { status: 500 });
  }
}
