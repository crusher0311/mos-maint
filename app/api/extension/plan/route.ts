import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getUserShopIds } from "@/lib/extension-auth";
import { resolveCarfaxConfig, fetchCarfaxWithCache } from "@/lib/integrations/carfax";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

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

async function runOnDemandAnalysis(shopId: number, vin: string, mileage: number | null) {
  const db = await getDb();
  
  console.log(`[Extension] Running on-demand analysis for VIN ${vin}, shop ${shopId}`);
  
  let carfax: any = { ok: false };
  try {
    const carfaxCfg = await resolveCarfaxConfig(shopId);
    if (carfaxCfg.configured) {
      carfax = await fetchCarfaxWithCache(shopId, vin, 7 * 24 * 60 * 60 * 1000);
    }
  } catch (e) {
    console.warn('[Extension] CARFAX fetch failed:', e);
  }

  let oem: any[] = [];
  try {
    oem = await getLocalOeFromMongo(vin);
  } catch (e) {
    console.warn('[Extension] OEM data fetch failed:', e);
  }

  const recommendations: any[] = [];
  const currentMileage = mileage || 0;

  if (oem.length > 0) {
    for (const interval of oem) {
      if (interval.service_items && Array.isArray(interval.service_items)) {
        for (const service of interval.service_items) {
          const serviceName = service.service_name || service.name || service;
          if (typeof serviceName !== 'string') continue;
          
          const dueMileage = interval.mileage || 0;
          const isOverdue = currentMileage > dueMileage;
          const isDueSoon = !isOverdue && (dueMileage - currentMileage) <= 5000;
          
          recommendations.push({
            service: serviceName,
            dueMileage,
            interval: interval.mileage,
            source: "oe",
            isOverdue,
            isDueSoon,
            status: isOverdue ? "overdue" : isDueSoon ? "due_soon" : "upcoming"
          });
        }
      }
    }
  }

  if (carfax.ok && carfax.data?.serviceHistory) {
    const serviceHistory = carfax.data.serviceHistory || [];
    const commonServices = ["Oil Change", "Tire Rotation", "Brake Inspection", "Air Filter", "Transmission Service"];
    
    for (const serviceName of commonServices) {
      const lastService = serviceHistory.find((s: any) => 
        s.service?.toLowerCase().includes(serviceName.toLowerCase())
      );
      
      if (!lastService) {
        const existing = recommendations.find(r => 
          r.service.toLowerCase().includes(serviceName.toLowerCase())
        );
        if (!existing) {
          recommendations.push({
            service: serviceName,
            source: "carfax",
            status: "recommended",
            reason: "No recent service history found"
          });
        }
      }
    }
  }

  const uniqueRecs = recommendations.reduce((acc: any[], rec) => {
    const exists = acc.find(r => r.service.toLowerCase() === rec.service.toLowerCase());
    if (!exists) acc.push(rec);
    return acc;
  }, []);

  await db.collection("maintenance_analysis_cache").updateOne(
    { vin: vin.toUpperCase(), shopId },
    {
      $set: {
        vin: vin.toUpperCase(),
        shopId,
        recommendations: uniqueRecs,
        analyzedAt: new Date(),
        source: "extension_on_demand",
        mileageAtAnalysis: currentMileage
      }
    },
    { upsert: true }
  );

  console.log(`[Extension] Analysis complete: ${uniqueRecs.length} recommendations for VIN ${vin}`);
  
  return uniqueRecs;
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const smsShopId = searchParams.get("shopId");
    let vin = searchParams.get("vin");
    const roId = searchParams.get("roId");
    const provider = searchParams.get("provider") || "tekmetric";
    const forceRefresh = searchParams.get("refresh") === "true";

    if (!smsShopId) {
      return NextResponse.json(
        { error: "shopId is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    const db = await getDb();
    const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    let mosShopId: number | null = null;
    
    if (provider === "tekmetric") {
      const query: any = { "tekmetric.shopId": parseInt(smsShopId) };
      if (!isPlatformAdmin) {
        query.shopId = { $in: userShopIds };
      }
      const shop = await db.collection("shops").findOne(query);
      if (shop) {
        mosShopId = shop.shopId;
      }
    } else if (provider === "protractor") {
      const query: any = { "protractor.connectionId": smsShopId };
      if (!isPlatformAdmin) {
        query.shopId = { $in: userShopIds };
      }
      const shop = await db.collection("shops").findOne(query);
      if (shop) {
        mosShopId = shop.shopId;
      }
    }

    if (!mosShopId) {
      return NextResponse.json(
        { error: `No accessible shop configured for ${provider}` },
        { status: 404, headers: corsHeaders }
      );
    }

    let vehicle = null;
    let mileage = null;

    if (roId && !vin) {
      let workOrder = null;
      
      if (provider === "tekmetric") {
        workOrder = await db.collection("tekmetric_work_orders").findOne({
          shopId: { $in: [String(mosShopId), Number(mosShopId)] },
          $or: [
            { workOrderId: roId },
            { workOrderId: String(roId) },
            { roNumber: roId },
            { roNumber: parseInt(roId) }
          ]
        });
      } else {
        workOrder = await db.collection("work_orders").findOne({
          shopId: mosShopId,
          $or: [
            { smsRoId: roId },
            { smsRoId: parseInt(roId) },
            { roNumber: roId },
            { roNumber: parseInt(roId) }
          ]
        });
      }
      
      if (workOrder?.vin) {
        vin = workOrder.vin;
        mileage = workOrder.mileageIn || workOrder.mileage || workOrder.odometerIn;
      }
    }

    if (vin) {
      vehicle = await db.collection("vehicles").findOne({
        vin: vin.toUpperCase(),
        shopId: mosShopId
      });

      if (vehicle) {
        mileage = mileage || vehicle.currentMileage || vehicle.mileage || vehicle.lastMileage;
      }
    }

    if (!vin) {
      return NextResponse.json({
        vehicle: null,
        mileage: null,
        overdue: [],
        dueSoon: [],
        recommended: [],
        message: "VIN not available for this repair order"
      }, { headers: corsHeaders });
    }

    let analysisData: any = await db.collection("maintenance_analysis_cache").findOne({
      vin: vin.toUpperCase(),
      shopId: mosShopId
    });

    const analysisAge = analysisData?.analyzedAt 
      ? Date.now() - new Date(analysisData.analyzedAt).getTime()
      : Infinity;
    const maxAge = 24 * 60 * 60 * 1000;

    if (!analysisData || forceRefresh || analysisAge > maxAge) {
      try {
        const recommendations = await runOnDemandAnalysis(mosShopId, vin, mileage);
        analysisData = { recommendations };
      } catch (e) {
        console.error("[Extension] On-demand analysis failed:", e);
      }
    }

    const plan = {
      overdue: [] as any[],
      dueSoon: [] as any[],
      recommended: [] as any[]
    };

    if (analysisData?.recommendations) {
      for (const rec of analysisData.recommendations) {
        const item = {
          name: rec.service || rec.name,
          dueAt: rec.dueMileage,
          interval: rec.interval,
          source: rec.source || "oe",
          priority: rec.priority,
          laborHours: rec.laborHours || 1,
          parts: rec.parts || [],
          reason: rec.reason
        };

        if (rec.status === "overdue" || rec.isOverdue) {
          plan.overdue.push(item);
        } else if (rec.status === "due_soon" || rec.isDueSoon) {
          plan.dueSoon.push(item);
        } else {
          plan.recommended.push(item);
        }
      }
    }

    return NextResponse.json({
      vehicle: vehicle ? {
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        vin: vehicle.vin
      } : vin ? { vin: vin.toUpperCase() } : null,
      mileage,
      overdue: plan.overdue,
      dueSoon: plan.dueSoon,
      recommended: plan.recommended,
      analyzed: !!analysisData
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error("[Extension Plan] Error:", error);
    return NextResponse.json(
      { error: "Failed to load plan" },
      { status: 500, headers: corsHeaders }
    );
  }
}
