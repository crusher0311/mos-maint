import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getUserShopIds } from "@/lib/extension-auth";
import { resolveCarfaxConfig, fetchCarfaxWithCache } from "@/lib/integrations/carfax";
import { getMaintenanceScheduleCached } from "@/lib/integrations/dataone-api";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}


async function runOnDemandAnalysis(shopId: number, vin: string, mileage: number | null) {
  const db = await getDb();
  
  console.log(`[Extension] Running on-demand analysis for VIN ${vin}, shop ${shopId}, mileage ${mileage}`);
  
  const currentMileage = mileage || 0;
  const recommendations: any[] = [];

  // Fetch OEM maintenance schedule using the working DataOne API
  try {
    const oemResult = await getMaintenanceScheduleCached(vin);
    console.log(`[Extension] OEM data: ${oemResult.count} items, source: ${oemResult.source}`);
    
    if (oemResult.ok && oemResult.items?.length > 0) {
      for (const item of oemResult.items) {
        const dueMileage = item.miles || 0;
        const isOverdue = currentMileage > 0 && currentMileage > dueMileage;
        const isDueSoon = !isOverdue && currentMileage > 0 && (dueMileage - currentMileage) <= 5000;
        
        recommendations.push({
          service: item.maintenance_name,
          category: item.maintenance_category,
          dueMileage,
          dueMonths: item.months,
          interval: item.miles,
          source: "oe",
          isOverdue,
          isDueSoon,
          status: isOverdue ? "overdue" : isDueSoon ? "due_soon" : "upcoming"
        });
      }
    }
  } catch (e) {
    console.warn('[Extension] OEM data fetch failed:', e);
  }

  // Also check CARFAX for service history
  try {
    const carfaxCfg = await resolveCarfaxConfig(shopId);
    if (carfaxCfg.configured) {
      const carfax: any = await fetchCarfaxWithCache(shopId, vin, 7 * 24 * 60 * 60 * 1000);
      if (carfax.ok && carfax.data?.serviceHistory) {
        console.log(`[Extension] CARFAX: ${carfax.data.serviceHistory.length} service records`);
      }
    }
  } catch (e) {
    console.warn('[Extension] CARFAX fetch failed:', e);
  }

  // Deduplicate recommendations
  const uniqueRecs = recommendations.reduce((acc: any[], rec) => {
    const exists = acc.find(r => r.service?.toLowerCase() === rec.service?.toLowerCase());
    if (!exists) acc.push(rec);
    return acc;
  }, []);

  // Cache the analysis
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
