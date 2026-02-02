// app/api/recommended/analyze-stream/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { resolveAutoflowConfig, fetchDviWithCache } from "@/lib/integrations/autoflow";
import { resolveCarfaxConfig, fetchCarfaxWithCache } from "@/lib/integrations/carfax";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toSquish(vin: string) {
  const v = String(vin).toUpperCase().trim();
  return v.slice(0, 8) + v.slice(9, 11);
}

async function getLocalOeFromMongo(vin: string) {
  const db = await getDb();
  const SQUISH = toSquish(vin);

  const pipeline = [
    { $match: { squish: SQUISH } },
    { $project: { _id: 0, squish: 1, vin_maintenance_id: 1, maintenance_id: 1 } },
    {
      $lookup: {
        from: "dataone_lkp_vin_maintenance_interval",
        let: { vmi: "$vin_maintenance_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$vin_maintenance_id", "$$vmi"] } } },
          { $project: { _id: 0, maintenance_interval_id: 1 } },
        ],
        as: "intervals",
      },
    },
    { $unwind: "$intervals" },
    {
      $lookup: {
        from: "dataone_lkp_maintenance_interval",
        let: { mi: "$intervals.maintenance_interval_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$maintenance_interval_id", "$$mi"] } } },
          { $project: { _id: 0, mileage: 1, service_items: 1 } },
        ],
        as: "schedule",
      },
    },
    { $unwind: "$schedule" },
    { $sort: { "schedule.mileage": 1 } },
    {
      $group: {
        _id: null,
        maintenance: { $push: { mileage: "$schedule.mileage", service_items: "$schedule.service_items" } },
      },
    },
    { $project: { _id: 0, maintenance: 1 } },
  ];

  const result = await db.collection("dataone_lkp_squish_maintenance").aggregate(pipeline).toArray();
  return result[0]?.maintenance || [];
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

    const db = await getDb();

    // Create a streaming response
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

          // Get vehicle data
          const vehicle = await db
            .collection("vehicles")
            .findOne(
              { shopId: Number(session.shopId), vin },
              { projection: { year: 1, make: 1, model: 1, vin: 1, lastMileage: 1 } }
            );

          if (!vehicle) {
            sendError("Vehicle not found");
            controller.close();
            return;
          }

          sendProgress("Finding latest repair order...");

          // Get latest RO
          const ros = await db
            .collection("repair_orders")
            .find({ shopId: Number(session.shopId), $or: [{ vin }, { vehicleId: vehicle._id }] })
            .project({ roNumber: 1, updatedAt: 1, createdAt: 1 })
            .sort({ updatedAt: -1, createdAt: -1 })
            .limit(1)
            .toArray();

          const latestRoNumber = ros[0]?.roNumber ?? null;

          sendProgress("Fetching DVI inspection data...");

          // Fetch DVI data
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

          // Fetch CARFAX data
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

          // Fetch OEM data
          let oem: any = [];
          try {
            oem = await getLocalOeFromMongo(vin);
          } catch (e) {
            console.warn('OEM data fetch failed:', e);
            oem = [];
          }

          sendProgress("Running AI analysis...");

          // Call the existing analyzer API
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