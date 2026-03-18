import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getUserShopIds, getAuthErrorStatus } from "@/lib/extension-auth";
import { resolveCarfaxConfig, fetchCarfaxWithCache, estimateMileageFromCarfax } from "@/lib/integrations/carfax";
import { getMaintenanceScheduleCached } from "@/lib/integrations/dataone-api";
import { checkAndTrackVin, getCachedPlan } from "@/lib/plan-cache";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { getRepairOrderInspections } from "@/lib/integrations/tekmetric/client";
import { isConfigured as isTekmetricConfigured } from "@/lib/integrations/tekmetric/auth";

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

const SERVICE_KEY_PATTERNS: Record<string, RegExp[]> = {
  oil: [/oil change/i, /engine oil/i, /oil filter/i, /oil and filter/i, /synthetic oil/i],
  tire_rotation: [/tire rotation/i, /rotate tire/i],
  cabin_air: [/cabin air/i, /cabin filter/i, /pollen filter/i, /interior air filter/i],
  engine_air: [/\bair filter\b/i, /engine air/i, /air cleaner/i],
  coolant: [/coolant/i, /antifreeze/i, /radiator flush/i],
  brake_fluid: [/brake fluid/i],
  trans_auto: [/automatic trans/i, /\batf\b/i, /auto trans/i, /transmission fluid/i],
  trans_manual: [/manual trans/i, /\bmtf\b/i],
  transfer_case: [/transfer case/i],
  front_differential: [/front differential/i],
  rear_differential: [/rear differential/i],
  power_steering: [/power steering/i],
  fuel_filter: [/fuel filter/i],
  spark_plugs: [/spark plug/i, /ignition plug/i],
  serpentine_belt: [/serpentine/i, /drive belt/i, /accessory belt/i, /v-belt/i],
  timing_belt: [/timing belt/i, /timing chain/i, /cam belt/i],
  fuel_system: [/fuel system/i, /fuel injection/i, /injector clean/i],
  front_brake_pads: [/front brake pad/i, /front brake lining/i, /front brakes replaced/i],
  rear_brake_pads: [/rear brake pad/i, /rear brake lining/i, /rear brakes replaced/i, /brake shoe/i],
  front_brake_rotors: [/front brake rotor/i, /front rotor/i],
  rear_brake_rotors: [/rear brake rotor/i, /rear rotor/i],
  front_shocks: [/front shock/i, /front strut/i],
  rear_shocks: [/rear shock/i, /rear strut/i],
  wheel_alignment: [/wheel alignment/i, /alignment/i, /front end align/i, /4 wheel align/i],
  battery: [/battery replace/i, /battery service/i, /\bbattery\b/i],
  wiper_blades: [/wiper blade/i, /windshield wiper/i, /wiper replace/i, /wiper insert/i],
  ac_refrigerant: [/a\/c/i, /refrigerant/i, /ac refr/i, /air condition/i],
  emissions: [/emissions/i, /smog/i],
};

function mapServiceToKey(serviceName: string): string | null {
  const name = serviceName?.toLowerCase() || '';
  for (const [key, patterns] of Object.entries(SERVICE_KEY_PATTERNS)) {
    if (patterns.some(p => p.test(name))) {
      return key;
    }
  }
  if (/\bdifferential\b/i.test(name) && !/front/i.test(name) && !/rear/i.test(name)) return "rear_differential";
  if (/\b(shock|strut)\b/i.test(name)) {
    if (/front/i.test(name)) return "front_shocks";
    if (/rear/i.test(name)) return "rear_shocks";
    return "front_shocks";
  }
  if (/brake rotor/i.test(name)) {
    if (/front/i.test(name)) return "front_brake_rotors";
    if (/rear/i.test(name)) return "rear_brake_rotors";
    return "front_brake_rotors";
  }
  if (/brake pad|brake lining|brakes replaced/i.test(name)) {
    if (/front/i.test(name)) return "front_brake_pads";
    if (/rear/i.test(name)) return "rear_brake_pads";
    return "front_brake_pads";
  }
  return null;
}

type LastPerformedInfo = {
  source: 'shop' | 'external' | 'unknown';
  date?: Date;
  mileage?: number;
};

type ServiceMappings = Record<string, string>;

let _serviceMappingsCache: { data: ServiceMappings; fetchedAt: number } | null = null;
const SERVICE_MAPPINGS_TTL = 10 * 60 * 1000;

async function getServiceMappings(db: any): Promise<ServiceMappings> {
  if (_serviceMappingsCache && Date.now() - _serviceMappingsCache.fetchedAt < SERVICE_MAPPINGS_TTL) {
    return _serviceMappingsCache.data;
  }
  try {
    const docs = await db.collection("oem_carfax_mappings").find({}).toArray();
    const map: ServiceMappings = {};
    for (const doc of docs) {
      if (doc.oemName && doc.carfaxName) {
        map[doc.oemName.toLowerCase()] = doc.carfaxName.toLowerCase();
      }
    }
    _serviceMappingsCache = { data: map, fetchedAt: Date.now() };
    return map;
  } catch (err) {
    console.warn('[Extension] Failed to load service mappings:', err);
    return {};
  }
}

function getLastPerformedInfo(
  serviceName: string,
  shopWorkOrders: any[],
  carfaxRecords: any[] | null,
  adminMappings?: ServiceMappings
): LastPerformedInfo {
  const serviceKey = mapServiceToKey(serviceName);
  const adminCarfaxName = adminMappings?.[serviceName.toLowerCase()];
  
  if (!serviceKey && !adminCarfaxName) {
    return { source: 'unknown' };
  }
  
  let shopLastDone: { date?: Date; mileage?: number } | null = null;
  let carfaxLastDone: { date?: Date; mileage?: number } | null = null;
  
  const servicePatterns = serviceKey ? SERVICE_KEY_PATTERNS[serviceKey] : null;
  if (servicePatterns && shopWorkOrders.length > 0) {
    for (const wo of shopWorkOrders) {
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
  
  if (carfaxRecords?.length) {
    for (const record of carfaxRecords) {
      const desc = record.description || '';
      const descLower = desc.toLowerCase();
      
      const regexMatch = servicePatterns?.some(p => p.test(desc));
      const adminMatch = adminCarfaxName && descLower.includes(adminCarfaxName);
      
      if (regexMatch || adminMatch) {
        carfaxLastDone = {
          date: record.date ? new Date(record.date) : undefined,
          mileage: record.odometer
        };
        break;
      }
    }
  }
  
  if (shopLastDone && carfaxLastDone) {
    if (shopLastDone.date && carfaxLastDone.date) {
      if (shopLastDone.date >= carfaxLastDone.date) {
        return { source: 'shop', ...shopLastDone };
      } else {
        return { source: 'external', ...carfaxLastDone };
      }
    }
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

const tekmetricRoCache = new Map<string, { data: any; fetchedAt: number }>();
const TEKMETRIC_RO_CACHE_TTL = 60 * 60 * 1000;

async function fetchTekmetricRoCached(roId: string, forceRefresh = false): Promise<any | null> {
  if (!forceRefresh) {
    const cached = tekmetricRoCache.get(roId);
    if (cached && Date.now() - cached.fetchedAt < TEKMETRIC_RO_CACHE_TTL) {
      return cached.data;
    }
  }
  try {
    const { tekmetricRequest } = await import("@/lib/integrations/tekmetric/client");
    const data = await tekmetricRequest(`/repair-orders/${roId}`);
    tekmetricRoCache.set(roId, { data, fetchedAt: Date.now() });
    if (tekmetricRoCache.size > 200) {
      const oldest = Array.from(tekmetricRoCache.entries())
        .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
      if (oldest) tekmetricRoCache.delete(oldest[0]);
    }
    return data;
  } catch (e: any) {
    console.error(`[Extension] Tekmetric RO fetch failed for ${roId}:`, e.message);
  }
  return null;
}

async function backgroundPrefetchShopPlans(
  mosShopId: number,
  currentVin: string,
  showInspectItems: boolean,
  shopIntervals: ShopIntervals,
  intervalApplyMode: string = "shop_only"
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
            await runOnDemandAnalysis(mosShopId, v.vin, v.mileage, showInspectItems, shopIntervals, null, undefined, undefined, intervalApplyMode);
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
  prefetched?: PrefetchedData,
  dviFindings?: Array<{ name?: string; status?: string | number; source?: string }>,
  intervalApplyMode: string = "shop_only"
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
      const adminMappings = await getServiceMappings(db);
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
        const lastPerformed = getLastPerformedInfo(item.maintenance_name, shopWorkOrders, carfaxRecords, adminMappings);
        
        // Decide which interval to use based on last performed location
        let intervalMiles = oemIntervalMiles;
        let intervalMonths = oemIntervalMonths;
        let intervalSource = 'oem';
        
        // Use shop intervals if enabled and:
        // - "always" mode: apply regardless of last service location
        // - "shop_only" mode: only when service was last done at this shop
        const shopOverrideApplies = serviceKey && shopIntervals[serviceKey]?.useShop &&
          (intervalApplyMode === 'always' || lastPerformed.source === 'shop');
        if (shopOverrideApplies) {
          const shopInterval = shopIntervals[serviceKey];
          if (shopInterval.miles != null || shopInterval.months != null) {
            if (shopInterval.miles != null) intervalMiles = shopInterval.miles;
            if (shopInterval.months != null) intervalMonths = shopInterval.months;
            intervalSource = 'shop';
          }
        }
        
        // Calculate nextDueMileage and status
        let nextDueMileage: number;
        let milesToGo: number;
        let status: string;

        if (intervalMiles > 0) {
          if (lastPerformed.mileage && lastPerformed.mileage > 0) {
            nextDueMileage = lastPerformed.mileage + intervalMiles;
          } else if (currentMileage > 0 && currentMileage > intervalMiles) {
            nextDueMileage = intervalMiles;
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

  const dviMap = new Map<string, { status: "red" | "yellow"; name: string; dviSource: string }>();
  const unmappedDvi: Array<{ status: "red" | "yellow"; name: string; dviSource: string }> = [];
  if (dviFindings && dviFindings.length > 0) {
    for (const it of dviFindings) {
      const rawName = String(it.name || "");
      if (!rawName) continue;
      const key = mapServiceToKey(rawName);
      const s = String(it.status ?? "");
      const src = it.source || "tekmetric";
      const mappedStatus = s === "0" ? "red" as const : s === "1" ? "yellow" as const : null;
      if (!mappedStatus) continue;
      if (key) {
        if (mappedStatus === "red") dviMap.set(key, { status: "red", name: rawName, dviSource: src });
        else if (dviMap.get(key)?.status !== "red") dviMap.set(key, { status: "yellow", name: rawName, dviSource: src });
      } else {
        unmappedDvi.push({ status: mappedStatus, name: rawName, dviSource: src });
      }
    }

    const usedDviKeys = new Set<string>();
    for (const rec of recommendations) {
      const recKey = mapServiceToKey(rec.service || "");
      if (recKey && dviMap.has(recKey)) {
        const dvi = dviMap.get(recKey)!;
        usedDviKeys.add(recKey);
        rec.bump = dvi.status;
        rec.dviSource = dvi.dviSource;
        if (dvi.status === "red") {
          rec.status = "overdue";
        } else if (dvi.status === "yellow" && rec.status !== "overdue") {
          rec.status = "due_soon";
        }
      }
    }

    for (const [dviKey, dvi] of dviMap) {
      if (usedDviKeys.has(dviKey)) continue;
      recommendations.push({
        service: dvi.name,
        category: "DVI Finding",
        dueMileage: 0,
        interval: 0,
        intervalMonths: null,
        intervalText: "",
        intervalSource: "dvi",
        lastPerformedBy: null,
        lastPerformedMileage: null,
        last: null,
        milesToGo: 0,
        source: "dvi",
        status: dvi.status === "red" ? "overdue" : "due_soon",
        bump: dvi.status,
        dviSource: dvi.dviSource,
      });
    }
    for (const unmapped of unmappedDvi) {
      recommendations.push({
        service: unmapped.name,
        category: "DVI Finding",
        dueMileage: 0,
        interval: 0,
        intervalMonths: null,
        intervalText: "",
        intervalSource: "dvi",
        lastPerformedBy: null,
        lastPerformedMileage: null,
        last: null,
        milesToGo: 0,
        source: "dvi",
        status: unmapped.status === "red" ? "overdue" : "due_soon",
        bump: unmapped.status,
        dviSource: unmapped.dviSource,
      });
    }
    console.log(`[Extension] DVI applied: ${dviMap.size + unmappedDvi.length} findings, ${usedDviKeys.size} matched to OEM, ${dviMap.size - usedDviKeys.size + unmappedDvi.length} standalone`);
  }

  // Deduplicate recommendations by service name
  const uniqueRecs = recommendations.reduce((acc: any[], rec) => {
    const exists = acc.find(r => r.service?.toLowerCase() === rec.service?.toLowerCase());
    if (!exists) acc.push(rec);
    return acc;
  }, []);

  const hasBump = (r: any) => r.bump === "red" || r.bump === "yellow";
  uniqueRecs.sort((a, b) => {
    const statusOrder: Record<string, number> = { overdue: 0, due_soon: 1, upcoming: 2 };
    const orderDiff = (statusOrder[a.status] ?? 2) - (statusOrder[b.status] ?? 2);
    if (orderDiff !== 0) return orderDiff;
    const aDvi = hasBump(a) ? 0 : 1;
    const bDvi = hasBump(b) ? 0 : 1;
    if (aDvi !== bDvi) return aDvi - bDvi;
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
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: getAuthErrorStatus(auth), headers: corsHeaders });
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
    
    const rawIntervals: ShopIntervals = shopDoc?.maintenance?.intervals || {};
    const intervalApplyMode: string = shopDoc?.maintenance?.intervalApplyMode || "shop_only";
    const LEGACY_KEY_MAP: Record<string, string[]> = {
      differential: ["front_differential", "rear_differential"],
      alignment: ["wheel_alignment"],
      brake_pads: ["front_brake_pads", "rear_brake_pads"],
    };
    const shopIntervals: ShopIntervals = { ...rawIntervals };
    for (const [oldKey, newKeys] of Object.entries(LEGACY_KEY_MAP)) {
      if (shopIntervals[oldKey]) {
        for (const nk of newKeys) {
          if (!shopIntervals[nk]) shopIntervals[nk] = shopIntervals[oldKey];
        }
      }
    }

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
        
        if (!workOrder && shopDoc?.tekmetric?.shopId) {
          console.log(`[Extension] API FALLBACK: RO ${roId} not in tekmetric_work_orders, fetching from Tekmetric API`);
          const data = await fetchTekmetricRoCached(String(roId), forceRefresh);
          if (data) {
            let roVin = data.vehicle?.vin || data.vehicleVin;
            const odometer = data.milesIn || data.mileageIn || data.vehicle?.mileage;

            if (!roVin && data.vehicleId) {
              try {
                const { getCachedVehicle, cacheVehicle } = await import("@/lib/tekmetric-incremental-sync");
                const vehicleId = Number(data.vehicleId);
                const cachedVeh = await getCachedVehicle(db, vehicleId);
                if (cachedVeh) {
                  roVin = cachedVeh.vin;
                  console.log(`[Extension] Vehicle ${vehicleId} found in MongoDB cache`);
                } else {
                  const { tekmetricRequest } = await import("@/lib/integrations/tekmetric/client");
                  const vehData = await tekmetricRequest(`/vehicles/${vehicleId}`);
                  roVin = vehData?.vin;
                  if (vehData) await cacheVehicle(db, vehicleId, vehData).catch(() => {});
                }
              } catch (e: any) {
                console.warn(`[Extension] Vehicle lookup failed for vehicleId=${data.vehicleId}, roId=${roId}:`, e?.message);
              }
            }

            workOrder = {
              vin: roVin,
              odometer,
              repairOrderNumber: data.repairOrderNumber,
              customerName: data.customer?.firstName && data.customer?.lastName
                ? `${data.customer.firstName} ${data.customer.lastName}`
                : data.customer?.name
            };
            console.log(`[Extension] Tekmetric API fallback: vin=${workOrder.vin}, odometer=${workOrder.odometer}`);
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

        if (!vin && shopDoc?.shopware?.tenantId) {
          console.log(`[Extension] No VIN from cache, fetching RO ${roId} directly from Shop-Ware API`);
          try {
            const { getRepairOrder } = await import("@/lib/integrations/shopware/client");
            const ro = await getRepairOrder(shopDoc.shopware.tenantId, parseInt(roId), shopDoc.shopware.swShopId);
            if (ro) {
              vin = ro.vehicle?.vin?.toUpperCase() ?? null;
              if (!mileage) mileage = ro.odometer ?? null;
              if (!repairOrderNumber) repairOrderNumber = ro.number ? String(ro.number) : null;
              if (!customerName) customerName = ro.customer
                ? `${ro.customer.first_name ?? ""} ${ro.customer.last_name ?? ""}`.trim()
                : null;
              console.log(`[Extension] Fetched from Shop-Ware API: vin=${vin}, odometer=${mileage}, roNumber=${repairOrderNumber}, customer=${customerName}`);

              if (vin) {
                const updateFields: any = { vin };
                if (ro.vehicle?.year) updateFields.vehicleYear = parseInt(ro.vehicle.year, 10);
                if (ro.vehicle?.make) updateFields.vehicleMake = ro.vehicle.make;
                if (ro.vehicle?.model) updateFields.vehicleModel = ro.vehicle.model;
                if (ro.odometer) updateFields.odometer = ro.odometer;
                db.collection("shopware_repair_orders").updateOne(
                  { mosShopId, $or: [{ roId: String(roId) }, { roId: parseInt(roId) }] },
                  { $set: updateFields }
                ).catch((e: any) => console.warn(`[Extension] Failed to backfill VIN to cache:`, e.message));
              }
            }
          } catch (e: any) {
            console.error(`[Extension] Shop-Ware API fetch failed:`, e.message);
          }
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
        } else if (mileage > 0) {
          console.log(`[Extension] Using actual mileage ${mileage} for ${vin} (not estimating)`);
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

    if (provider === "tekmetric" && roId && (!repairOrderNumber || !customerName) && shopDoc?.tekmetric?.shopId) {
      const data = await fetchTekmetricRoCached(String(roId), forceRefresh);
      if (data) {
        if (!repairOrderNumber) repairOrderNumber = data.repairOrderNumber || null;
        if (!customerName) {
          if (data.customer?.firstName && data.customer?.lastName) {
            customerName = `${data.customer.firstName} ${data.customer.lastName}`;
          } else if (data.customer?.name) {
            customerName = data.customer.name;
          } else if (data.customerId) {
            try {
              const { getCachedCustomer, cacheCustomer } = await import("@/lib/tekmetric-incremental-sync");
              const customerId = Number(data.customerId);
              const cachedCust = await getCachedCustomer(db, customerId);
              if (cachedCust) {
                const c = cachedCust as any;
                if (c.firstName && c.lastName) {
                  customerName = `${c.firstName} ${c.lastName}`;
                } else if (c.name) {
                  customerName = c.name;
                }
                console.log(`[Extension] Customer ${customerId} found in MongoDB cache`);
              } else {
                console.log(`[Extension] API FALLBACK: Customer ${customerId} not in cache, fetching from API`);
                const { tekmetricRequest } = await import("@/lib/integrations/tekmetric/client");
                const custData = await tekmetricRequest(`/customers/${customerId}`);
                if (custData?.firstName && custData?.lastName) {
                  customerName = `${custData.firstName} ${custData.lastName}`;
                } else if (custData?.name) {
                  customerName = custData.name;
                }
                if (custData) await cacheCustomer(db, customerId, custData).catch(() => {});
              }
            } catch (e: any) {
              console.warn(`[Extension] Customer lookup failed for customerId=${data.customerId}, roId=${roId}:`, e?.message);
            }
          }
        }
        console.log(`[Extension] RO details (cached): roNumber=${repairOrderNumber}, customer=${customerName}`);
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
    
    const COMPLIMENTARY_KEYS = new Set([
      "oil_reminder", "oil_replacement_reminder", "reset_oil_replacement_reminder",
      "chassis_body", "tighten_nuts_bolts",
      "multi_point_inspection", "tire_pressure", "tire_pressure_check",
    ]);
    const COMPLIMENTARY_TITLE_KW = [
      "oil replacement reminder", "maint reqd", "oil reset", "reset oil",
      "tighten nuts and bolts", "tighten nuts & bolts", "chassis and body", "chassis & body",
      "multi-point inspection", "multi point inspection",
      "tire pressure check", "tire pressure set", "set tire pressure",
    ];
    const isComplimentaryItem = (item: any) => {
      const key = (item.serviceKey || item.key || "").toLowerCase();
      if (COMPLIMENTARY_KEYS.has(key)) return true;
      const title = (item.title || item.key || "").toLowerCase();
      return COMPLIMENTARY_TITLE_KW.some(kw => title.includes(kw));
    };

    if (cachedPlan && cachedPlan.plan?.buckets) {
      console.log(`[Extension] Using dashboard cached plan: overdue=${cachedPlan.plan.buckets.overdue?.length || 0}, dueSoon=${cachedPlan.plan.buckets.dueSoon?.length || 0}, upcoming=${cachedPlan.plan.buckets.upcoming?.length || 0}, cachedMiles=${cachedPlan.mileage}, currentMiles=${mileage}`);

      const plan = {
        overdue: [] as any[],
        dueSoon: [] as any[],
        recommended: [] as any[],
        complimentary: [] as any[]
      };
      
      const convertItem = (item: any) => ({
        service: item.title || item.key,
        name: item.title || item.key,
        category: item.category || 'General',
        interval: item.intervalMiles,
        intervalMiles: item.intervalMiles,
        intervalMonths: item.intervalMonths,
        intervalText: `${item.usingShopInterval ? 'Shop' : 'OEM'}: ${formatIntervalText(item.intervalMiles, item.intervalMonths)}`,
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
        bump: item.bump || null,
        dviSource: item.dviSource || null,
        usingShopInterval: item.usingShopInterval,
        reason: item.reason || null,
        matchedDeferred: item.matchedDeferred || null,
        protractorDeferredId: item.protractorDeferredId || null,
        declined: item.declined || null
      });

      const currentMiles = mileage || cachedPlan.plan.currentMiles || 0;
      const cachedMiles = cachedPlan.mileage || cachedPlan.plan.currentMiles || 0;
      const needsRecategorize = currentMiles > 0 && (cachedMiles <= 0 || Math.abs(currentMiles - cachedMiles) > 500);

      if (needsRecategorize) {
        console.log(`[Extension] Re-categorizing cached plan items: cachedMiles=${cachedMiles}, currentMiles=${currentMiles}`);
        const allItems = [
          ...(cachedPlan.plan.buckets.overdue || []),
          ...(cachedPlan.plan.buckets.dueSoon || []),
          ...(cachedPlan.plan.buckets.upcoming || [])
        ];
        const DUE_SOON_THRESHOLD = 1000;
        for (const item of allItems) {
          if (!showInspectItems && isInspectItem(item.title || item.key)) continue;
          const converted = convertItem(item);
          const dueAt = item.dueAtMiles;
          if (isComplimentaryItem(item)) {
            plan.complimentary.push(converted);
          } else if (dueAt != null && dueAt > 0) {
            converted.milesToGo = dueAt - currentMiles;
            if (currentMiles >= dueAt) {
              plan.overdue.push(converted);
            } else if (dueAt - currentMiles <= DUE_SOON_THRESHOLD) {
              plan.dueSoon.push(converted);
            } else {
              plan.recommended.push(converted);
            }
          } else {
            plan.recommended.push(converted);
          }
        }
      } else {
        for (const item of (cachedPlan.plan.buckets.overdue || [])) {
          if (!showInspectItems && isInspectItem(item.title || item.key)) continue;
          if (isComplimentaryItem(item)) { plan.complimentary.push(convertItem(item)); continue; }
          plan.overdue.push(convertItem(item));
        }
        for (const item of (cachedPlan.plan.buckets.dueSoon || [])) {
          if (!showInspectItems && isInspectItem(item.title || item.key)) continue;
          if (isComplimentaryItem(item)) { plan.complimentary.push(convertItem(item)); continue; }
          plan.dueSoon.push(convertItem(item));
        }
        for (const item of (cachedPlan.plan.buckets.upcoming || [])) {
          if (!showInspectItems && isInspectItem(item.title || item.key)) continue;
          plan.recommended.push(convertItem(item));
        }
      }
      
      backgroundPrefetchShopPlans(mosShopId, vin, showInspectItems, shopIntervals, intervalApplyMode)
        .catch(e => console.error('[Extension Prefetch] Unhandled:', e.message));

      const cachedVehicle = cachedPlan.plan.vehicle || vehicle || {};
      return NextResponse.json({
        vehicle: { ...cachedVehicle, vin: cachedVehicle.vin || vin?.toUpperCase() || null },
        mileage: cachedPlan.plan.currentMiles || mileage,
        mileageEstimated,
        mileageEstimateDetails: mileageEstimated ? mileageEstimateDetails : undefined,
        ...plan,
        deferredWork: cachedPlan.plan.deferredWork || [],
        vinUsage: vinTrackingResult ? { count: vinTrackingResult.count, limit: vinTrackingResult.limit } : undefined,
        fromDashboardCache: true,
        repairOrderNumber,
        customerName,
        shopLogo: shopDoc?.branding?.logo || null,
        locationIdentifier: shopDoc?.locationIdentifier || shopDoc?.name || null,
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

    const cachedShowInspect = analysisData?.showInspectItems ?? true;
    const prefsChanged = cachedShowInspect !== showInspectItems;

    const cachedAnalysisMileage = analysisData?.mileageAtAnalysis || analysisData?.mileage || 0;
    const currentAnalysisMileage = mileage || 0;
    const mileageChanged = currentAnalysisMileage > 0 && (cachedAnalysisMileage <= 0 || Math.abs(currentAnalysisMileage - cachedAnalysisMileage) > 500);
    
    console.log(`[Extension] Analysis cache check: exists=${!!analysisData}, age=${Math.round(analysisAge/1000)}s, hasRecs=${hasRecommendations}, prefsChanged=${prefsChanged}, mileageChanged=${mileageChanged} (cached=${cachedAnalysisMileage}, current=${currentAnalysisMileage})`);
    
    if (!analysisData || forceRefresh || analysisAge > maxAge || prefsChanged || !hasRecommendations || mileageChanged) {
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
        
        let tekDviFindings: Array<{ name?: string; status?: string | number; source?: string }> = [];
        if (provider === "tekmetric" && roId && isTekmetricConfigured()) {
          try {
            const inspections = await getRepairOrderInspections(Number(roId));
            for (const inspection of inspections) {
              for (const item of inspection.items || []) {
                if (item.status === "bad") {
                  tekDviFindings.push({ name: item.name, status: "0", source: "tekmetric" });
                } else if (item.status === "marginal") {
                  tekDviFindings.push({ name: item.name, status: "1", source: "tekmetric" });
                }
              }
            }
            if (tekDviFindings.length > 0) {
              console.log(`[Extension] Tekmetric DVI: ${tekDviFindings.length} findings from RO ${roId}`);
            }
          } catch (err: any) {
            console.warn(`[Extension] Tekmetric DVI fetch failed:`, err.message);
          }
        }

        const recommendations = await runOnDemandAnalysis(
          mosShopId, vin, mileage, showInspectItems, shopIntervals, carfaxRecords,
          { oemResult, shopWorkOrders },
          tekDviFindings.length > 0 ? tekDviFindings : undefined,
          intervalApplyMode
        );
        analysisData = { recommendations, showInspectItems };
      } catch (e) {
        console.error("[Extension] On-demand analysis failed:", e);
      }
    }

    const plan = {
      overdue: [] as any[],
      dueSoon: [] as any[],
      recommended: [] as any[],
      complimentary: [] as any[]
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
          reason: rec.reason,
          bump: rec.bump || null,
          dviSource: rec.dviSource || null,
        };

        const nameForCheck = { serviceKey: rec.serviceKey || "", key: rec.key || "", title: rec.service || rec.name || "" };
        if (isComplimentaryItem(nameForCheck)) {
          plan.complimentary.push(item);
        } else if (rec.status === "overdue" || rec.isOverdue) {
          plan.overdue.push(item);
        } else if (rec.status === "due_soon" || rec.isDueSoon) {
          plan.dueSoon.push(item);
        } else {
          plan.recommended.push(item);
        }
      }
    }

    backgroundPrefetchShopPlans(mosShopId, vin, showInspectItems, shopIntervals, intervalApplyMode)
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
      complimentary: plan.complimentary,
      analyzed: !!analysisData,
      repairOrderNumber,
      customerName,
      shopLogo: shopDoc?.branding?.logo || null,
      locationIdentifier: shopDoc?.locationIdentifier || shopDoc?.name || null,
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error("[Extension Plan] Error:", error);
    return NextResponse.json(
      { error: "Failed to load plan" },
      { status: 500, headers: corsHeaders }
    );
  }
}
