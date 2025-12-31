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


function isInspectItem(serviceName: string): boolean {
  const name = serviceName?.toLowerCase() || '';
  return name.startsWith('inspect') || 
         name.includes('inspection') || 
         name.startsWith('check ') ||
         name.includes('visual check');
}

function formatIntervalText(intervalMiles: number, intervalMonths?: number): string {
  const parts: string[] = [];
  if (intervalMiles) {
    parts.push(`${intervalMiles.toLocaleString()} mi`);
  }
  if (intervalMonths) {
    parts.push(`${intervalMonths}mo`);
  }
  return parts.join(' / ') || '';
}

async function runOnDemandAnalysis(shopId: number, vin: string, mileage: number | null, showInspectItems: boolean = true) {
  const db = await getDb();
  
  const currentMileage = mileage || 0;
  console.log(`[Extension] Running analysis for VIN ${vin}, shop ${shopId}, mileage ${currentMileage}, showInspect=${showInspectItems}`);
  
  const SOON_MILES = 3000; // Same as dashboard
  const recommendations: any[] = [];

  // Fetch OEM maintenance schedule using the working DataOne API
  try {
    const oemResult = await getMaintenanceScheduleCached(vin);
    console.log(`[Extension] OEM data: ${oemResult.count} items, source: ${oemResult.source}`);
    
    if (oemResult.ok && oemResult.items?.length > 0) {
      for (const item of oemResult.items) {
        const intervalMiles = item.miles || 0;
        const intervalMonths = item.months || null;
        
        // Skip items with no mileage interval
        if (!intervalMiles) continue;
        
        // Filter inspect items if preference is set
        if (!showInspectItems && isInspectItem(item.maintenance_name)) {
          continue;
        }
        
        // Calculate milesToGo: how many miles until next service
        // If current mileage is 139,000 and interval is 7,500:
        // - We've gone through 139000/7500 = 18.5 intervals
        // - Next due at ceil(18.5) * 7500 = 19 * 7500 = 142,500
        // - milesToGo = 142,500 - 139,000 = 3,500
        const intervalsPassed = currentMileage > 0 ? Math.floor(currentMileage / intervalMiles) : 0;
        const nextDueMileage = (intervalsPassed + 1) * intervalMiles;
        const milesToGo = currentMileage > 0 ? nextDueMileage - currentMileage : intervalMiles;
        
        // Determine status based on milesToGo
        let status: string;
        if (currentMileage > 0 && milesToGo <= 0) {
          status = "overdue";
        } else if (currentMileage > 0 && milesToGo <= SOON_MILES) {
          status = "due_soon";
        } else {
          status = "upcoming";
        }
        
        recommendations.push({
          service: item.maintenance_name,
          category: item.maintenance_category,
          dueMileage: nextDueMileage,
          interval: intervalMiles,
          intervalMonths,
          intervalText: `OEM: ${formatIntervalText(intervalMiles, intervalMonths || undefined)}`,
          milesToGo,
          source: "oe",
          status
        });
      }
    }
  } catch (e) {
    console.warn('[Extension] OEM data fetch failed:', e);
  }

  // Deduplicate recommendations by service name
  const uniqueRecs = recommendations.reduce((acc: any[], rec) => {
    const exists = acc.find(r => r.service?.toLowerCase() === rec.service?.toLowerCase());
    if (!exists) acc.push(rec);
    return acc;
  }, []);

  // Sort: overdue first (most overdue), then due_soon, then upcoming
  uniqueRecs.sort((a, b) => {
    const statusOrder: Record<string, number> = { overdue: 0, due_soon: 1, upcoming: 2 };
    const orderDiff = (statusOrder[a.status] ?? 2) - (statusOrder[b.status] ?? 2);
    if (orderDiff !== 0) return orderDiff;
    return (a.milesToGo ?? Infinity) - (b.milesToGo ?? Infinity);
  });

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
        mileageAtAnalysis: currentMileage,
        showInspectItems
      }
    },
    { upsert: true }
  );

  const counts = { overdue: 0, due_soon: 0, upcoming: 0 };
  uniqueRecs.forEach(r => counts[r.status as keyof typeof counts]++);
  console.log(`[Extension] Analysis complete: overdue=${counts.overdue}, dueSoon=${counts.due_soon}, upcoming=${counts.upcoming}`);
  
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
    let shopDoc: any = null;
    
    if (provider === "tekmetric") {
      const query: any = { "tekmetric.shopId": parseInt(smsShopId) };
      if (!isPlatformAdmin) {
        query.shopId = { $in: userShopIds };
      }
      shopDoc = await db.collection("shops").findOne(query);
      if (shopDoc) {
        mosShopId = shopDoc.shopId;
      }
    } else if (provider === "protractor") {
      const query: any = { "protractor.connectionId": smsShopId };
      if (!isPlatformAdmin) {
        query.shopId = { $in: userShopIds };
      }
      shopDoc = await db.collection("shops").findOne(query);
      if (shopDoc) {
        mosShopId = shopDoc.shopId;
      }
    }

    if (!mosShopId) {
      return NextResponse.json(
        { error: `No accessible shop configured for ${provider}` },
        { status: 404, headers: corsHeaders }
      );
    }
    
    // Get shop preferences - showInspectItems defaults to true if not set
    const showInspectItems = shopDoc?.preferences?.showInspectItems !== false;

    let vehicle = null;
    let mileage = null;

    if (roId && !vin) {
      let workOrder = null;
      
      if (provider === "tekmetric") {
        // tekmetric_work_orders uses MOS shopId and workOrderId (Tekmetric RO ID as string)
        workOrder = await db.collection("tekmetric_work_orders").findOne({
          shopId: { $in: [String(mosShopId), Number(mosShopId)] },
          workOrderId: String(roId)
        });
        console.log(`[Extension] Tekmetric WO lookup: mosShopId=${mosShopId}, roId=${roId}, found=${!!workOrder}`);
        if (workOrder) {
          console.log(`[Extension] WO data: vin=${workOrder.vehicleVin}, mileageIn=${workOrder.mileageIn}`);
        }
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
      
      if (workOrder) {
        vin = workOrder.vehicleVin || workOrder.vin;
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

    // Also re-run if showInspectItems preference changed
    const cachedShowInspect = analysisData?.showInspectItems ?? true;
    const prefsChanged = cachedShowInspect !== showInspectItems;
    
    if (!analysisData || forceRefresh || analysisAge > maxAge || prefsChanged) {
      try {
        const recommendations = await runOnDemandAnalysis(mosShopId, vin, mileage, showInspectItems);
        analysisData = { recommendations, showInspectItems };
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
          intervalText: rec.intervalText || `OEM: ${(rec.interval || 0).toLocaleString()} mi`,
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
