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

// Map OEM service names to shop interval keys
const SERVICE_KEY_PATTERNS: Record<string, RegExp[]> = {
  oil: [/oil change/i, /engine oil/i, /oil filter/i, /oil and filter/i],
  tire_rotation: [/tire rotation/i, /rotate tire/i],
  cabin_air: [/cabin air/i, /cabin filter/i],
  engine_air: [/air filter/i, /engine air/i],
  coolant: [/coolant/i, /antifreeze/i, /radiator flush/i],
  trans_auto: [/automatic trans/i, /atf/i, /auto trans/i],
  trans_manual: [/manual trans/i, /mtf/i],
  transfer_case: [/transfer case/i],
  differential: [/differential/i],
  serpentine_belt: [/serpentine/i, /drive belt/i],
  fuel_system: [/fuel system/i, /fuel injection/i, /injector clean/i],
  fuel_filter: [/fuel filter/i],
  brake_pads: [/brake pad/i, /brake lining/i, /brake shoe/i],
  power_steering: [/power steering/i],
  battery: [/battery/i],
  ac_refrigerant: [/a\/c/i, /refrigerant/i, /ac refr/i],
};

function mapServiceToKey(serviceName: string): string | null {
  const name = serviceName?.toLowerCase() || '';
  for (const [key, patterns] of Object.entries(SERVICE_KEY_PATTERNS)) {
    if (patterns.some(p => p.test(name))) {
      return key;
    }
  }
  return null;
}

type LastPerformedInfo = {
  source: 'shop' | 'external' | 'unknown';
  date?: Date;
  mileage?: number;
};

function getLastPerformedInfo(
  serviceName: string,
  shopWorkOrders: any[],
  carfaxRecords: any[] | null
): LastPerformedInfo {
  const serviceKey = mapServiceToKey(serviceName);
  if (!serviceKey) {
    return { source: 'unknown' };
  }
  
  let shopLastDone: { date?: Date; mileage?: number } | null = null;
  let carfaxLastDone: { date?: Date; mileage?: number } | null = null;
  
  // Check shop work orders for this service (already preloaded)
  const servicePatterns = SERVICE_KEY_PATTERNS[serviceKey];
  if (servicePatterns && shopWorkOrders.length > 0) {
    for (const wo of shopWorkOrders) {
      // Jobs are stored in wo.data.jobs (canonical) or wo.jobs (fallback for legacy documents)
      const jobs = wo.data?.jobs ?? wo.jobs ?? [];
      for (const job of jobs) {
        const jobName = job.name || job.description || '';
        if (servicePatterns.some(p => p.test(jobName))) {
          shopLastDone = {
            date: wo.completedDate ? new Date(wo.completedDate) : undefined,
            mileage: wo.odometer ?? wo.data?.milesOut ?? wo.data?.milesIn
          };
          break;
        }
      }
      if (shopLastDone) break;
    }
  }
  
  // Check CARFAX records
  if (carfaxRecords?.length && servicePatterns) {
    for (const record of carfaxRecords) {
      const desc = record.description || '';
      if (servicePatterns.some(p => p.test(desc))) {
        carfaxLastDone = {
          date: record.date ? new Date(record.date) : undefined,
          mileage: record.odometer
        };
        break;
      }
    }
  }
  
  // Determine which is more recent
  if (shopLastDone && carfaxLastDone) {
    if (shopLastDone.date && carfaxLastDone.date) {
      if (shopLastDone.date >= carfaxLastDone.date) {
        return { source: 'shop', ...shopLastDone };
      } else {
        return { source: 'external', ...carfaxLastDone };
      }
    }
    // If no dates, prefer shop
    return { source: 'shop', ...shopLastDone };
  } else if (shopLastDone) {
    return { source: 'shop', ...shopLastDone };
  } else if (carfaxLastDone) {
    return { source: 'external', ...carfaxLastDone };
  }
  
  return { source: 'unknown' };
}

type ShopIntervals = Record<string, { useShop: boolean; miles: number | null; months: number | null }>;

async function runOnDemandAnalysis(
  shopId: number, 
  vin: string, 
  mileage: number | null, 
  showInspectItems: boolean = true,
  shopIntervals: ShopIntervals = {},
  carfaxRecords: any[] | null = null
) {
  const db = await getDb();
  
  const currentMileage = mileage || 0;
  console.log(`[Extension] Running analysis for VIN ${vin}, shop ${shopId}, mileage ${currentMileage}, showInspect=${showInspectItems}`);
  
  const SOON_MILES = 3000; // Same as dashboard
  const recommendations: any[] = [];
  
  // Preload shop work orders ONCE for this vehicle (for performance)
  let shopWorkOrders: any[] = [];
  try {
    shopWorkOrders = await db.collection("tekmetric_work_orders").find({
      shopId: Number(shopId),
      vin: vin.toUpperCase()
    }).sort({ completedDate: -1 }).limit(50).toArray();
    console.log(`[Extension] Preloaded ${shopWorkOrders.length} work orders for VIN ${vin}`);
  } catch (e) {
    console.warn('[Extension] Error preloading shop work orders:', e);
  }

  // Fetch OEM maintenance schedule using the working DataOne API
  try {
    const oemResult = await getMaintenanceScheduleCached(vin);
    console.log(`[Extension] OEM data: ${oemResult.count} items, source: ${oemResult.source}`);
    
    if (oemResult.ok && oemResult.items?.length > 0) {
      for (const item of oemResult.items) {
        const oemIntervalMiles = item.miles || 0;
        const oemIntervalMonths = item.months || null;
        
        // Skip items with no mileage interval
        if (!oemIntervalMiles) continue;
        
        // Filter inspect items if preference is set
        if (!showInspectItems && isInspectItem(item.maintenance_name)) {
          continue;
        }
        
        // Determine where service was last performed (uses preloaded data)
        const lastPerformed = getLastPerformedInfo(item.maintenance_name, shopWorkOrders, carfaxRecords);
        const serviceKey = mapServiceToKey(item.maintenance_name);
        
        // Decide which interval to use based on last performed location
        let intervalMiles = oemIntervalMiles;
        let intervalMonths = oemIntervalMonths;
        let intervalSource = 'oem';
        
        // Use shop intervals only if:
        // 1. Service was last done at shop, AND
        // 2. Shop has custom intervals configured for this service
        if (lastPerformed.source === 'shop' && serviceKey && shopIntervals[serviceKey]?.useShop) {
          const shopInterval = shopIntervals[serviceKey];
          if (shopInterval.miles) {
            intervalMiles = shopInterval.miles;
            intervalMonths = shopInterval.months;
            intervalSource = 'shop';
          }
        }
        
        // Calculate nextDueMileage based on actual last performed mileage when available
        let nextDueMileage: number;
        if (lastPerformed.mileage && lastPerformed.mileage > 0) {
          // Use actual service history: next due = last performed + interval
          nextDueMileage = lastPerformed.mileage + intervalMiles;
        } else if (currentMileage > 0) {
          // Fallback: assume service was done at interval multiples from 0
          const intervalsPassed = Math.floor(currentMileage / intervalMiles);
          nextDueMileage = (intervalsPassed + 1) * intervalMiles;
        } else {
          nextDueMileage = intervalMiles;
        }
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
        
        // Format interval text based on source
        const sourceLabel = intervalSource === 'shop' ? 'Shop' : 'OEM';
        const intervalText = `${sourceLabel}: ${formatIntervalText(intervalMiles, intervalMonths || undefined)}`;
        
        recommendations.push({
          service: item.maintenance_name,
          category: item.maintenance_category,
          dueMileage: nextDueMileage,
          interval: intervalMiles,
          intervalMonths,
          intervalText,
          intervalSource, // 'shop' or 'oem'
          lastPerformedBy: lastPerformed.source,
          lastPerformedMileage: lastPerformed.mileage,
          milesToGo,
          source: intervalSource === 'shop' ? 'shop' : 'oe',
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
    
    // Get shop maintenance intervals
    const shopIntervals: ShopIntervals = shopDoc?.maintenance?.intervals || {};

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
        
        // If not found in cache, fetch directly from Tekmetric API
        if (!workOrder && shopDoc?.tekmetric?.shopId) {
          console.log(`[Extension] Fetching RO ${roId} directly from Tekmetric API`);
          try {
            const tekApiToken = process.env.TEKMETRIC_API_TOKEN;
            if (tekApiToken) {
              const res = await fetch(`https://shop.tekmetric.com/api/v1/repair-orders/${roId}`, {
                headers: { Authorization: `Bearer ${tekApiToken}` }
              });
              console.log(`[Extension] Tekmetric API response status: ${res.status}`);
              if (res.ok) {
                const data = await res.json();
                console.log(`[Extension] Tekmetric API data: vehicleId=${data?.vehicleId}, vin=${data?.vehicle?.vin || data?.vehicleVin}`);
                if (data) {
                  let roVin = data.vehicle?.vin || data.vehicleVin;
                  const odometer = data.milesIn || data.mileageIn || data.vehicle?.mileage;
                  
                  // If no VIN but we have vehicleId, fetch vehicle details
                  if (!roVin && data.vehicleId) {
                    console.log(`[Extension] Fetching vehicle ${data.vehicleId} from Tekmetric API`);
                    const vehRes = await fetch(`https://shop.tekmetric.com/api/v1/vehicles/${data.vehicleId}`, {
                      headers: { Authorization: `Bearer ${tekApiToken}` }
                    });
                    if (vehRes.ok) {
                      const vehData = await vehRes.json();
                      roVin = vehData?.vin;
                      console.log(`[Extension] Vehicle API returned: vin=${roVin}`);
                    }
                  }
                  
                  workOrder = { vin: roVin, odometer };
                  console.log(`[Extension] Fetched from Tekmetric API: vin=${workOrder.vin}, odometer=${workOrder.odometer}`);
                }
              } else {
                console.log(`[Extension] Tekmetric API returned error: ${res.status} ${res.statusText}`);
              }
            } else {
              console.log(`[Extension] No TEKMETRIC_API_TOKEN available`);
            }
          } catch (e) {
            console.error(`[Extension] Tekmetric API fetch failed:`, e);
          }
        }
        
        if (workOrder) {
          console.log(`[Extension] WO data: vin=${workOrder.vin}, odometer=${workOrder.odometer}`);
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
        // Tekmetric sync stores: vin, odometer (not vehicleVin, mileageIn)
        const wo: any = workOrder;
        vin = wo.vin || wo.vehicleVin;
        mileage = wo.odometer || wo.mileageIn || wo.mileage || wo.odometerIn;
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
        // Fetch CARFAX service history for determining where services were last performed
        let carfaxRecords: any[] | null = null;
        try {
          const carfaxResult = await fetchCarfaxWithCache(mosShopId, vin);
          if (carfaxResult.ok && carfaxResult.serviceRecords?.length) {
            // Sort by date descending (most recent first)
            carfaxRecords = carfaxResult.serviceRecords.sort((a, b) => {
              const dateA = a.date ? new Date(a.date).getTime() : 0;
              const dateB = b.date ? new Date(b.date).getTime() : 0;
              return dateB - dateA;
            });
            console.log(`[Extension] CARFAX: ${carfaxRecords.length} service records`);
          }
        } catch (e) {
          console.warn('[Extension] CARFAX fetch failed (will use OEM intervals):', e);
        }
        
        const recommendations = await runOnDemandAnalysis(
          mosShopId, vin, mileage, showInspectItems, shopIntervals, carfaxRecords
        );
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
          intervalSource: rec.intervalSource || 'oem', // 'shop' or 'oem'
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
