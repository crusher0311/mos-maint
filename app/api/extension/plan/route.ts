import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getUserShopIds } from "@/lib/extension-auth";
import { resolveCarfaxConfig, fetchCarfaxWithCache } from "@/lib/integrations/carfax";
import { getMaintenanceScheduleCached } from "@/lib/integrations/dataone-api";
import { checkAndTrackVin } from "@/lib/plan-cache";
import { getValidToken } from "@/lib/tekmetric-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";

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
  wheel_alignment: [/wheel alignment/i, /alignment/i, /front end align/i, /4 wheel align/i],
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

type ShopIntervals = Record<string, { useShop: boolean; excluded?: boolean; miles: number | null; months: number | null }>;

interface PrefetchedData {
  oemResult?: Awaited<ReturnType<typeof getMaintenanceScheduleCached>>;
  carfaxRecords?: any[] | null;
  shopWorkOrders?: any[];
}

async function runOnDemandAnalysis(
  shopId: number, 
  vin: string, 
  mileage: number | null, 
  showInspectItems: boolean = true,
  shopIntervals: ShopIntervals = {},
  carfaxRecords: any[] | null = null,
  prefetched?: PrefetchedData
) {
  const db = await getDb();
  
  const currentMileage = mileage || 0;
  console.log(`[Extension] Running analysis for VIN ${vin}, shop ${shopId}, mileage ${currentMileage}, showInspect=${showInspectItems}`);
  
  const SOON_MILES = 3000; // Same as dashboard
  const recommendations: any[] = [];
  
  // Use prefetched work orders or fetch if not provided
  let shopWorkOrders: any[] = prefetched?.shopWorkOrders || [];
  if (!prefetched?.shopWorkOrders) {
    try {
      shopWorkOrders = await db.collection("tekmetric_work_orders").find({
        shopId: Number(shopId),
        vin: vin.toUpperCase()
      }).sort({ completedDate: -1 }).limit(50).toArray();
      console.log(`[Extension] Preloaded ${shopWorkOrders.length} work orders for VIN ${vin}`);
    } catch (e) {
      console.warn('[Extension] Error preloading shop work orders:', e);
    }
  } else {
    console.log(`[Extension] Using prefetched ${shopWorkOrders.length} work orders`);
  }

  // Use prefetched OEM data or fetch if not provided
  try {
    const oemResult = prefetched?.oemResult || await getMaintenanceScheduleCached(vin);
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
        
        // Map to service key first to check exclusion
        const serviceKey = mapServiceToKey(item.maintenance_name);
        
        // Skip excluded services
        if (serviceKey && shopIntervals[serviceKey]?.excluded) {
          continue;
        }
        
        // Determine where service was last performed (uses preloaded data)
        const lastPerformed = getLastPerformedInfo(item.maintenance_name, shopWorkOrders, carfaxRecords);
        
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
          // Legacy fields for backward compatibility
          lastPerformedBy: lastPerformed.source,
          lastPerformedMileage: lastPerformed.mileage,
          // New nested format for extension UI
          last: {
            source: lastPerformed.source, // 'shop', 'external' (CARFAX), or 'unknown'
            miles: lastPerformed.mileage || null,
            date: lastPerformed.date ? lastPerformed.date.toISOString() : null
          },
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
    const providerHint = searchParams.get("provider"); // Optional hint, we verify against actual config
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
    
    // Try to find shop by SMS shop ID across all integration types
    const tekShopIdNum = parseInt(smsShopId);
    const tekShopIdStr = String(smsShopId);
    
    // Build query to find shop by any integration's shop ID
    const shopQuery: any = {
      $or: [
        // Tekmetric
        { "tekmetric.shopId": tekShopIdNum },
        { "tekmetric.shopId": tekShopIdStr },
        { tekmetricShopId: tekShopIdNum },
        { tekmetricShopId: tekShopIdStr },
        // Protractor
        { "protractor.connectionId": smsShopId },
        { protractorConnectionId: smsShopId },
        // AutoFlow
        { "autoflow.shopId": smsShopId },
      ]
    };
    
    if (!isPlatformAdmin) {
      shopQuery.shopId = { $in: userShopIds };
    }
    
    shopDoc = await db.collection("shops").findOne(shopQuery);
    
    if (shopDoc) {
      mosShopId = shopDoc.shopId;
      console.log(`[Extension] Found shop ${mosShopId} (${shopDoc.name}), integrationProvider: ${shopDoc.integrationProvider}`);
    } else {
      console.log(`[Extension] No shop found for SMS shop ${smsShopId}, userShopIds: ${userShopIds.join(',')}`);
    }

    if (!mosShopId) {
      return NextResponse.json(
        { error: `No accessible shop configured for SMS shop ID ${smsShopId}` },
        { status: 404, headers: corsHeaders }
      );
    }
    
    // Use the shop's actual integration provider, not the passed hint
    // Fall back to detecting from config if integrationProvider field not set
    const provider = shopDoc.integrationProvider 
      || (shopDoc.tekmetric?.shopId ? 'tekmetric' 
        : shopDoc.protractor?.connectionId ? 'protractor' 
        : shopDoc.autoflow?.domain ? 'autoflow' 
        : providerHint || 'tekmetric');
    
    if (providerHint && providerHint !== provider) {
      console.log(`[Extension] Provider mismatch: hint=${providerHint}, actual=${provider}`);
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
            const tekApiToken = await getValidToken();
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

    // Track VIN+RO view against trial limit (skip for paid shops)
    const isPaid = shopDoc?.billing?.plan === "professional" || shopDoc?.billing?.plan === "enterprise";
    let vinTrackingResult: { allowed: boolean; count: number; limit: number | null } | null = null;
    
    if (!isPaid) {
      const platformSettings = await db.collection("platform_settings").findOne({ key: "trial" });
      const defaultLimit = platformSettings?.vinLimit ?? 10;
      const shopLimit = shopDoc?.trialVinLimit ?? defaultLimit;
      
      const trackResult = await checkAndTrackVin(db, mosShopId, vin.toUpperCase(), shopLimit, roId);
      vinTrackingResult = { allowed: trackResult.allowed, count: trackResult.count, limit: shopLimit };
      
      if (!trackResult.allowed) {
        return NextResponse.json({
          vehicle: { vin: vin.toUpperCase() },
          mileage,
          overdue: [],
          dueSoon: [],
          recommended: [],
          requiresUpgrade: true,
          vinUsage: { count: trackResult.count, limit: shopLimit },
          message: `Trial limit reached (${trackResult.count}/${shopLimit} visits). Upgrade to continue.`
        }, { headers: corsHeaders });
      }
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
        const startTime = Date.now();
        
        // PARALLEL FETCH: Get all external data at once for speed
        const [carfaxResult, oemResult, shopWorkOrders] = await Promise.all([
          // CARFAX service history
          fetchCarfaxWithCache(mosShopId, vin).catch(e => {
            console.warn('[Extension] CARFAX fetch failed:', e);
            return { ok: false, serviceRecords: [] };
          }),
          // DataOne OEM maintenance schedule
          getMaintenanceScheduleCached(vin).catch(e => {
            console.warn('[Extension] OEM fetch failed:', e);
            return { ok: false, count: 0, items: [], vin, squish: '', source: 'cache' as const };
          }),
          // Shop work orders for last-performed lookups
          db.collection("tekmetric_work_orders").find({
            shopId: Number(mosShopId),
            vin: vin.toUpperCase()
          }).sort({ completedDate: -1 }).limit(50).toArray().catch(e => {
            console.warn('[Extension] Work orders fetch failed:', e);
            return [];
          })
        ]);
        
        console.log(`[Extension] Parallel fetch completed in ${Date.now() - startTime}ms`);
        
        // Process CARFAX records
        let carfaxRecords: any[] | null = null;
        if (carfaxResult.ok && carfaxResult.serviceRecords?.length) {
          carfaxRecords = carfaxResult.serviceRecords.sort((a: any, b: any) => {
            const dateA = a.date ? new Date(a.date).getTime() : 0;
            const dateB = b.date ? new Date(b.date).getTime() : 0;
            return dateB - dateA;
          });
          console.log(`[Extension] CARFAX: ${carfaxRecords.length} service records`);
        }
        
        const recommendations = await runOnDemandAnalysis(
          mosShopId, vin, mileage, showInspectItems, shopIntervals, carfaxRecords,
          { oemResult, shopWorkOrders }
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

    // Look up enriched canned jobs to include full labor/parts details
    const cannedJobs = await db.collection("canned_jobs")
      .find({ shopId: mosShopId, enriched: true })
      .toArray();
    
    // Build a map for fuzzy matching service names to canned jobs
    const cannedJobMap = new Map<string, any>();
    for (const cj of cannedJobs) {
      const name = (cj.title || cj.name || '').toLowerCase().trim();
      if (name) {
        cannedJobMap.set(name, cj);
      }
    }
    
    // Helper to find matching canned job by service name
    function findMatchingCannedJob(serviceName: string): any | null {
      const name = (serviceName || '').toLowerCase().trim();
      if (!name) return null;
      
      // Exact match first
      if (cannedJobMap.has(name)) {
        return cannedJobMap.get(name);
      }
      
      // Fuzzy match: check if service name is contained in or contains canned job name
      for (const [cannedName, cj] of cannedJobMap.entries()) {
        if (name.includes(cannedName) || cannedName.includes(name)) {
          return cj;
        }
        // Also check for common word overlap
        const serviceWords = name.split(/\s+/).filter(w => w.length > 3);
        const cannedWords = cannedName.split(/\s+/).filter(w => w.length > 3);
        const overlap = serviceWords.filter(w => cannedWords.includes(w));
        if (overlap.length >= 2 || (overlap.length === 1 && serviceWords.length <= 2)) {
          return cj;
        }
      }
      
      return null;
    }

    if (analysisData?.recommendations) {
      for (const rec of analysisData.recommendations) {
        // Try to find matching canned job for full labor/parts details
        const matchingCannedJob = findMatchingCannedJob(rec.service || rec.name);
        
        const item = {
          name: rec.service || rec.name,
          category: rec.category || null,
          dueAt: rec.dueMileage,
          milesToGo: rec.milesToGo,
          interval: rec.interval,
          intervalMonths: rec.intervalMonths,
          intervalText: rec.intervalText || `OEM: ${(rec.interval || 0).toLocaleString()} mi`,
          intervalSource: rec.intervalSource || 'oem', // 'shop' or 'oem'
          source: rec.source || "oe",
          // Legacy fields for backward compatibility
          lastPerformedBy: rec.lastPerformedBy || rec.last?.source || null,
          lastPerformedMileage: rec.lastPerformedMileage || rec.last?.miles || null,
          // New nested format for extension UI
          last: rec.last || null, // { source: 'shop'|'external'|'unknown', miles, date }
          priority: rec.priority,
          // Include full job details from matching canned job if available
          laborItems: matchingCannedJob?.laborLines || [],
          parts: matchingCannedJob?.partLines || rec.parts || [],
          laborHours: matchingCannedJob?.laborLines?.reduce((sum: number, l: any) => sum + (l.hours || 0), 0) || rec.laborHours || 1,
          amount: matchingCannedJob?.totalAmount || 0,
          cannedJobId: matchingCannedJob?._id?.toString() || null,
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
