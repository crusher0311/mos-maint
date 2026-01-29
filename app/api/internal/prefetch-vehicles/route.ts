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
    
    // Get vehicles from Protractor work orders
    const protractorVehicles = await db.collection("protractor_work_orders").aggregate([
      { 
        $match: { 
          shopId: shopIdMatch,
          vin: { $exists: true, $type: "string", $ne: "" }
        } 
      },
      { $sort: { updatedAt: -1 } },
      {
        $lookup: {
          from: "protractor_vehicles",
          localField: "vehicleId",
          foreignField: "vehicleId",
          as: "vehicleData"
        }
      },
      { $unwind: { path: "$vehicleData", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$vin",
          mileage: { $first: { $ifNull: ["$vehicleData.mileage", "$mileage"] } },
          year: { $first: "$vehicleData.year" },
          make: { $first: "$vehicleData.make" },
          model: { $first: "$vehicleData.model" },
          updatedAt: { $first: "$updatedAt" }
        }
      },
      { $match: { mileage: { $exists: true, $ne: null, $gt: 0 } } },
      { $sort: { updatedAt: -1 } },
      { $limit: limit }
    ]).toArray();
    
    // Get vehicles from Tekmetric work orders - prioritize active (in-shop) vehicles
    const TERMINAL_STATUSES = ["Invoice", "Invoiced", "Posted", "Deleted", "Void"];
    
    // First: Active vehicles (currently in shop)
    const tekmetricActiveVehicles = await db.collection("tekmetric_work_orders").aggregate([
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
    ]).toArray();
    
    const activeVins = new Set(tekmetricActiveVehicles.map(v => v._id));
    
    // Then: Recent vehicles (to fill remaining slots)
    const tekmetricRecentVehicles = await db.collection("tekmetric_work_orders").aggregate([
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
    ]).toArray();
    
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
    const cachedPlans = await db.collection("cached_plans")
      .find({ shopId: shopIdMatch })
      .sort({ createdAt: -1 })
      .limit(limit)
      .project({ vin: 1, mileage: 1, "plan.vehicle.year": 1, "plan.vehicle.make": 1, "plan.vehicle.model": 1 })
      .toArray();
    
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
