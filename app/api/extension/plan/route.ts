import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getUserShopIds } from "@/lib/extension-auth";
import { resolveCarfaxConfig, fetchCarfaxWithCache, estimateMileageFromCarfax } from "@/lib/integrations/carfax";
import { getMaintenanceScheduleCached } from "@/lib/integrations/dataone-api";
import { checkAndTrackVin, getCachedPlan } from "@/lib/plan-cache";
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

const PREFETCH_MAX_CONCURRENT = 2;
const PREFETCH_DELAY_MS = 500;
const PREFETCH_MAX_VEHICLES = 15;
const ANALYSIS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PREFETCH_LOCK_TTL_MS = 10 * 60 * 1000;

const shopPrefetchInProgress = new Set<number>();

async function backgroundPrefetchShopPlans(
  mosShopId: number,
  currentVin: string,
  showInspectItems: boolean,
  shopIntervals: ShopIntervals
) {
  if (shopPrefetchInProgress.has(mosShopId)) {
    return;
  }

  shopPrefetchInProgress.add(mosShopId);
  setTimeout(() => shopPrefetchInProgress.delete(mosShopId), PREFETCH_LOCK_TTL_MS);

  try {
    const db = await getDb();
    const recentLock = await db.collection("extension_prefetch_locks").findOne({
      shopId: mosShopId,
      startedAt: { $gt: new Date(Date.now() - PREFETCH_LOCK_TTL_MS) }
    });
    if (recentLock) {
      console.log(`[Extension Prefetch] Shop ${mosShopId}: DB lock active, skipping`);
      shopPrefetchInProgress.delete(mosShopId);
      return;
    }
    await db.collection("extension_prefetch_locks").updateOne(
      { shopId: mosShopId },
      { $set: { shopId: mosShopId, startedAt: new Date() } },
      { upsert: true }
    );
  } catch (e) {
    // Non-critical, proceed anyway
  }

  try {
    const db2 = await getDb();
    
    const openWorkOrders = await db2.collection("tekmetric_work_orders").find({
      shopId: { $in: [String(mosShopId), Number(mosShopId)] },
      status: { $nin: ["Invoice", "Invoiced", "Posted", "Deleted", "Void", "Closed"] },
      vin: { $exists: true, $ne: null }
    }).sort({ updatedAt: -1 }).limit(PREFETCH_MAX_VEHICLES + 10).toArray();

    const uniqueVins = new Map<string, { vin: string; mileage: number }>();
    const zeroMileageVins: string[] = [];
    for (const wo of openWorkOrders) {
      const vin = (wo.vin || "").toUpperCase();
      if (!vin || vin.length !== 17 || vin === currentVin.toUpperCase()) continue;
      if (uniqueVins.has(vin)) continue;
      const odometer = wo.odometer || 0;
      if (odometer > 0) {
        uniqueVins.set(vin, { vin, mileage: odometer });
      } else {
        zeroMileageVins.push(vin);
      }
    }

    for (const vin of zeroMileageVins) {
      if (uniqueVins.has(vin)) continue;
      try {
        const estimate = await estimateMileageFromCarfax(mosShopId, vin);
        if (estimate.estimated) {
          uniqueVins.set(vin, { vin, mileage: estimate.mileage });
          console.log(`[Extension Prefetch] Shop ${mosShopId}: Estimated ${vin} at ${estimate.mileage} mi from CARFAX`);
        }
      } catch {}
    }

    if (uniqueVins.size === 0) {
      console.log(`[Extension Prefetch] Shop ${mosShopId}: No other open ROs to prefetch`);
      shopPrefetchInProgress.delete(mosShopId);
      return;
    }

    const allVins = Array.from(uniqueVins.keys());
    const existingCaches = await db2.collection("maintenance_analysis_cache").find({
      vin: { $in: allVins },
      shopId: mosShopId
    }).project({ vin: 1, analyzedAt: 1, mileageAtAnalysis: 1 }).toArray();

    const cacheMap = new Map<string, { analyzedAt: Date; mileage: number }>();
    for (const c of existingCaches) {
      if (c.analyzedAt) {
        cacheMap.set(c.vin, { analyzedAt: new Date(c.analyzedAt), mileage: c.mileageAtAnalysis || 0 });
      }
    }

    const vehiclesToPrefetch: { vin: string; mileage: number }[] = [];
    for (const [vin, data] of uniqueVins) {
      if (vehiclesToPrefetch.length >= PREFETCH_MAX_VEHICLES) break;
      const cached = cacheMap.get(vin);
      if (cached) {
        const age = Date.now() - cached.analyzedAt.getTime();
        const mileageChanged = Math.abs(data.mileage - cached.mileage) > 100;
        if (age < ANALYSIS_CACHE_TTL_MS && !mileageChanged) continue;
      }
      vehiclesToPrefetch.push(data);
    }

    if (vehiclesToPrefetch.length === 0) {
      console.log(`[Extension Prefetch] Shop ${mosShopId}: All ${uniqueVins.size} open RO plans already cached`);
      shopPrefetchInProgress.delete(mosShopId);
      return;
    }

    console.log(`[Extension Prefetch] Shop ${mosShopId}: Building plans for ${vehiclesToPrefetch.length} vehicles (${uniqueVins.size} open ROs total)`);

    let built = 0;
    for (let i = 0; i < vehiclesToPrefetch.length; i += PREFETCH_MAX_CONCURRENT) {
      const batch = vehiclesToPrefetch.slice(i, i + PREFETCH_MAX_CONCURRENT);
      await Promise.allSettled(
        batch.map(async (v) => {
          try {
            await runOnDemandAnalysis(mosShopId, v.vin, v.mileage, showInspectItems, shopIntervals);
            built++;
            console.log(`[Extension Prefetch] Shop ${mosShopId}: Built plan for ${v.vin} (${built}/${vehiclesToPrefetch.length})`);
          } catch (e: any) {
            console.warn(`[Extension Prefetch] Shop ${mosShopId}: Failed ${v.vin}: ${e.message}`);
          }
        })
      );
      if (i + PREFETCH_MAX_CONCURRENT < vehiclesToPrefetch.length) {
        await new Promise(r => setTimeout(r, PREFETCH_DELAY_MS));
      }
    }

    console.log(`[Extension Prefetch] Shop ${mosShopId}: Completed ${built}/${vehiclesToPrefetch.length} plans`);
  } catch (e: any) {
    console.error(`[Extension Prefetch] Shop ${mosShopId}: Error:`, e.message);
  } finally {
    shopPrefetchInProgress.delete(mosShopId);
  }
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

  // Use prefetched OEM data or fetch if not provided (with 15s timeout to avoid blocking)
  try {
    let oemFetch: Promise<Awaited<ReturnType<typeof getMaintenanceScheduleCached>>>;
    if (prefetched?.oemResult) {
      oemFetch = Promise.resolve(prefetched.oemResult);
    } else {
      oemFetch = Promise.race([
        getMaintenanceScheduleCached(vin),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("DataOne timeout — plan will load without OEM data")), 15000)
        )
      ]);
    }
    const oemResult = await oemFetch;
    console.log(`[Extension] OEM data: ${oemResult.count} items, source: ${oemResult.source}`);
    
    if (oemResult.ok && oemResult.items?.length > 0) {
      let skippedNoInterval = 0;
      let skippedInspect = 0;
      let skippedExcluded = 0;
      
      for (const item of oemResult.items) {
        const oemIntervalMiles = item.miles || 0;
        const oemIntervalMonths = item.months || null;
        
        // Skip items with no mileage AND no month interval
        if (!oemIntervalMiles && !oemIntervalMonths) {
          skippedNoInterval++;
          continue;
        }
        
        // Filter inspect items if preference is set
        if (!showInspectItems && isInspectItem(item.maintenance_name)) {
          skippedInspect++;
          continue;
        }
        
        // Map to service key first to check exclusion
        const serviceKey = mapServiceToKey(item.maintenance_name);
        
        // Skip excluded services
        if (serviceKey && shopIntervals[serviceKey]?.excluded) {
          skippedExcluded++;
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
        
        // Calculate nextDueMileage and status
        let nextDueMileage: number;
        let milesToGo: number;
        let status: string;

        if (intervalMiles > 0) {
          // Mileage-based calculation
          if (lastPerformed.mileage && lastPerformed.mileage > 0) {
            nextDueMileage = lastPerformed.mileage + intervalMiles;
          } else if (currentMileage > 0) {
            const intervalsPassed = Math.floor(currentMileage / intervalMiles);
            nextDueMileage = (intervalsPassed + 1) * intervalMiles;
          } else {
            nextDueMileage = intervalMiles;
          }
          milesToGo = currentMileage > 0 ? nextDueMileage - currentMileage : intervalMiles;
          
          if (currentMileage > 0 && milesToGo <= 0) {
            status = "overdue";
          } else if (currentMileage > 0 && milesToGo <= SOON_MILES) {
            status = "due_soon";
          } else {
            status = "upcoming";
          }
        } else {
          // Month-only interval — use date-based calculation
          nextDueMileage = 0;
          milesToGo = 0;
          
          if (lastPerformed.date && intervalMonths) {
            const lastDate = new Date(lastPerformed.date);
            const nextDueDate = new Date(lastDate);
            nextDueDate.setMonth(nextDueDate.getMonth() + intervalMonths);
            const now = new Date();
            const daysUntilDue = Math.floor((nextDueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
            
            if (daysUntilDue <= 0) {
              status = "overdue";
            } else if (daysUntilDue <= 90) {
              status = "due_soon";
            } else {
              status = "upcoming";
            }
          } else {
            status = "upcoming";
          }
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
      console.log(`[Extension] OEM processing: ${recommendations.length} recs, skipped: noInterval=${skippedNoInterval}, inspect=${skippedInspect}, excluded=${skippedExcluded}`);
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

    const shopResult = await findShopBySmsId(smsShopId, { 
      userShopIds, 
      isPlatformAdmin, 
      providerHint: providerHint || undefined 
    });

    if (!shopResult) {
      console.log(`[Extension] No shop found for SMS shop ${smsShopId}, userShopIds: ${userShopIds.join(',')}`);
      return NextResponse.json(
        { error: `No accessible shop configured for SMS shop ID ${smsShopId}` },
        { status: 404, headers: corsHeaders }
      );
    }

    const mosShopId = shopResult.mosShopId;
    const shopDoc = shopResult.shopDoc;
    const provider = shopResult.provider;
    
    console.log(`[Extension] Found shop ${mosShopId} (${shopDoc.name}), provider: ${provider}`);
    
    if (providerHint && providerHint !== provider) {
      console.log(`[Extension] Provider mismatch: hint=${providerHint}, actual=${provider}`);
    }
    
    // Get shop preferences - showInspectItems defaults to true if not set
    const showInspectItems = shopDoc?.preferences?.showInspectItems !== false;
    
    // Get shop maintenance intervals
    const shopIntervals: ShopIntervals = shopDoc?.maintenance?.intervals || {};

    let vehicle = null;
    let mileage = null;
    let repairOrderNumber = null;
    let customerName = null;
    let currentRoDate: Date | null = null;

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
                const repairOrderNumber = data.repairOrderNumber;
                const customerName = data.customer?.firstName && data.customer?.lastName 
                  ? `${data.customer.firstName} ${data.customer.lastName}` 
                  : data.customer?.name;
                
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
                
                workOrder = { vin: roVin, odometer, repairOrderNumber, customerName };
                console.log(`[Extension] Fetched from Tekmetric API: vin=${workOrder.vin}, odometer=${workOrder.odometer}, roNumber=${repairOrderNumber}, customer=${customerName}`);
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
      } else if (provider === "shopware") {
        workOrder = await db.collection("shopware_repair_orders").findOne({
          mosShopId,
          $or: [
            { roId: String(roId) },
            { roId: parseInt(roId) },
            { number: String(roId) },
            { number: parseInt(roId) }
          ]
        });
        console.log(`[Extension] Shop-Ware RO lookup: mosShopId=${mosShopId}, roId=${roId}, found=${!!workOrder}`);

        if (!workOrder && shopDoc?.shopware?.tenantId) {
          console.log(`[Extension] Fetching RO ${roId} directly from Shop-Ware API`);
          try {
            const { getRepairOrder } = await import("@/lib/integrations/shopware/client");
            const ro = await getRepairOrder(shopDoc.shopware.tenantId, parseInt(roId), shopDoc.shopware.swShopId);
            if (ro) {
              workOrder = {
                vin: ro.vehicle?.vin?.toUpperCase() ?? null,
                odometer: ro.odometer ?? null,
                repairOrderNumber: ro.number ? String(ro.number) : null,
                customerName: ro.customer
                  ? `${ro.customer.first_name ?? ""} ${ro.customer.last_name ?? ""}`.trim()
                  : null,
                vehicleYear: ro.vehicle?.year ? parseInt(ro.vehicle.year, 10) : null,
                vehicleMake: ro.vehicle?.make ?? null,
                vehicleModel: ro.vehicle?.model ?? null,
                updatedAt: ro.updated_at ? new Date(ro.updated_at) : null,
              };
              console.log(`[Extension] Fetched from Shop-Ware API: vin=${workOrder.vin}, odometer=${workOrder.odometer}, roNumber=${workOrder.repairOrderNumber}, customer=${workOrder.customerName}`);
            }
          } catch (e: any) {
            console.error(`[Extension] Shop-Ware API fetch failed:`, e.message);
          }
        }

        if (workOrder) {
          const wo: any = workOrder;
          if (wo.vehicleYear && wo.vehicleMake && wo.vehicleModel) {
            vin = vin || wo.vin;
            mileage = wo.odometer || null;
            repairOrderNumber = wo.repairOrderNumber || wo.number ? String(wo.repairOrderNumber || wo.number) : null;
            customerName = wo.customerName || null;
            currentRoDate = wo.updatedAt ? new Date(wo.updatedAt) : (wo.syncedAt ? new Date(wo.syncedAt) : null);
          } else {
            vin = wo.vin || wo.vehicleVin;
            mileage = wo.odometer || wo.mileageIn || wo.mileage || wo.odometerIn;
            repairOrderNumber = wo.repairOrderNumber || wo.number ? String(wo.repairOrderNumber || wo.number) : null;
            customerName = wo.customerName || null;
            currentRoDate = wo.updatedAt ? new Date(wo.updatedAt) : null;
          }
          workOrder = null;
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
        const wo: any = workOrder;
        vin = wo.vin || wo.vehicleVin;
        mileage = wo.odometer || wo.mileageIn || wo.mileage || wo.odometerIn;
        repairOrderNumber = wo.repairOrderNumber || null;
        customerName = wo.customerName || null;
        currentRoDate = wo.updatedDate ? new Date(wo.updatedDate) : (wo.updatedAt || wo.createdAt || wo.fetchedAt ? new Date(wo.updatedAt || wo.createdAt || wo.fetchedAt) : null);
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

      if (!vehicle || !vehicle.year || !vehicle.make || !vehicle.model) {
        try {
          const { decodeVinLocal } = await import("@/lib/integrations/dataone-local");
          const decoded = await Promise.race([
            decodeVinLocal(vin.toUpperCase()),
            new Promise<{ ok: false; vin: string; error: string; source: "local" }>((resolve) =>
              setTimeout(() => resolve({ ok: false, vin, error: "timeout", source: "local" }), 5000)
            )
          ]);
          if (decoded.ok && decoded.decoded) {
            const d = decoded.decoded;
            vehicle = {
              ...(vehicle || {}),
              vin: vin.toUpperCase(),
              year: vehicle?.year || d.year,
              make: vehicle?.make || d.make,
              model: vehicle?.model || d.model,
              engine: vehicle?.engine || d.engine_name,
            };
            console.log(`[Extension] VIN decoded: ${d.year} ${d.make} ${d.model}`);
          }
        } catch (e) {
          console.warn('[Extension] VIN decode fallback failed:', e);
        }
      }
    }

    let mileageEstimated = false;
    let mileageEstimateDetails: any = null;

    if (vin) {
      try {
        const estimate = await estimateMileageFromCarfax(mosShopId, vin.toUpperCase());
        if (!mileage || mileage <= 0) {
          if (estimate.estimated) {
            mileage = estimate.mileage;
            mileageEstimated = true;
            mileageEstimateDetails = {
              confidence: estimate.confidence,
              dataPoints: estimate.dataPoints,
              lastRecordedMileage: estimate.lastRecordedMileage,
              lastRecordedDate: estimate.lastRecordedDate,
              milesPerDay: estimate.milesPerDay,
            };
            console.log(`[Extension] Estimated mileage for ${vin}: ${mileage} mi (${estimate.confidence}, ${estimate.dataPoints} CARFAX points, ${estimate.milesPerDay} mi/day)`);
          } else {
            console.log(`[Extension] Cannot estimate mileage for ${vin}: ${estimate.reason}`);
          }
        } else if (mileage > 0 && estimate.estimated && estimate.milesPerDay > 0) {
          const vehicleUpdated = vehicle?.updatedAt ? new Date(vehicle.updatedAt) : null;
          const recordedDate = vehicleUpdated || null;
          if (recordedDate) {
            const projectToDate = currentRoDate || new Date();
            const daysSince = (projectToDate.getTime() - recordedDate.getTime()) / (1000 * 60 * 60 * 24);
            if (daysSince >= 1 && daysSince <= 180) {
              const lastRecorded = mileage;
              mileage = Math.round(mileage + estimate.milesPerDay * daysSince);
              mileageEstimated = true;
              mileageEstimateDetails = {
                confidence: "projected",
                lastRecordedMileage: lastRecorded,
                lastRecordedDate: recordedDate.toISOString().split("T")[0],
                projectedToDate: projectToDate.toISOString().split("T")[0],
                milesPerDay: Math.round(estimate.milesPerDay * 10) / 10,
                daysSinceRecorded: Math.round(daysSince),
              };
              console.log(`[Extension] Projected mileage for ${vin}: ${lastRecorded} + (${estimate.milesPerDay.toFixed(1)} mi/day × ${Math.round(daysSince)} days) = ${mileage} mi (projected to ${projectToDate.toISOString().split("T")[0]})`);
            }
          }
        }
      } catch (e: any) {
        console.warn(`[Extension] CARFAX mileage estimation failed for ${vin}: ${e.message}`);
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

    // Fetch RO details from Tekmetric if we have an roId but no customer/RO number yet
    if (provider === "tekmetric" && roId && (!repairOrderNumber || !customerName) && shopDoc?.tekmetric?.shopId) {
      try {
        const tekApiToken = await getValidToken();
        const res = await fetch(`https://shop.tekmetric.com/api/v1/repair-orders/${roId}`, {
          headers: { Authorization: `Bearer ${tekApiToken}` }
        });
        if (res.ok) {
          const data = await res.json();
          if (data) {
            repairOrderNumber = data.repairOrderNumber || null;
            
            // Try to get customer name from the RO response
            if (data.customer) {
              if (data.customer.firstName && data.customer.lastName) {
                customerName = `${data.customer.firstName} ${data.customer.lastName}`;
              } else if (data.customer.name) {
                customerName = data.customer.name;
              }
            }
            
            // If no customer name in RO, fetch from customer endpoint using customerId
            if (!customerName && data.customerId) {
              try {
                const custRes = await fetch(`https://shop.tekmetric.com/api/v1/customers/${data.customerId}`, {
                  headers: { Authorization: `Bearer ${tekApiToken}` }
                });
                if (custRes.ok) {
                  const custData = await custRes.json();
                  if (custData) {
                    if (custData.firstName && custData.lastName) {
                      customerName = `${custData.firstName} ${custData.lastName}`;
                    } else if (custData.name) {
                      customerName = custData.name;
                    }
                  }
                }
              } catch (ce) {
                console.log(`[Extension] Could not fetch customer ${data.customerId}:`, ce);
              }
            }
            
            console.log(`[Extension] Fetched RO details: roNumber=${repairOrderNumber}, customer=${customerName}`);
          }
        }
      } catch (e) {
        console.error(`[Extension] Failed to fetch RO details:`, e);
      }
    }

    if (provider === "shopware" && roId && (!repairOrderNumber || !customerName)) {
      try {
        const swRo = await db.collection("shopware_repair_orders").findOne({
          mosShopId,
          $or: [
            { roId: String(roId) },
            { roId: parseInt(roId) },
            { number: String(roId) },
            { number: parseInt(roId) }
          ]
        });
        if (swRo) {
          if (!repairOrderNumber && swRo.number) repairOrderNumber = String(swRo.number);
          if (!customerName && swRo.customerName) customerName = swRo.customerName;
          if (!mileage && swRo.odometer) mileage = swRo.odometer;
          console.log(`[Extension] Shop-Ware RO details from cache: roNumber=${repairOrderNumber}, customer=${customerName}, mileage=${mileage}`);
        } else if (shopDoc?.shopware?.tenantId) {
          console.log(`[Extension] Fetching RO ${roId} details from Shop-Ware API`);
          const { getRepairOrder } = await import("@/lib/integrations/shopware/client");
          const ro = await getRepairOrder(shopDoc.shopware.tenantId, parseInt(roId), shopDoc.shopware.swShopId);
          if (ro) {
            if (!repairOrderNumber && ro.number) repairOrderNumber = String(ro.number);
            if (!customerName && ro.customer) {
              customerName = `${ro.customer.first_name ?? ""} ${ro.customer.last_name ?? ""}`.trim() || null;
            }
            if (!mileage && ro.odometer) mileage = ro.odometer;
            console.log(`[Extension] Shop-Ware API RO details: roNumber=${repairOrderNumber}, customer=${customerName}, mileage=${mileage}`);
          }
        }
      } catch (e: any) {
        console.error(`[Extension] Failed to fetch Shop-Ware RO details:`, e.message);
      }
    }

    // First try to use the dashboard's cached plan for consistency
    const cachedPlan = !forceRefresh ? await getCachedPlan(db, vin.toUpperCase(), mosShopId, mileage) : null;
    
    if (cachedPlan && cachedPlan.plan?.buckets) {
      console.log(`[Extension] Using dashboard cached plan: overdue=${cachedPlan.plan.buckets.overdue?.length || 0}, dueSoon=${cachedPlan.plan.buckets.dueSoon?.length || 0}, upcoming=${cachedPlan.plan.buckets.upcoming?.length || 0}`);
      
      // Convert cached plan buckets to extension format
      const plan = {
        overdue: [] as any[],
        dueSoon: [] as any[],
        recommended: [] as any[]
      };
      
      // Helper to convert cached item to extension format
      const convertItem = (item: any) => ({
        service: item.title || item.key,
        name: item.title || item.key,
        category: item.category || 'General',
        interval: item.intervalMiles,
        intervalMiles: item.intervalMiles,
        intervalMonths: item.intervalMonths,
        intervalText: formatIntervalText(item.intervalMiles, item.intervalMonths),
        intervalSource: item.usingShopInterval ? 'shop' : 'oem',
        dueAt: item.dueAtMiles,
        dueMileage: item.dueAtMiles,
        dueDate: item.dueAtDate,
        milesToGo: item.milesToGo ?? null,
        last: item.last ? {
          source: item.last.source || 'unknown',
          miles: item.last.miles || null,
          date: item.last.date || null
        } : null,
        lastPerformed: item.last ? {
          mileage: item.last.miles,
          date: item.last.date,
          source: item.last.source
        } : null,
        lastPerformedBy: item.last?.source || null,
        lastPerformedMileage: item.last?.miles || null,
        source: item.source || 'oem',
        serviceKey: item.serviceKey,
        bump: item.bump,
        usingShopInterval: item.usingShopInterval,
        matchedDeferred: item.matchedDeferred || null,
        protractorDeferredId: item.protractorDeferredId || null,
        declined: item.declined || null
      });
      
      for (const item of (cachedPlan.plan.buckets.overdue || [])) {
        if (!showInspectItems && isInspectItem(item.title || item.key)) continue;
        plan.overdue.push(convertItem(item));
      }
      for (const item of (cachedPlan.plan.buckets.dueSoon || [])) {
        if (!showInspectItems && isInspectItem(item.title || item.key)) continue;
        plan.dueSoon.push(convertItem(item));
      }
      for (const item of (cachedPlan.plan.buckets.upcoming || [])) {
        if (!showInspectItems && isInspectItem(item.title || item.key)) continue;
        plan.recommended.push(convertItem(item));
      }
      
      backgroundPrefetchShopPlans(mosShopId, vin, showInspectItems, shopIntervals)
        .catch(e => console.error('[Extension Prefetch] Unhandled:', e.message));

      return NextResponse.json({
        vehicle: cachedPlan.plan.vehicle || vehicle || { vin: vin.toUpperCase() },
        mileage: cachedPlan.plan.currentMiles || mileage,
        mileageEstimated,
        mileageEstimateDetails: mileageEstimated ? mileageEstimateDetails : undefined,
        ...plan,
        deferredWork: cachedPlan.plan.deferredWork || [],
        vinUsage: vinTrackingResult ? { count: vinTrackingResult.count, limit: vinTrackingResult.limit } : undefined,
        fromDashboardCache: true,
        repairOrderNumber,
        customerName
      }, { headers: corsHeaders });
    }
    
    // Fall back to running our own analysis if no cached plan
    console.log(`[Extension] No dashboard cache, running on-demand analysis`);
    
    let analysisData: any = await db.collection("maintenance_analysis_cache").findOne({
      vin: vin.toUpperCase(),
      shopId: mosShopId
    });

    const analysisAge = analysisData?.analyzedAt 
      ? Date.now() - new Date(analysisData.analyzedAt).getTime()
      : Infinity;
    const maxAge = 24 * 60 * 60 * 1000;
    const hasRecommendations = analysisData?.recommendations?.length > 0;

    // Also re-run if showInspectItems preference changed
    const cachedShowInspect = analysisData?.showInspectItems ?? true;
    const prefsChanged = cachedShowInspect !== showInspectItems;
    
    console.log(`[Extension] Analysis cache check: exists=${!!analysisData}, age=${Math.round(analysisAge/1000)}s, hasRecs=${hasRecommendations}, prefsChanged=${prefsChanged}`);
    
    if (!analysisData || forceRefresh || analysisAge > maxAge || prefsChanged || !hasRecommendations) {
      try {
        const startTime = Date.now();
        
        // PARALLEL FETCH: Get all external data at once for speed
        const [carfaxResult, oemResult, shopWorkOrders] = await Promise.all([
          // CARFAX service history
          fetchCarfaxWithCache(mosShopId, vin).catch(e => {
            console.warn('[Extension] CARFAX fetch failed:', e);
            return { ok: false, serviceRecords: [] };
          }),
          // DataOne OEM maintenance schedule (15s timeout to avoid blocking on Neon wake-up)
          Promise.race([
            getMaintenanceScheduleCached(vin),
            new Promise<{ ok: false; count: 0; items: []; vin: string; squish: string; source: 'cache' }>((resolve) =>
              setTimeout(() => {
                console.warn('[Extension] OEM fetch timed out after 15s');
                resolve({ ok: false, count: 0, items: [], vin, squish: '', source: 'cache' });
              }, 15000)
            )
          ]).catch(e => {
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

    backgroundPrefetchShopPlans(mosShopId, vin, showInspectItems, shopIntervals)
      .catch(e => console.error('[Extension Prefetch] Unhandled:', e.message));

    return NextResponse.json({
      vehicle: vehicle ? {
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        vin: vehicle.vin || vin?.toUpperCase() || null
      } : vin ? { vin: vin.toUpperCase() } : null,
      mileage,
      mileageEstimated,
      mileageEstimateDetails: mileageEstimated ? mileageEstimateDetails : undefined,
      overdue: plan.overdue,
      dueSoon: plan.dueSoon,
      recommended: plan.recommended,
      analyzed: !!analysisData,
      repairOrderNumber,
      customerName
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error("[Extension Plan] Error:", error);
    return NextResponse.json(
      { error: "Failed to load plan" },
      { status: 500, headers: corsHeaders }
    );
  }
}
