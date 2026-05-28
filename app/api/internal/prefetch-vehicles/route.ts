import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INTERNAL_SECRET = process.env.INTERNAL_WORKER_SECRET || "mos-prefetch-worker-2024";

export async function GET(req: Request) {
  const authHeader = req.headers.get("x-internal-secret");
  if (authHeader !== INTERNAL_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const shopId = parseInt(url.searchParams.get("shopId") || "0", 10);
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);

  if (!shopId) {
    return NextResponse.json({ error: "shopId required" }, { status: 400 });
  }

  try {
    const db = await getDb();
    
    // Match both string and number versions of shopId
    const shopIdMatch = { $in: [String(shopId), Number(shopId)] };
    
    // Get vehicles from Protractor work orders.
    //
    // Bugs this rewrite fixes (Nicole/V&F shop 116, 2026-05-28):
    //  1) Legacy non-pipeline `$lookup` over `protractor_vehicles` could
    //     blow Mongo's 100MB aggregation memory ceiling on large shops and
    //     500'd a dozen shops every cycle (25,29,35,50,51,67-72,76,116).
    //     We now pre-bound with $sort+$limit+$project BEFORE the lookup,
    //     use the pipeline form keyed on `vin` (the field actually shared
    //     with `protractor_vehicles`), and set `allowDiskUse:true` as a
    //     belt-and-suspenders cap.
    //  2) Wrong source field names — `upsertProtractorWorkOrderSnapshot`
    //     writes `odometer` (number, no `mileage`) and `serviceItemId`
    //     (not `vehicleId`). The old `mileage > 0` $match therefore
    //     filtered out 100% of rows and the protractor branch quietly
    //     returned 0 for every shop, leaving the dashboard prefetch to
    //     fall back on `cached_plans` only (no new vehicles after
    //     callback). Now we read `odometer` and join by `vin`.
    //  3) One failed aggregate tanked the whole endpoint (→ 500 → the
    //     plan-prefetch worker logged "Failed to get vehicles" and
    //     skipped the shop entirely). Each aggregate is now in its own
    //     try/catch so we degrade gracefully to whatever sources do work.
    let protractorVehicles: any[] = [];
    try {
      protractorVehicles = await db.collection("protractor_work_orders").aggregate([
        {
          $match: {
            shopId: shopIdMatch,
            vin: { $exists: true, $type: "string", $ne: "" },
            // Deliberately NOT filtering by `completed` — prefetch wants
            // any recent VIN, not just open ROs. The dashboard route
            // applies its own workflow-stage filter for the open-RO list.
          },
        },
        { $sort: { fetchedAt: -1, updatedAt: -1 } },
        // Cap BEFORE the lookup — a $lookup over the full WO history of a
        // fat shop is what was OOM'ing the aggregation. Pre-limit is
        // `limit * 5` so high-churn shops (lots of repeat updates for
        // the same VIN) still surface enough unique VINs after $group.
        { $limit: limit * 5 },
        {
          $project: {
            vin: 1,
            odometer: 1,
            fetchedAt: 1,
            updatedAt: 1,
            workOrderId: 1,
          },
        },
        {
          $lookup: {
            from: "protractor_vehicles",
            let: { v: "$vin", sIdNum: Number(shopId), sIdStr: String(shopId) },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $or: [
                        { $eq: ["$shopId", "$$sIdNum"] },
                        { $eq: ["$shopId", "$$sIdStr"] },
                      ]},
                      { $eq: ["$vin", "$$v"] },
                    ],
                  },
                },
              },
              { $limit: 1 },
              { $project: { year: 1, make: 1, model: 1, mileage: 1, odometer: 1 } },
            ],
            as: "vehicleData",
          },
        },
        { $unwind: { path: "$vehicleData", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: "$vin",
            mileage: { $first: { $ifNull: [
              "$odometer",
              { $ifNull: ["$vehicleData.odometer", "$vehicleData.mileage"] },
            ]}},
            year: { $first: "$vehicleData.year" },
            make: { $first: "$vehicleData.make" },
            model: { $first: "$vehicleData.model" },
            updatedAt: { $first: { $ifNull: ["$fetchedAt", "$updatedAt"] } },
          },
        },
        { $match: { mileage: { $ne: null, $gt: 0 } } },
        { $sort: { updatedAt: -1 } },
        { $limit: limit },
      ], { allowDiskUse: true }).toArray();
    } catch (e: any) {
      console.error(`[InternalAPI] Shop ${shopId}: Protractor aggregation failed:`, e?.message || e);
    }
    
    // Get vehicles from Tekmetric work orders - prioritize active (in-shop) vehicles.
    // Each Tekmetric aggregate is in its own try/catch so a failure on one
    // source doesn't take down the whole endpoint (see bug #3 above).
    const TERMINAL_STATUSES = ["Invoice", "Invoiced", "Posted", "Deleted", "Void"];

    let tekmetricActiveVehicles: any[] = [];
    try {
      tekmetricActiveVehicles = await db.collection("tekmetric_work_orders").aggregate([
        {
          $match: {
            shopId: shopIdMatch,
            vin: { $exists: true, $type: "string", $ne: "" },
            status: { $nin: TERMINAL_STATUSES }
          }
        },
        { $sort: { updatedDate: -1 } },
        {
          $group: {
            _id: "$vin",
            mileage: { $first: "$mileageIn" },
            year: { $first: "$vehicleYear" },
            make: { $first: "$vehicleMake" },
            model: { $first: "$vehicleModel" },
            updatedAt: { $first: "$updatedDate" },
            isActive: { $first: { $literal: true } }
          }
        },
        { $match: { mileage: { $exists: true, $ne: null, $gt: 0 } } },
        { $sort: { updatedAt: -1 } },
        { $limit: limit }
      ], { allowDiskUse: true }).toArray();
    } catch (e: any) {
      console.error(`[InternalAPI] Shop ${shopId}: Tekmetric active aggregation failed:`, e?.message || e);
    }

    const activeVins = new Set(tekmetricActiveVehicles.map(v => v._id));

    let tekmetricRecentVehicles: any[] = [];
    try {
      tekmetricRecentVehicles = await db.collection("tekmetric_work_orders").aggregate([
        {
          $match: {
            shopId: shopIdMatch,
            vin: { $exists: true, $type: "string", $ne: "" }
          }
        },
        { $sort: { updatedDate: -1 } },
        {
          $group: {
            _id: "$vin",
            mileage: { $first: "$mileageIn" },
            year: { $first: "$vehicleYear" },
            make: { $first: "$vehicleMake" },
            model: { $first: "$vehicleModel" },
            updatedAt: { $first: "$updatedDate" }
          }
        },
        { $match: { mileage: { $exists: true, $ne: null, $gt: 0 } } },
        { $sort: { updatedAt: -1 } },
        { $limit: limit * 2 }
      ], { allowDiskUse: true }).toArray();
    } catch (e: any) {
      console.error(`[InternalAPI] Shop ${shopId}: Tekmetric recent aggregation failed:`, e?.message || e);
    }

    // Combine: active first, then recent (deduped)
    const tekmetricVehicles = [
      ...tekmetricActiveVehicles,
      ...tekmetricRecentVehicles.filter(v => !activeVins.has(v._id))
    ].slice(0, limit);

    // Combine and dedupe by VIN
    const vinMap = new Map<string, any>();
    
    for (const v of [...protractorVehicles, ...tekmetricVehicles]) {
      const vin = v._id;
      if (!vin || vin.length !== 17) continue;
      
      if (!vinMap.has(vin) || (v.updatedAt && vinMap.get(vin).updatedAt && v.updatedAt > vinMap.get(vin).updatedAt)) {
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
    
    // Also try getting vehicles that were already cached in plans
    let cachedPlans: any[] = [];
    try {
      cachedPlans = await db.collection("cached_plans")
        .find({ shopId: shopIdMatch })
        .sort({ createdAt: -1 })
        .limit(limit)
        .project({ vin: 1, mileage: 1, "plan.vehicle.year": 1, "plan.vehicle.make": 1, "plan.vehicle.model": 1 })
        .toArray();
    } catch (e: any) {
      console.error(`[InternalAPI] Shop ${shopId}: cached_plans read failed:`, e?.message || e);
    }
    
    // Add any vehicles from cached plans that aren't already in our list
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
