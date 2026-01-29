import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getCachedPlan, setCachedPlan } from "@/lib/plan-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;
const MAX_VEHICLES_PER_SHOP = 15;
const MAX_CONCURRENT = 3;
const DELAY_BETWEEN_VEHICLES = 500;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function GET(req: NextRequest) {
  if (process.env.DISABLE_PLAN_PREFETCH === "true") {
    return NextResponse.json({ ok: true, message: "Plan prefetch disabled", disabled: true });
  }

  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const db = await getDb();
  
  try {
    const shops = await db.collection("shops")
      .find({ 
        $or: [
          { "protractor.configured": true },
          { "tekmetric.configured": true }
        ]
      })
      .project({ shopId: 1, name: 1 })
      .toArray();

    console.log(`[PlanPrefetch] Starting for ${shops.length} shops`);

    let totalPrefetched = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    const shopResults: { shopId: number; prefetched: number; skipped: number; errors: number }[] = [];

    for (const shop of shops) {
      const shopId = shop.shopId;
      let shopPrefetched = 0;
      let shopSkipped = 0;
      let shopErrors = 0;

      const recentVehicles = await db.collection("repair_orders")
        .aggregate([
          { $match: { shopId: Number(shopId) } },
          { $sort: { createdAt: -1 } },
          { $limit: 200 },
          { $group: { 
            _id: "$vehicle.vin",
            vin: { $first: "$vehicle.vin" },
            mileage: { $first: "$vehicle.odometer" },
            lastSeen: { $first: "$createdAt" }
          }},
          { $match: { vin: { $exists: true, $ne: null, $regex: /^[A-HJ-NPR-Z0-9]{17}$/i } } },
          { $match: { mileage: { $exists: true, $gt: 0 } } },
          { $sort: { lastSeen: -1 } },
          { $limit: MAX_VEHICLES_PER_SHOP }
        ])
        .toArray();

      if (recentVehicles.length === 0) {
        continue;
      }

      for (const vehicle of recentVehicles) {
        const vin = vehicle.vin?.toUpperCase();
        const mileage = vehicle.mileage;

        if (!vin || !mileage) continue;

        const cached = await getCachedPlan(db, vin, shopId, mileage);
        if (cached) {
          shopSkipped++;
          continue;
        }

        try {
          const baseUrl = process.env.RENDER_EXTERNAL_URL || 
                         process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` :
                         'http://localhost:3000';
          
          const response = await fetch(`${baseUrl}/api/plan-build`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vin, shopId, mileage }),
          });

          if (response.ok) {
            shopPrefetched++;
            console.log(`[PlanPrefetch] Shop ${shopId}: Prefetched ${vin}`);
          } else {
            shopErrors++;
            console.log(`[PlanPrefetch] Shop ${shopId}: Failed ${vin} - ${response.status}`);
          }
        } catch (err: any) {
          shopErrors++;
          console.error(`[PlanPrefetch] Shop ${shopId}: Error ${vin}:`, err.message);
        }

        await sleep(DELAY_BETWEEN_VEHICLES);
      }

      if (shopPrefetched > 0 || shopErrors > 0) {
        shopResults.push({ shopId, prefetched: shopPrefetched, skipped: shopSkipped, errors: shopErrors });
      }
      
      totalPrefetched += shopPrefetched;
      totalSkipped += shopSkipped;
      totalErrors += shopErrors;
    }

    const duration = Date.now() - startTime;
    console.log(`[PlanPrefetch] Complete: ${totalPrefetched} prefetched, ${totalSkipped} skipped, ${totalErrors} errors in ${duration}ms`);

    return NextResponse.json({
      ok: true,
      duration: `${duration}ms`,
      summary: {
        totalShops: shops.length,
        totalPrefetched,
        totalSkipped,
        totalErrors,
      },
      shops: shopResults,
    });
  } catch (err: any) {
    console.error("[PlanPrefetch] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
