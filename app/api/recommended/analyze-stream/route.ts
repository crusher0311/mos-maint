// app/api/recommended/analyze-stream/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { resolveAutoflowConfig, fetchDviWithCache } from "@/lib/integrations/autoflow";
import { resolveCarfaxConfig, fetchCarfaxWithCache } from "@/lib/integrations/carfax";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toSquish(vin: string) {
  const v = String(vin).toUpperCase().trim();
  return v.slice(0, 8) + v.slice(9, 11);
}

async function getLocalOeFromPostgres(vin: string) {
  const SQUISH = toSquish(vin);

  const items = await sql`
    WITH vin_maint AS (
      SELECT DISTINCT lvm.vin_maintenance_id, lvm.maintenance_id
      FROM dataone_lkp_vin_maintenance lvm
      WHERE lvm.squish = ${SQUISH}
    ),
    intervals AS (
      SELECT vm.maintenance_id, lvi.maintenance_interval_id
      FROM vin_maint vm
      JOIN dataone_lkp_vin_maintenance_interval lvi ON lvi.vin_maintenance_id = vm.vin_maintenance_id
    ),
    interval_defs AS (
      SELECT i.maintenance_id, dmi.interval_type, dmi.value, dmi.units, dmi.initial_value
      FROM intervals i
      JOIN dataone_def_maintenance_interval dmi ON dmi.maintenance_interval_id = i.maintenance_interval_id
    ),
    grouped AS (
      SELECT 
        vm.maintenance_id,
        dm.maintenance_name as name,
        dm.maintenance_category as category,
        dm.maintenance_notes as notes,
        MAX(CASE WHEN id.units = 'Miles' THEN id.value END) as miles,
        MAX(CASE WHEN id.units = 'Months' THEN id.value END) as months
      FROM vin_maint vm
      JOIN dataone_def_maintenance dm ON dm.maintenance_id = vm.maintenance_id
      LEFT JOIN interval_defs id ON id.maintenance_id = vm.maintenance_id
      GROUP BY vm.maintenance_id, dm.maintenance_name, dm.maintenance_category, dm.maintenance_notes
    )
    SELECT maintenance_id, name, category, notes, miles, months
    FROM grouped
    ORDER BY category, name
    LIMIT 200
  `;

  return items;
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { vin, model } = await request.json();
    
    if (!vin) {
      return NextResponse.json({ error: "VIN is required" }, { status: 400 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const sendProgress = (progress: string) => {
          const message = `data: ${JSON.stringify({ progress })}\n\n`;
          controller.enqueue(encoder.encode(message));
        };

        const sendResult = (result: any) => {
          const message = `data: ${JSON.stringify({ result })}\n\n`;
          controller.enqueue(encoder.encode(message));
        };

        const sendError = (error: string) => {
          const message = `data: ${JSON.stringify({ error })}\n\n`;
          controller.enqueue(encoder.encode(message));
        };

        try {
          sendProgress("Looking up vehicle information...");

          const vehicleRows = await sql`
            SELECT year, make, model, vin, last_mileage FROM vehicles
            WHERE shop_id = ${String(session.shopId)} AND vin = ${vin.toUpperCase()}
          `;
          const vehicle = vehicleRows[0] as any;

          if (!vehicle) {
            sendError("Vehicle not found");
            controller.close();
            return;
          }

          sendProgress("Finding latest repair order...");

          const roRows = await sql`
            SELECT ro_number, updated_at, created_at FROM work_orders
            WHERE shop_id = ${String(session.shopId)} AND vin = ${vin.toUpperCase()}
            ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
            LIMIT 1
          `;
          const latestRoNumber = (roRows[0] as any)?.ro_number ?? null;

          sendProgress("Fetching DVI inspection data...");

          let dvi: any = { ok: false, error: "Not available" };
          try {
            const autoCfg = await resolveAutoflowConfig(Number(session.shopId));
            if (latestRoNumber && autoCfg.configured) {
              dvi = await fetchDviWithCache(Number(session.shopId), String(latestRoNumber), 10 * 60 * 1000);
            }
          } catch (e) {
            console.warn('DVI fetch failed:', e);
            dvi = { ok: false, error: "Failed to fetch DVI" };
          }

          sendProgress("Fetching CARFAX vehicle history...");

          let carfax: any = { ok: false, error: "Not available" };
          try {
            const carfaxCfg = await resolveCarfaxConfig(Number(session.shopId));
            if (carfaxCfg.configured) {
              carfax = await fetchCarfaxWithCache(Number(session.shopId), vin, 7 * 24 * 60 * 60 * 1000);
            }
          } catch (e) {
            console.warn('CARFAX fetch failed:', e);
            carfax = { ok: false, error: "Failed to fetch CARFAX" };
          }

          sendProgress("Loading OEM maintenance schedule...");

          let oem: any = [];
          try {
            oem = await getLocalOeFromPostgres(vin);
          } catch (e) {
            console.warn('OEM data fetch failed:', e);
            oem = [];
          }

          sendProgress("Running AI analysis...");

          const BASE =
            process.env.NEXT_PUBLIC_BASE_URL ||
            (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

          try {
            const res = await fetch(`${BASE}/api/recommended/analyze`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: model || "gpt-4o",
                dviData: dvi,
                carfaxData: carfax,
                oemData: oem,
              }),
            });

            if (!res.ok) {
              throw new Error(`AI analysis failed: ${res.statusText}`);
            }

            const analyzed = await res.json();

            sendResult({
              ...analyzed,
              vehicle,
              latestRoNumber
            });

          } catch (e: any) {
            console.error('AI analysis failed:', e);
            sendError(e.message || "AI analysis failed");
          }

        } catch (error: any) {
          console.error('Stream error:', error);
          sendError(error.message || "Analysis failed");
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (error: any) {
    console.error("Stream setup error:", error);
    return NextResponse.json({ error: error.message || "Failed to start analysis" }, { status: 500 });
  }
}
