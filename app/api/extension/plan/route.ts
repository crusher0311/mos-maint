import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { findEnrichedCannedJobs } from "@/lib/data/repositories/canned-jobs";
import { findDviResultByRo } from "@/lib/data/repositories/dvi";
import { validateExtensionToken, getUserShopIds, getAuthErrorStatus , buildAuthErrorBody } from "@/lib/extension-auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { resolveCarfaxConfig, fetchCarfaxWithCache, estimateMileageFromCarfax } from "@/lib/integrations/carfax";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
import { getMaintenanceScheduleCached } from "@/lib/integrations/dataone-api";
import { trackViewedVin, getCachedPlan } from "@/lib/plan-cache";
import {
  getMaintenanceAnalysisDoc,
  upsertMaintenanceAnalysisDoc,
  listMaintenanceAnalysisMeta,
  upsertReportApprovedItemsDoc,
  deleteReportApprovedItemsDoc,
} from "@/lib/data/repositories/plan-cache-store";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { isComplimentaryItem } from "@/lib/complimentary-classification";
import { computeIntervalProgress } from "@/lib/vhi-progress";
import {
  detectMileageDiscrepancy,
  buildMileageDiscrepancyFlag,
  shopHistoryLabelFromProvider,
} from "@/lib/plan-build/mileage-discrepancy";
import {
  isRoOdometerStale,
  reconcileStaleActualWithEstimate,
} from "@/lib/plan-build/open-ro-mileage";
import { buildReportUrl } from "@/lib/report-share";
import { getDistanceLabel, type DistanceUnit } from "@/lib/distance-utils";
import {
  LIFETIME_FLUID_SERVICE_KEYS,
  SERVICE_KEY_DISPLAY_NAMES,
  splitServicePhrases,
  isInspectOnlyHistoryPhrase,
  INSPECTION_SERVICE_KEYS,
  toKeyFromFreeText,
} from "@/lib/service-keys";
import { listTekmetricDeferredWorkByVin } from "@/lib/data/repositories/tekmetric-deferred-work";
import { gatherDviLinkFindings } from "@/lib/dvi-links/plan-findings";
import {
  classifyEngineRisk,
  loadEngineRiskOverrides,
  OIL_INTERVAL_RISK_THRESHOLD_MILES,
  SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES,
  SAFETY_CHECK_OIL_LEVEL_KEY,
  SAFETY_CHECK_OIL_LEVEL_TITLE,
  type EngineProfile,
  type EngineRiskOverride,
} from "@/lib/engine-risk";

/**
 * Test seam (Task #196): the route handler and `runOnDemandAnalysis`
 * dereference `__deps.getDb` at call time so the smoke test can swap in an
 * in-memory Mongo without spinning up a real DB. Production callers should
 * never touch this object — it defaults to the real implementation and is
 * only mutated by `tests/plan-build-task-196.smoke.ts`.
 */
export const __deps = {
  getDb,
};

/**
 * Bumped whenever the extension on-demand analyzer's output shape changes
 * in a way the side panel cares about (Task #175: engineRiskFlag /
 * engineRiskReason on the oil row + auto-inserted Safety Check — Oil Level
 * row when the engine is flagged). `maintenance_analysis_cache` rows that
 * predate this version are treated as stale so existing installs pick up
 * the new chip without manual reload.
 */
// Task #336: bumped from 2 → 3 so existing Canadian-shop installs whose
// recommendations were computed in raw miles are treated as stale and
// rebuilt under shop unit (km) on next view.
// Bumped 3 → 4: Tekmetric declined jobs are now folded into the on-demand
// analysis (matched items carry `declined`, unmatched become standalone
// overdue entries) — old cached analyses lack them and must rebuild.
// Bumped 4 → 5: new `control_arm` service key + standalone declined entries
// now honor the performed-after-decline guard (shop + CARFAX history), so
// previously-cached analyses may carry flags that should have been resolved.
// Bumped 5 → 6: standalone DVI Finding cards now carry `serviceKey`, so a
// declined job for the same service merges into the DVI card instead of
// showing as a duplicate — cached analyses built without the key still
// hold both cards and must rebuild.
// Bumped 6 → 7: shop-interval-override rows with OEM "Inspect …" names are
// now retitled to the canonical service name (e.g. "Brake Fluid Service");
// cached analyses still carry the misleading inspect wording and must rebuild.
const ANALYSIS_CACHE_SCHEMA_VERSION = 7;

// Task #336: OEM data from DataOne is always in real miles. Convert to
// shop unit (km for Canadian shops) at intake so the on-demand analyzer
// matches the cached_plans path produced by lib/plan-build/triage.ts.
const MILES_TO_KM = 1.60934;

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

/**
 * Mirror the dashboard's protection: even when a shop turns OFF generic
 * inspect items, never silently drop an OE inspect row for a known
 * lifetime fluid (differential, transmission, transfer case, coolant,
 * brake, power steering). For these fluids the OE "Inspect …" row is often
 * the ONLY signal the customer gets that the fluid is due to be checked —
 * roughly 40% of diff/trans OE rows are written as "Inspect", and DataOne
 * lists no separate "Replace" row for them. The dashboard keeps these via
 * its `inspectOnly` exemption; the extension previously had no equivalent,
 * so the side panel dropped them while the dashboard showed them.
 */
function isProtectedFluidKey(key: string | null | undefined): boolean {
  return !!key && LIFETIME_FLUID_SERVICE_KEYS.has(key);
}

/**
 * Cached-plan inspect filter: hide generic inspect rows when the shop turned
 * off "show inspect items" — but never hide (a) an item the shop set its own
 * interval override for (`usingShopInterval`, e.g. HEART's 30k brake-fluid
 * policy — the shop declared it a real recurring service), (b) an
 * inspect-only fluid row (dashboard `inspectOnly` exemption parity), or
 * (c) a protected lifetime fluid. Note: `item.key` is the unique row key
 * ("brake_fluid_inspect_4083"), so the fluid check must use `serviceKey`.
 */
function hideInspectPlanItem(
  item: { title?: string; key?: string; serviceKey?: string | null; usingShopInterval?: boolean; inspectOnly?: boolean },
  showInspectItems: boolean,
): boolean {
  if (showInspectItems) return false;
  if (!isInspectItem(item.title || item.key || "")) return false;
  if (item.usingShopInterval) return false;
  if (item.inspectOnly) return false;
  return !isProtectedFluidKey(item.serviceKey ?? item.key);
}

function formatIntervalText(
  intervalMiles: number,
  intervalMonths?: number,
  // Task #336: caller-controlled label so Canadian shops see "5,000 km"
  // instead of "5,000 mi". `intervalMiles` is already in shop unit at the
  // call site (cached plan items + on-demand analyzer both store shop unit).
  distanceUnit: DistanceUnit = "miles",
): string {
  const parts: string[] = [];
  if (intervalMiles) {
    parts.push(`${intervalMiles.toLocaleString()} ${getDistanceLabel(distanceUnit)}`);
  }
  if (intervalMonths) {
    parts.push(`${intervalMonths}mo`);
  }
  return parts.join(' / ') || '';
}

function computeEstimatedDate(milesToGo: number | null, intervalMiles: number | null, intervalMonths: number | null, lastDate: any, dueAtDate: any): { daysToGo: number | null; estimatedDueDate: string | null } {
  const candidates: Date[] = [];
  if (milesToGo != null && milesToGo > 0 && intervalMiles != null && intervalMiles > 0 && intervalMonths != null && intervalMonths > 0) {
    const mileageDays = Math.round((milesToGo / intervalMiles) * intervalMonths * 30);
    if (mileageDays > 0) candidates.push(new Date(Date.now() + mileageDays * 86400000));
  }
  if (lastDate && intervalMonths != null && intervalMonths > 0) {
    const ld = new Date(lastDate);
    if (!isNaN(ld.getTime())) {
      const dateBasedDue = new Date(ld);
      dateBasedDue.setMonth(dateBasedDue.getMonth() + intervalMonths);
      if (dateBasedDue.getTime() > Date.now()) candidates.push(dateBasedDue);
    }
  }
  if (dueAtDate) {
    const d = new Date(dueAtDate);
    if (!isNaN(d.getTime()) && d.getTime() > Date.now()) candidates.push(d);
  }
  if (candidates.length === 0) return { daysToGo: null, estimatedDueDate: null };
  const earliest = candidates.reduce((a, b) => a < b ? a : b);
  const days = Math.ceil((earliest.getTime() - Date.now()) / 86400000);
  return { daysToGo: days > 0 ? days : null, estimatedDueDate: days > 0 ? earliest.toISOString().split('T')[0] : null };
}

const SERVICE_KEY_PATTERNS: Record<string, RegExp[]> = {
  oil: [/oil change/i, /engine oil/i, /oil filter/i, /oil and filter/i, /synthetic oil/i, /lube.*oil/i],
  tire_rotation: [/tire rotation/i, /rotate tire/i, /tires? rotated/i, /rotate (?:and|&) balance/i, /wheel rotation/i],
  cabin_air: [/cabin air/i, /cabin filter/i, /pollen filter/i, /interior air filter/i],
  engine_air: [/\bair filter\b/i, /engine air/i, /air cleaner/i],
  coolant: [/coolant/i, /antifreeze/i, /radiator flush/i],
  brake_fluid: [/brake fluid/i],
  trans_auto: [/automatic trans/i, /\batf\b/i, /auto trans/i, /transmission fluid/i],
  trans_manual: [/manual trans/i, /\bmtf\b/i],
  transfer_case: [/transfer case/i, /\bptu\b/i, /power transfer unit/i],
  front_differential: [/front differential/i],
  rear_differential: [/rear differential/i],
  power_steering: [/power steering/i],
  fuel_filter: [/fuel filter/i],
  spark_plugs: [/spark plug/i, /ignition plug/i],
  serpentine_belt: [/serpentine/i, /drive belt/i, /accessory belt/i, /v-belt/i],
  timing_belt: [/timing belt/i, /timing chain/i, /cam belt/i],
  fuel_system: [/fuel system/i, /fuel injection/i, /injector clean/i],
  front_brake_pads: [/front brake pad/i, /front brake lining/i, /front brakes (?:replaced|serviced|installed|repaired)/i],
  rear_brake_pads: [/rear brake pad/i, /rear brake lining/i, /rear brakes (?:replaced|serviced|installed|repaired)/i, /brake shoe/i],
  front_brake_rotors: [/front brake rotor/i, /front rotor/i],
  rear_brake_rotors: [/rear brake rotor/i, /rear rotor/i],
  front_shocks: [/front shock/i, /front strut/i],
  rear_shocks: [/rear shock/i, /rear strut/i],
  control_arm: [/control arm/i],
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

function isApprovedThisVisit(serviceTitle: string, authorizedJobs: string[], knownServiceKey?: string): boolean {
  if (!authorizedJobs.length || !serviceTitle) return false;
  const serviceKey = (knownServiceKey && SERVICE_KEY_PATTERNS[knownServiceKey]) ? knownServiceKey : mapServiceToKey(serviceTitle);
  if (!serviceKey) return false;
  const patterns = SERVICE_KEY_PATTERNS[serviceKey];
  if (!patterns) return false;
  return authorizedJobs.some(jobName => patterns.some(p => p.test(jobName)));
}

function isOnCurrentRO(serviceTitle: string, allRoJobs: string[], knownServiceKey?: string): boolean {
  if (!allRoJobs.length || !serviceTitle) return false;
  const serviceKey = (knownServiceKey && SERVICE_KEY_PATTERNS[knownServiceKey]) ? knownServiceKey : mapServiceToKey(serviceTitle);
  if (!serviceKey) return false;
  const patterns = SERVICE_KEY_PATTERNS[serviceKey];
  if (!patterns) return false;
  return allRoJobs.some(jobName => patterns.some(p => p.test(jobName)));
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
      if (!wo.completedDate) continue;
      const jobs = wo.data?.jobs ?? wo.jobs ?? [];
      for (const job of jobs) {
        // Task #608: a customer-declined (unauthorized) job was NOT performed,
        // so it must never become a "last done" anchor — even on a completed
        // RO. Skip declined jobs before pattern matching.
        if (job.authorized === false) continue;
        const jobName = job.name || job.description || '';
        // Verb-guard: an inspected/checked line ("Drive belts checked") must
        // never anchor a replacement clock. Inspection-type keys (emissions)
        // are exempt because the inspection IS the scheduled service.
        const jobInspectBlocked =
          isInspectOnlyHistoryPhrase(jobName) &&
          !(serviceKey ? INSPECTION_SERVICE_KEYS.has(serviceKey) : false);
        if (!jobInspectBlocked && servicePatterns.some(p => p.test(jobName))) {
          // Treat 0 as "missing" — a historical RO with odometer=0 means the
          // odometer wasn't captured, not that the car had zero miles. Without
          // this guard, downstream math anchors at 0 and reports the entire
          // current odometer as "miles over". See vhi-progress.ts.
          const rawMileage =
            (typeof wo.odometer === "number" && wo.odometer > 0 ? wo.odometer : null) ??
            (typeof wo.data?.milesOut === "number" && wo.data.milesOut > 0 ? wo.data.milesOut : null) ??
            (typeof wo.data?.milesIn === "number" && wo.data.milesIn > 0 ? wo.data.milesIn : null);
          const woMileage = rawMileage ?? undefined;
          const woId = wo.workOrderId || wo.repairOrderNumber || wo._id;
          console.log(`[Extension] LastPerformed match: service="${serviceName}" key="${serviceKey}" matched job="${jobName}" on WO#${woId} at ${woMileage ?? "(no odo)"}mi, completed=${wo.completedDate}`);
          shopLastDone = {
            date: new Date(wo.completedDate),
            mileage: woMileage
          };
          break;
        }
      }
      if (shopLastDone) break;
    }
  }
  
  if (carfaxRecords?.length) {
    // Inspection-type keys (emissions) may be anchored by an inspect verb
    // because the inspection IS the scheduled service; every other key needs a
    // performed verb.
    const carfaxInspectExempt = serviceKey ? INSPECTION_SERVICE_KEYS.has(serviceKey) : false;
    for (const record of carfaxRecords) {
      const desc = record.description || '';
      const descLower = desc.toLowerCase();

      // Verb-guard: CARFAX joins multiple bullet lines into one description
      // with "; " and phrases the verb AFTER the noun ("Drive belts checked"),
      // so split into phrases and only anchor from one that BOTH matches the
      // service pattern AND is not inspect-only. Otherwise an inspection resets
      // a replacement clock (the reported "checked = replaced" bug).
      const regexMatch = !!servicePatterns && splitServicePhrases(desc).some(ph =>
        servicePatterns.some(p => p.test(ph)) &&
        !(isInspectOnlyHistoryPhrase(ph) && !carfaxInspectExempt)
      );
      // Operator overrides (admin mappings) are intentional and honored
      // regardless of verb, matching the whole normalized description.
      const adminMatch = adminCarfaxName && descLower.includes(adminCarfaxName);

      if (regexMatch || adminMatch) {
        // CARFAX records frequently have a service date but no odometer — keep
        // mileage undefined in that case so it stays "date known, mileage
        // unknown" and the time axis drives the headline.
        carfaxLastDone = {
          date: record.date ? new Date(record.date) : undefined,
          mileage: typeof record.odometer === "number" && record.odometer > 0 ? record.odometer : undefined
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
const TEKMETRIC_RO_CACHE_TTL = 30 * 1000;

// Cross-instance negative cache for Tekmetric RO timeouts. The in-memory
// `tekmetricRoCache` above is per-process, so when Tekmetric stalls a single
// RO (e.g. heart-shop saturation), every advisor refresh on a different
// Render instance re-pays the 6s `withUpstreamTimeout` ceiling, and the
// refresh-storm visible in Better Stack (5+ timeouts on the same RO within
// 20s across `web-2hnt7` / `web-9n8vh`) amplifies the upstream pressure that
// caused the timeout in the first place. This Mongo-backed TTL collection
// remembers "RO X just timed out" for 30s across every instance so repeat
// hits return null immediately and the caller falls back to its existing
// `tekmetric_work_orders` Mongo cache without restalling.
const TEKMETRIC_RO_NEG_CACHE_COLL = "tekmetric_ro_negative_cache";
const TEKMETRIC_RO_NEG_CACHE_TTL_MS = 30 * 1000;
let tekmetricRoNegIndexEnsured = false;

async function ensureNegCacheIndex(db: any): Promise<void> {
  if (tekmetricRoNegIndexEnsured) return;
  try {
    await db
      .collection(TEKMETRIC_RO_NEG_CACHE_COLL)
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    tekmetricRoNegIndexEnsured = true;
  } catch {
    // index ensure failures are non-fatal — fall through to fail-open behavior
  }
}

// Shop-scope the negative-cache key. Tekmetric RO IDs appear globally unique
// today (9-10 digit ascending counters across the SMS), but the rest of this
// codebase routinely treats `{shopId, roId}` as the safe composite key, so we
// match that contract here to avoid one shop's timeout suppressing another
// shop's live fetch if Tekmetric ever recycles IDs per-shop. Callers without
// a mosShopId (legacy paths) fall back to `_:roId` and behave as before.
function negCacheKey(roId: string, mosShopId?: number): string {
  return `${mosShopId ?? "_"}:${roId}`;
}

async function isRoNegativelyCached(roId: string, mosShopId?: number): Promise<boolean> {
  try {
    const db = await getDb();
    await ensureNegCacheIndex(db);
    const doc = await db
      .collection(TEKMETRIC_RO_NEG_CACHE_COLL)
      .findOne({ _id: negCacheKey(roId, mosShopId), expiresAt: { $gt: new Date() } } as any);
    return !!doc;
  } catch {
    // Mongo unavailable → fail-open (pretend no negative entry) so we don't
    // accidentally hide a working API behind a degraded cache layer.
    return false;
  }
}

// Note: this records both upstream timeouts AND thrown errors (anything that
// makes the wrapped `withUpstreamTimeout` return `null`). The 30s window is
// intentionally short so a transient blip recovers on its own; longer
// outages benefit from the same suppression so we don't repeatedly burn 6s
// per advisor refresh while the upstream is sick.
async function recordRoNegativeCache(roId: string, mosShopId?: number): Promise<void> {
  try {
    const db = await getDb();
    await ensureNegCacheIndex(db);
    await db.collection(TEKMETRIC_RO_NEG_CACHE_COLL).updateOne(
      { _id: negCacheKey(roId, mosShopId) } as any,
      {
        $set: {
          expiresAt: new Date(Date.now() + TEKMETRIC_RO_NEG_CACHE_TTL_MS),
          cachedAt: new Date(),
          shopId: mosShopId ?? null,
          roId,
        },
      },
      { upsert: true },
    );
  } catch {
    // best-effort
  }
}

// Eager reset: as soon as any worker DOES get a good response for the RO,
// clear the cross-instance negative entry so other instances stop skipping
// the live call for the remainder of the 30s window. One bad moment should
// not degrade an RO's screen a second longer than the upstream is sick.
async function clearRoNegativeCache(roId: string, mosShopId?: number): Promise<void> {
  try {
    const db = await getDb();
    await db
      .collection(TEKMETRIC_RO_NEG_CACHE_COLL)
      .deleteOne({ _id: negCacheKey(roId, mosShopId) } as any);
  } catch {
    // best-effort
  }
}

async function fetchTekmetricRoCached(roId: string, forceRefresh = false, mosShopId?: number): Promise<any | null> {
  if (!forceRefresh) {
    const cached = tekmetricRoCache.get(roId);
    if (cached && Date.now() - cached.fetchedAt < TEKMETRIC_RO_CACHE_TTL) {
      return cached.data;
    }
    // Cross-instance short-circuit: if another worker just timed out on this
    // RO within the last 30s, don't re-pay the 6s ceiling — bail immediately
    // and let the caller use its Mongo fallback.
    if (await isRoNegativelyCached(roId, mosShopId)) {
      console.log(`[Extension] Tekmetric RO ${roId} (shop ${mosShopId ?? "?"}) negative-cached (recent timeout) — skipping live call`);
      return null;
    }
  }
  try {
    const { tekmetricRequest } = await import("@/lib/integrations/tekmetric/client");
    // Heart-shop slowdown mitigation: cap the upstream Tekmetric call at 6s.
    // On timeout `data` is null and the caller falls back to the Mongo
    // `tekmetric_work_orders` cache (possibly stale but always present)
    // rather than blocking the VHI panel for 30s+ while Tekmetric stalls.
    const data = await withUpstreamTimeout(
      tekmetricRequest(`/repair-orders/${roId}`, {}, mosShopId),
      6000,
      `tekmetric /repair-orders/${roId}`,
      null,
    );
    if (data == null) {
      // Negative-cache the timeout so concurrent advisors on other Render
      // instances don't all repay the 6s wait for the same RO.
      await recordRoNegativeCache(roId, mosShopId);
      return null;
    }
    tekmetricRoCache.set(roId, { data, fetchedAt: Date.now() });
    // Success — eagerly clear any cross-instance negative entry (fire and
    // forget; a stale entry would otherwise suppress live calls for up to
    // the full TTL even though the upstream has recovered).
    void clearRoNegativeCache(roId, mosShopId);
    if (tekmetricRoCache.size > 200) {
      const oldest = Array.from(tekmetricRoCache.entries())
        .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
      if (oldest) tekmetricRoCache.delete(oldest[0]);
    }
    return data;
  } catch (e: any) {
    console.error(`[Extension] Tekmetric RO fetch failed for ${roId}:`, e.message);
    await recordRoNegativeCache(roId, mosShopId);
  }
  return null;
}

async function backgroundPrefetchShopPlans(
  mosShopId: number,
  currentVin: string,
  showInspectItems: boolean,
  shopIntervals: ShopIntervals,
  intervalApplyMode: string = "always",
  // Task #336: forwarded so prefetched analyses for Canadian shops are
  // computed in km and don't get rebuilt under the wrong unit on first view.
  distanceUnit: DistanceUnit = "miles",
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
      // Task #960: sync-written mirror docs carry only Tekmetric's *Date
      // fields (updatedDate/createdDate), not updatedAt/createdAt — include
      // both so "most recent open WO" holds for either writer.
    }).sort({ updatedAt: -1, updatedDate: -1 }).limit(PREFETCH_MAX_VEHICLES + 10).toArray();

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
    // Task #998: flag-dispatched PG/Mongo facade read.
    const existingCaches = await listMaintenanceAnalysisMeta(mosShopId, allVins, db2);

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
            await runOnDemandAnalysis(mosShopId, v.vin, v.mileage, showInspectItems, shopIntervals, null, undefined, undefined, intervalApplyMode, [], [], distanceUnit);
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

/**
 * Convert a single dashboard plan-cache item (the `cachedPlan.plan.buckets.*`
 * shape produced by `lib/plan-build/triage.ts`) into the side-panel item
 * shape returned by `/api/extension/plan`.
 *
 * Extracted to module scope so the Task #196 smoke test can exercise the
 * cached-plan path (`getCachedPlan` → `convertItem`) without spinning up the
 * full GET handler. The closure captures inside the GET handler used to
 * carry `cachedCurrentMiles`, `currentRoAuthorizedJobs`, and
 * `currentRoAllJobs` — those are now passed explicitly via `opts`.
 */
export function convertCachedPlanItemForSidePanel(
  item: any,
  bucket: "overdue" | "dueSoon" | "upcoming" | "complimentary" | undefined,
  opts: {
    cachedCurrentMiles: number;
    currentRoAuthorizedJobs: string[];
    currentRoAllJobs: string[];
    /**
     * Task #336: shop's preferred distance unit. Cached plan items store
     * intervalMiles / dueAtMiles in shop unit (post-#333 + #336), so we
     * only need this here to label them ("5,000 km" vs "5,000 mi").
     */
    distanceUnit?: DistanceUnit;
  },
) {
  const { cachedCurrentMiles, currentRoAuthorizedJobs, currentRoAllJobs, distanceUnit = "miles" } = opts;
  let estimatedDueDate: string | null = null;
  const existingDueDate = item.daysToGo != null && item.daysToGo > 0
    ? new Date(Date.now() + item.daysToGo * 86400000).toISOString()
    : item.dueAtDate || null;
  const est = computeEstimatedDate(item.milesToGo, item.intervalMiles, item.intervalMonths, item.last?.date, existingDueDate);
  let daysToGo = est.daysToGo;
  estimatedDueDate = est.estimatedDueDate;
  const progress = computeIntervalProgress(item, cachedCurrentMiles || null, undefined, distanceUnit);
  return {
    service: item.title || item.key,
    name: item.title || item.key,
    category: item.category || 'General',
    interval: item.intervalMiles,
    intervalMiles: item.intervalMiles,
    intervalMonths: item.intervalMonths,
    intervalText: `${item.usingShopInterval ? 'Shop' : 'OEM'}: ${formatIntervalText(item.intervalMiles, item.intervalMonths, distanceUnit)}`,
    intervalSource: item.usingShopInterval ? 'shop' : 'oem',
    dueAt: item.dueAtMiles,
    dueMileage: item.dueAtMiles,
    dueDate: item.dueAtDate,
    daysToGo,
    estimatedDueDate,
    milesToGo: item.milesToGo ?? null,
    last: item.last ? {
      source: item.last.source || 'unknown',
      miles: item.last.miles || null,
      date: item.last.date || null,
      // Task #434: forward implied-parent provenance so the side panel
      // overlay renders "Anchored to <parent> on <date>" instead of the
      // misleading "Last done at …" when the anchor came from a parent
      // service (e.g. "tires replaced" → tire_rotation).
      impliedFromParentKey: item.last.impliedFromParentKey || null,
      impliedFromParentName: item.last.impliedFromParentName || null,
    } : null,
    lastSource: item.lastSource || null,
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
    declined: item.declined || null,
    // Task #175: forward engine-aware oil warning fields so the side
    // panel renders the same amber chip + tooltip as the dashboard.
    engineRiskFlag: !!item.engineRiskFlag,
    engineRiskReason: item.engineRiskReason ?? null,
    recommendedDefault: !!item.recommendedDefault,
    recommendedReason: item.recommendedReason ?? null,
    approvedThisVisit: isApprovedThisVisit(item.title || item.key, currentRoAuthorizedJobs, item.serviceKey),
    onCurrentRO: isOnCurrentRO(item.title || item.key, currentRoAllJobs, item.serviceKey),
    progress,
    // Match partner-API semantics: bucket/triage drives the icon, with
    // progress.status as a fallback when caller didn't pass a bucket.
    iconStatus:
      bucket === "overdue" ? "overdue" :
      bucket === "dueSoon" ? "soon" :
      (bucket === "upcoming" || bucket === "complimentary") ? "ok" :
      (progress.status ?? null),
  };
}

export async function runOnDemandAnalysis(
  shopId: number, 
  vin: string, 
  mileage: number | null, 
  showInspectItems: boolean = true,
  shopIntervals: ShopIntervals = {},
  carfaxRecords: any[] | null = null,
  prefetched?: PrefetchedData,
  dviFindings?: Array<{ name?: string; status?: string | number; source?: string }>,
  intervalApplyMode: string = "always",
  currentRoAuthorizedJobs: string[] = [],
  currentRoAllJobs: string[] = [],
  // Task #336: shop's preferred distance unit. Converts OEM miles → km
  // for Canadian shops at intake so anchors against the (already-shop-unit)
  // odometer + last-performed mileage produce correct dueAt + milesToGo.
  distanceUnit: DistanceUnit = "miles",
  // Task #384: persist mileage provenance onto the analysis cache so the
  // external VHI endpoint echoes the same fields when it serves from the
  // analysis cache fallback.
  mileageSource: "actual" | "estimated_carfax" | "estimated_annual" = "actual",
  mileageEstimateDetails: Record<string, unknown> | null = null,
) {
  const isMetricShop = distanceUnit === "kilometers";
  const oemToShopMiles = (mi: number | null | undefined): number => {
    if (mi == null || mi <= 0) return 0;
    return isMetricShop ? Math.round(mi * MILES_TO_KM) : mi;
  };
  const distLabel = getDistanceLabel(distanceUnit);
  // Resolve via __deps so the Task #196 smoke test can swap in fake-mongo.
  const db = await __deps.getDb();
  
  const currentMileage = mileage || 0;
  console.log(`[Extension] Running analysis for VIN ${vin}, shop ${shopId}, mileage ${currentMileage} ${distLabel}, showInspect=${showInspectItems}`);

  // Task #336: SOON window is compared against milesToGo, which is now
  // in shop unit. Convert the 3,000-mi default to km for metric shops so
  // the "due_soon" band keeps representing roughly the same drive time.
  const SOON_MILES = oemToShopMiles(3000);
  const recommendations: any[] = [];

  // Task #175: declared at function scope so the post-OEM "Safety Check —
  // Oil Level" auto-insertion (well outside the OEM try/catch below) can
  // still see them when the engine is flagged.
  let engineRisk: ReturnType<typeof classifyEngineRisk> | null = null;
  let oilLastForSafety: { date?: Date; mileage?: number; source?: string } | null = null;

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
      // Task #737: cancel the race timer once the OEM lookup resolves so the
      // loser timer doesn't linger (same uncancelled-timer pattern that made
      // the plan-build route log spurious DataOne timeouts).
      let oemRaceTimer: NodeJS.Timeout | undefined;
      oemFetch = Promise.race([
        getMaintenanceScheduleCached(vin).finally(() => {
          if (oemRaceTimer) clearTimeout(oemRaceTimer);
        }),
        new Promise<never>((_, reject) => {
          oemRaceTimer = setTimeout(() => reject(new Error("DataOne timeout — plan will load without OEM data")), 15000);
        })
      ]);
    }
    const oemResult = await oemFetch;
    console.log(`[Extension] OEM data: ${oemResult.count} items, source: ${oemResult.source}`);

    // Task #175: classify engine risk so the side panel can show the same
    // amber "Engine flagged — long oil interval" chip the dashboard does
    // and so we can auto-insert the 3,000 mi "Safety Check — Oil Level"
    // row when the engine is flagged. Mirrors lib/plan-build/triage.ts.
    // (engineRisk is hoisted to function scope above so it's still
    // visible to the safety-row insertion that runs after this try block.)
    if (oemResult.ok && oemResult.vehicle) {
      const v = oemResult.vehicle;
      const engineProfile: EngineProfile = {
        year: v.year ?? null,
        make: v.make ?? null,
        model: v.model ?? null,
        engine_name: v.engine ?? null,
        engine_size: v.engine_size ?? null,
        engine_cylinders: v.engine_cylinders ?? null,
        engine_block: v.engine_block ?? null,
        engine_induction: v.engine_induction ?? null,
        engine_aspiration: v.engine_aspiration ?? null,
        fuel_type: v.fuel_type ?? null,
      };
      let engineRiskOverrides: EngineRiskOverride[] = [];
      try {
        engineRiskOverrides = await loadEngineRiskOverrides(db);
      } catch (err) {
        console.warn(`[Extension] engine_risk_overrides load failed for ${vin}:`, err);
      }
      engineRisk = classifyEngineRisk(engineProfile, engineRiskOverrides);
      if (engineRisk.flagged) {
        console.log(`[Extension] Engine risk FLAGGED for VIN ${vin} (${engineRisk.source}): ${engineRisk.reasons.join("; ")}`);
      }
    }

    // Note: oilLastForSafety is declared at function scope above so the
    // post-OEM safety-row insertion can reference the most recent oil
    // change even though that block runs outside this try/catch.

    if (oemResult.ok && oemResult.items?.length > 0) {
      const adminMappings = await getServiceMappings(db);
      let skippedNoInterval = 0;
      let skippedInspect = 0;
      let skippedExcluded = 0;

      // Precompute which fluid keys have a real "Replace/Flush/Service" row in
      // this vehicle's OE schedule. A protected fluid is only kept past the
      // inspect filter when it has NO replacement counterpart (i.e. the
      // "Inspect …" row is the sole OE signal). When both exist, the replace
      // row already survives the filter, so hiding the duplicate inspect row
      // matches the dashboard's `inspectOnly` (no-replace) exemption exactly.
      const oemReplacementKeys = new Set<string>();
      for (const it of oemResult.items) {
        const k = mapServiceToKey(it.maintenance_name);
        if (k && !isInspectItem(it.maintenance_name)) oemReplacementKeys.add(k);
      }

      for (const item of oemResult.items) {
        // Task #336: OEM `item.miles` is real miles. Convert to shop unit
        // before mixing with `currentMileage` / `lastPerformed.mileage`
        // (which are already in shop unit for Canadian shops).
        const oemIntervalMiles = oemToShopMiles(item.miles);
        const oemIntervalMonths = item.months || null;
        
        // Skip items with no mileage AND no month interval
        if (!oemIntervalMiles && !oemIntervalMonths) {
          skippedNoInterval++;
          continue;
        }
        
        // Filter inspect items if preference is set — but never drop a
        // protected fluid whose only OE signal is this "Inspect" row.
        if (!showInspectItems && isInspectItem(item.maintenance_name)) {
          const inspectKey = mapServiceToKey(item.maintenance_name);
          const protectedInspectOnly =
            isProtectedFluidKey(inspectKey) && !oemReplacementKeys.has(inspectKey!);
          // A shop-interval override ("use shop interval" on) declares this
          // a real recurring service — never hide it as a generic inspect row.
          const shopScheduled =
            !!inspectKey && shopIntervals[inspectKey]?.useShop === true;
          if (!protectedInspectOnly && !shopScheduled) {
            skippedInspect++;
            continue;
          }
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
        let nextDueMileage: number | null;
        let milesToGo: number | null;
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
          // Month-only interval — use date-based calculation.
          // Task #479: these rows have NO mileage math, so persist null (not
          // 0). A literal dueMileage: 0 flows into maintenance_analysis_cache
          // and is served to partners as dueAtMiles: 0, where legacy readers
          // computed "remaining = 0 - currentMiles" and told the customer
          // they're the entire odometer over (e.g. brake fluid 36 months on
          // a 111k-mi Honda → "111,961 mi over"). The sidepanel already
          // tolerates null (declined rows persist dueMileage: null).
          nextDueMileage = null;
          milesToGo = null;
          
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
        const intervalText = `${sourceLabel}: ${formatIntervalText(intervalMiles, intervalMonths || undefined, distanceUnit)}`;
        
        const estResult = computeEstimatedDate(milesToGo, intervalMiles, intervalMonths, lastPerformed.date, null);
        const daysToGo = estResult.daysToGo;
        const estimatedDueDate = estResult.estimatedDueDate;

        // Task #175: when this is the oil row and the engine is flagged
        // AND the active interval is risky (≥ OIL_INTERVAL_RISK_THRESHOLD_MILES),
        // attach the same engineRiskFlag/engineRiskReason the dashboard uses
        // so the side panel can render the amber chip + tooltip.
        let engineRiskFlag = false;
        let engineRiskReason: string | null = null;
        if (
          serviceKey === "oil" &&
          engineRisk?.flagged
        ) {
          // Task #336: intervalMiles is now in shop unit. Compare against
          // the fixed real-mile threshold by converting back to miles for
          // the gate; surface the user-facing value in shop unit.
          const intervalRealMiles = isMetricShop ? intervalMiles / MILES_TO_KM : intervalMiles;
          if (intervalRealMiles >= OIL_INTERVAL_RISK_THRESHOLD_MILES) {
            engineRiskFlag = true;
            const reasons = engineRisk.reasons.length > 0
              ? engineRisk.reasons.join("; ")
              : "Engine flagged for shorter oil intervals.";
            engineRiskReason = `${reasons} Active OEM interval is ${intervalMiles.toLocaleString()} ${distLabel}.`;
          }
        }

        // Track the most recent oil-change record so the safety-check row
        // (added below when the engine is flagged) can anchor against it.
        if (serviceKey === "oil" && lastPerformed.source !== "unknown" && !oilLastForSafety) {
          // Preserve the original source ("shop" / "carfax") so the
          // safety-row downstream can attribute history accurately.
          oilLastForSafety = {
            date: lastPerformed.date,
            mileage: lastPerformed.mileage,
            source: lastPerformed.source,
          };
        }

        // Mirrors lib/plan-build/triage.ts: when the shop-interval override
        // is in force, the shop has declared this a real recurring service —
        // an OEM "Inspect …" name would misrepresent it (e.g. "Inspect brake
        // fluid." on HEART's 30k/24mo brake fluid service). Swap in the
        // canonical service name for display.
        const displayServiceName =
          intervalSource === 'shop' &&
          /^\s*(inspect|check)\b/i.test(item.maintenance_name || "") &&
          serviceKey && SERVICE_KEY_DISPLAY_NAMES[serviceKey]
            ? SERVICE_KEY_DISPLAY_NAMES[serviceKey]
            : item.maintenance_name;

        recommendations.push({
          service: displayServiceName,
          serviceKey: serviceKey || null,
          category: item.maintenance_category,
          dueMileage: nextDueMileage,
          interval: intervalMiles,
          intervalMonths,
          intervalText,
          intervalSource, // 'shop' or 'oem'
          lastPerformedBy: lastPerformed.source,
          lastPerformedMileage: lastPerformed.mileage,
          last: {
            source: lastPerformed.source,
            miles: lastPerformed.mileage || null,
            date: lastPerformed.date ? lastPerformed.date.toISOString() : null
          },
          milesToGo,
          daysToGo,
          estimatedDueDate,
          source: intervalSource === 'shop' ? 'shop' : 'oe',
          status,
          approvedThisVisit: isApprovedThisVisit(item.maintenance_name, currentRoAuthorizedJobs, serviceKey || undefined),
          onCurrentRO: isOnCurrentRO(item.maintenance_name, currentRoAllJobs, serviceKey || undefined),
          engineRiskFlag: engineRiskFlag || undefined,
          engineRiskReason: engineRiskReason ?? undefined,
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
        // Carry the canonical key so the later declined-jobs merge can
        // attach a matching declined job to this card instead of creating
        // a duplicate standalone "Customer Declined" entry (e.g. DVI
        // "Control Arms" + declined "Remove & Replace Suspension Control
        // Arm" both map to control_arm and should be ONE card).
        serviceKey: dviKey,
        category: "DVI Finding",
        // Task #479: DVI findings have no interval math — persist null (not
        // 0) so cached recommendations never serialize a fake dueMileage: 0
        // that partner readers turn into dueAtMiles: 0.
        dueMileage: null,
        interval: 0,
        intervalMonths: null,
        intervalText: "",
        intervalSource: "dvi",
        lastPerformedBy: null,
        lastPerformedMileage: null,
        last: null,
        milesToGo: null,
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
        // Task #479: same null-not-0 rule as the mapped DVI rows above.
        dueMileage: null,
        interval: 0,
        intervalMonths: null,
        intervalText: "",
        intervalSource: "dvi",
        lastPerformedBy: null,
        lastPerformedMileage: null,
        last: null,
        milesToGo: null,
        source: "dvi",
        status: unmapped.status === "red" ? "overdue" : "due_soon",
        bump: unmapped.status,
        dviSource: unmapped.dviSource,
      });
    }
    console.log(`[Extension] DVI applied: ${dviMap.size + unmappedDvi.length} findings, ${usedDviKeys.size} matched to OEM, ${dviMap.size - usedDviKeys.size + unmappedDvi.length} standalone`);
  }

  // Task #175: when the engine is flagged, auto-insert a "Safety Check —
  // Oil Level" row anchored off the most recent oil-change record (or the
  // current odometer when there's no history). Mirrors the dashboard
  // behaviour in lib/plan-build/triage.ts so service writers see the same
  // recommendation at the counter.
  if (engineRisk?.flagged && !recommendations.some((r: any) =>
    r.serviceKey === SAFETY_CHECK_OIL_LEVEL_KEY ||
    (r.service || "").toLowerCase() === SAFETY_CHECK_OIL_LEVEL_TITLE.toLowerCase()
  )) {
    // Task #336: convert the 3,000-mi safety interval to shop unit so it
    // can be added to anchorMiles / currentMileage (already shop unit).
    const safetyIntervalMiles = oemToShopMiles(SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES);
    const anchorMiles = (oilLastForSafety?.mileage && oilLastForSafety.mileage > 0)
      ? oilLastForSafety.mileage
      : (currentMileage > 0 ? currentMileage : null);
    const safetyDueMileage = anchorMiles != null ? anchorMiles + safetyIntervalMiles : safetyIntervalMiles;
    const safetyMilesToGo = currentMileage > 0 ? safetyDueMileage - currentMileage : safetyIntervalMiles;
    const safetyStatus = currentMileage > 0 && safetyMilesToGo <= 0
      ? "overdue"
      : currentMileage > 0 && safetyMilesToGo <= SOON_MILES
        ? "due_soon"
        : "upcoming";

    const reasons = engineRisk.reasons.length > 0
      ? engineRisk.reasons.join("; ")
      : "Engine flagged for shorter oil intervals.";
    const safetyReason = `${reasons} Recommended every ${safetyIntervalMiles.toLocaleString()} ${distLabel}.`;

    recommendations.push({
      service: SAFETY_CHECK_OIL_LEVEL_TITLE,
      serviceKey: SAFETY_CHECK_OIL_LEVEL_KEY,
      category: "Shop Recommendation",
      dueMileage: safetyDueMileage,
      interval: safetyIntervalMiles,
      intervalMonths: null,
      intervalText: `OEM: ${safetyIntervalMiles.toLocaleString()} ${distLabel}`,
      intervalSource: "oem",
      lastPerformedBy: oilLastForSafety?.source ?? null,
      lastPerformedMileage: oilLastForSafety?.mileage ?? null,
      last: oilLastForSafety
        ? {
            source: oilLastForSafety.source ?? "unknown",
            miles: oilLastForSafety.mileage ?? null,
            date: oilLastForSafety.date ? oilLastForSafety.date.toISOString() : null,
          }
        : null,
      milesToGo: safetyMilesToGo,
      daysToGo: null,
      estimatedDueDate: null,
      source: "common",
      status: safetyStatus,
      reason: oilLastForSafety ? safetyReason : "No record of an oil change to anchor against.",
      recommendedDefault: true,
      recommendedReason: safetyReason,
      engineRiskFlag: true,
      // Tooltip on the side-panel chip prefers engineRiskReason.
      // Use the richer safetyReason here so the auto-inserted row
      // explains both the engine flag AND why the 3,000 mi check
      // was added (review feedback on Task #175).
      engineRiskReason: safetyReason,
      approvedThisVisit: false,
      onCurrentRO: false,
    });
    console.log(`[Extension] Auto-inserted "${SAFETY_CHECK_OIL_LEVEL_TITLE}" for VIN ${vin} (anchor=${anchorMiles}, dueAt=${safetyDueMileage}, status=${safetyStatus})`);
  }

  // Task #808 follow-up: fold Tekmetric declined/unauthorized jobs into the
  // on-demand analysis, mirroring lib/plan-build/triage.ts. The dashboard
  // cached-plan path already carries `declined`, but this on-demand path
  // (used when there's no dashboard-built plan cache) was missed, so
  // extension-only shops never saw declined badges. Matched items carry the
  // declined flag and are forced overdue; unmatched jobs become their own
  // "Customer Declined" overdue entries. Fail-open: a slow/failed Mongo read
  // never blocks the analysis. Non-Tekmetric shops simply match zero rows
  // (the query filters on metadata.sourceType === "tekmetric").
  try {
    const declinedRows = await listTekmetricDeferredWorkByVin(shopId, vin.toUpperCase(), 50, db);
    if (declinedRows.length > 0) {
      const declinedAdminMappings = await getServiceMappings(db);
      const recsByServiceKey = new Map<string, any[]>();
      for (const rec of recommendations) {
        if (!rec.serviceKey) continue;
        const arr = recsByServiceKey.get(rec.serviceKey);
        if (arr) arr.push(rec);
        else recsByServiceKey.set(rec.serviceKey, [rec]);
      }

      const seenDeclinedTitles = new Set<string>();
      let matchedCount = 0;
      let standaloneCount = 0;
      for (const dj of declinedRows) {
        const title = (dj.title || "").trim() || "Declined Service";
        const normalizedTitle = title.toLowerCase().replace(/\s+/g, " ");
        if (seenDeclinedTitles.has(normalizedTitle)) continue;
        seenDeclinedTitles.add(normalizedTitle);

        const keys = toKeyFromFreeText(title) || [];
        const declinedDate = dj.date ? new Date(dj.date) : null;
        const entry = {
          serviceKey: keys[0] || `tek_declined_${dj.id}`,
          serviceName: title,
          mileage: null as number | null,
          reason: null as string | null,
          declinedAt: dj.date || "",
          origin: "tekmetric" as const,
          roNumber: dj.originalWorkOrderNumber ?? null,
        };

        let matchedAny = false;
        for (const k of keys) {
          for (const rec of recsByServiceKey.get(k) || []) {
            matchedAny = true;
            // Performed-after-decline guard: if this service has a history
            // anchor newer than the decline, the customer already resolved
            // it — don't re-flag the item.
            const lastDate = rec.last?.date ? new Date(rec.last.date) : null;
            if (
              declinedDate &&
              !isNaN(declinedDate.getTime()) &&
              lastDate &&
              !isNaN(lastDate.getTime()) &&
              lastDate > declinedDate
            ) {
              continue;
            }
            if (!rec.declined) {
              rec.declined = entry;
              rec.status = "overdue";
              matchedCount++;
            }
          }
        }

        if (!matchedAny) {
          // Performed-after-decline guard for standalone entries too: even
          // when no OEM recommendation carries this service key (e.g. control
          // arms — a repair, not a scheduled interval), shop history and
          // CARFAX can still show the work was done after the decline
          // ("Lower control arm(s) replaced" is a common CARFAX line). In
          // that case the decline is resolved — don't flag it.
          const lastInfo = getLastPerformedInfo(title, shopWorkOrders, carfaxRecords, declinedAdminMappings);
          if (
            declinedDate &&
            !isNaN(declinedDate.getTime()) &&
            lastInfo.date &&
            lastInfo.date > declinedDate
          ) {
            console.log(`[Extension] Declined job "${title}" resolved by ${lastInfo.source} history on ${lastInfo.date.toISOString().slice(0, 10)} (declined ${declinedDate.toISOString().slice(0, 10)}) — dropping flag`);
            continue;
          }
          recommendations.push({
            service: title,
            serviceKey: entry.serviceKey,
            category: "Customer Declined",
            dueMileage: null,
            interval: null,
            intervalMonths: null,
            intervalText: "",
            intervalSource: "declined",
            lastPerformedBy: null,
            lastPerformedMileage: null,
            last: null,
            milesToGo: null,
            daysToGo: null,
            estimatedDueDate: null,
            source: "declined",
            status: "overdue",
            declined: entry,
            approvedThisVisit: isApprovedThisVisit(title, currentRoAuthorizedJobs, entry.serviceKey),
            onCurrentRO: isOnCurrentRO(title, currentRoAllJobs, entry.serviceKey),
          });
          standaloneCount++;
        }
      }
      console.log(`[Extension] Declined jobs folded for VIN ${vin}: ${declinedRows.length} rows → ${matchedCount} matched, ${standaloneCount} standalone`);
    }
  } catch (e) {
    console.warn('[Extension] Declined-work lookup failed (non-blocking):', e);
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

  // Cache the analysis. `schemaVersion` is used at the read site so old
  // cached recommendations (which are missing engineRiskFlag /
  // engineRiskReason and the auto-inserted Safety Check — Oil Level row)
  // are treated as stale and re-built. See ANALYSIS_CACHE_SCHEMA_VERSION.
  // Task #998: flag-dispatched PG/Mongo facade write.
  await upsertMaintenanceAnalysisDoc(
    {
      vin: vin.toUpperCase(),
      shopId,
      recommendations: uniqueRecs,
      analyzedAt: new Date(),
      source: "extension_on_demand",
      schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION,
      mileageAtAnalysis: currentMileage,
      showInspectItems,
      // Task #384: persist mileage provenance so external VHI responses
      // served from the analysis cache include the same fields as the
      // on-demand and cached_plan branches.
      mileageSource,
      mileageEstimateDetails:
        mileageSource === "actual" ? null : mileageEstimateDetails,
    },
    db,
  );

  const counts = { overdue: 0, due_soon: 0, upcoming: 0 };
  uniqueRecs.forEach(r => counts[r.status as keyof typeof counts]++);
  console.log(`[Extension] Analysis complete: overdue=${counts.overdue}, dueSoon=${counts.due_soon}, upcoming=${counts.upcoming}`);
  
  return uniqueRecs;
}

async function _GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const smsShopId = searchParams.get("shopId");
    let vin = searchParams.get("vin");
    const roId = searchParams.get("roId");
    const providerHint = searchParams.get("provider"); // Optional hint, we verify against actual config
    const forceRefresh = searchParams.get("refresh") === "true";
    // Task #645: the odometer the advisor typed on the open RO, scraped from
    // the page by the content script. This is the most dependable mileage
    // source (it's literally what's on screen), so it anchors the VHI math
    // above the cached WO odometer / CARFAX estimate / stale snapshot. Reject
    // obviously-bad scrapes (non-integer or out of a sane range).
    const enteredOdometer = ((): number | null => {
      const raw = searchParams.get("odometer");
      if (!raw) return null;
      const n = parseInt(raw.replace(/[^\d]/g, ""), 10);
      if (!Number.isFinite(n) || n <= 100 || n >= 1_000_000) return null;
      return n;
    })();

    if (!smsShopId) {
      return NextResponse.json(
        { error: "shopId is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const reqStart = Date.now();
    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      console.log(`[Extension Plan] AUTH FAIL: smsShopId=${smsShopId}, vin=${vin}, error=${auth.error}, elapsed=${Date.now() - reqStart}ms`);
      return NextResponse.json(buildAuthErrorBody(auth), { status: getAuthErrorStatus(auth), headers: corsHeaders });
    }

    const db = await getDb();
    const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    const maskedEmail = auth.user.email ? auth.user.email.replace(/(.{2}).*(@.*)/, '$1***$2') : 'unknown';
    console.log(`[Extension Plan] Auth OK: user=${maskedEmail}, shopIds=${userShopIds.join(',')}, smsShopId=${smsShopId}, elapsed=${Date.now() - reqStart}ms`);

    const shopResult = await findShopBySmsId(smsShopId, { 
      userShopIds, 
      isPlatformAdmin, 
      providerHint: providerHint || undefined 
    });

    if (!shopResult) {
      console.log(`[Extension Plan] SHOP FAIL: No shop found for SMS shop ${smsShopId}, userShopIds: ${userShopIds.join(',')}, elapsed=${Date.now() - reqStart}ms`);
      return NextResponse.json(
        { error: `No accessible shop configured for SMS shop ID ${smsShopId}` },
        { status: 404, headers: corsHeaders }
      );
    }

    const mosShopId = shopResult.mosShopId;
    const shopDoc = shopResult.shopDoc;
    const provider = shopResult.provider;

    // Feature gate: VHI plan requires the `maintenance` feature.
    const denied = await checkShopFeatureGate(mosShopId, ["maintenance"], {
      isPlatformAdmin,
      featureLabel: "VHI",
      corsHeaders,
    });
    if (denied) return denied;
    
    console.log(`[Extension] Found shop ${mosShopId} (${shopDoc.name}), provider: ${provider}`);
    
    if (providerHint && providerHint !== provider) {
      console.log(`[Extension] Provider mismatch: hint=${providerHint}, actual=${provider}`);
    }
    
    // Get shop preferences - showInspectItems defaults to true if not set
    const showInspectItems = shopDoc?.preferences?.showInspectItems !== false;

    // Task #336: shop's preferred distance unit. Canonical path is
    // `preferences.distanceUnit` (matches dashboard + tekmetric adapter +
    // settings route); fall back to legacy `settings.distanceUnit` so
    // older shop docs still work, then default to miles.
    const shopDistanceUnit: DistanceUnit =
      ((shopDoc as any)?.preferences?.distanceUnit
        ?? (shopDoc as any)?.settings?.distanceUnit
        ?? "miles") as DistanceUnit;
    
    const rawIntervals: ShopIntervals = shopDoc?.maintenance?.intervals || {};
    const intervalApplyMode: string = shopDoc?.maintenance?.intervalApplyMode || "always";
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
    let currentRoAuthorizedJobs: string[] = [];
    let currentRoAllJobs: string[] = [];

    // AutoFlow pages anchor on the AutoFlow flag rather than the resolved
    // provider: a dual-integration shop (e.g. Protractor+AutoFlow) resolves to
    // `provider === "protractor"`, yet the RO id on screen is AutoFlow's, so it
    // must be resolved via AutoFlow's DVI ingest + VIN-matched enrichment.
    const isAutoflowAnchored = providerHint === "autoflow" || provider === "autoflow";

    if (roId && !vin) {
      let workOrder = null;
      
      if (isAutoflowAnchored) {
        // AutoFlow has no native work_orders table in our DB. Source VIN +
        // mileage from dvi_results (mirrors app/api/extension/ro-context/
        // route.ts), then enrich from the linked read provider matched BY VIN
        // — AutoFlow and the linked provider use different RO numbers, so the
        // vehicle VIN is the only reliable cross-provider key.
        const dvi = await findDviResultByRo(mosShopId, roId);
        console.log(`[Extension] Autoflow DVI lookup: mosShopId=${mosShopId}, roId=${roId}, found=${!!dvi}, resolvedProvider=${provider}`);
        if (dvi) {
          vin = vin || (dvi.vin ? String(dvi.vin).toUpperCase() : null);
          mileage = mileage || dvi.mileage || null;
          repairOrderNumber = dvi.roNumber ? String(dvi.roNumber) : null;
          customerName = dvi.customerName || null;
          currentRoDate = dvi.updatedAt ? new Date(dvi.updatedAt)
            : (dvi.createdAt ? new Date(dvi.createdAt) : null);
        }

        // Dual-integration enrichment: pull the latest RO snapshot / vehicle
        // from the linked read provider, matched by VIN.
        const linkedProvider =
          (shopDoc?.protractorConnectionId || shopDoc?.protractor?.connectionId) ? "protractor"
          : (shopDoc?.tekmetricShopId || shopDoc?.tekmetric?.shopId) ? "tekmetric"
          : (shopDoc?.shopware?.tenantId) ? "shopware"
          : null;
        if (vin && linkedProvider === "protractor") {
          const upperVin = vin.toUpperCase();
          const shopIdVariants = [Number(mosShopId), String(mosShopId)];
          if (!mileage || !customerName || !currentRoDate || !repairOrderNumber) {
            const pwo: any = await db.collection("protractor_work_orders").findOne(
              { shopId: { $in: shopIdVariants }, vin: upperVin },
              { sort: { updatedAt: -1, createdAt: -1 } }
            );
            if (pwo) {
              if (!mileage) mileage = pwo.odometer || pwo.mileage || pwo.mileageIn || null;
              if (!customerName) customerName = pwo.contactName || pwo.customerName || null;
              if (!repairOrderNumber && pwo.workOrderNumber) repairOrderNumber = String(pwo.workOrderNumber);
              if (!currentRoDate) currentRoDate = pwo.updatedAt ? new Date(pwo.updatedAt) : (pwo.createdAt ? new Date(pwo.createdAt) : null);
              console.log(`[Extension] Autoflow dual-shop enrich from Protractor WO: vin=${upperVin}, mileage=${mileage}, customer=${customerName}`);
            }
          }
          if (!mileage) {
            const pv: any = await db.collection("protractor_vehicles").findOne({ shopId: { $in: shopIdVariants }, vin: upperVin });
            if (pv) {
              mileage = pv.odometer || pv.mileage || null;
              if (mileage) console.log(`[Extension] Autoflow dual-shop enrich from Protractor vehicle: vin=${upperVin}, mileage=${mileage}`);
            }
          }
        } else if (vin && linkedProvider === "tekmetric") {
          const two: any = await db.collection("tekmetric_work_orders").findOne(
            { shopId: { $in: [Number(mosShopId), String(mosShopId)] }, vin: vin.toUpperCase() },
            { sort: { updatedDate: -1, createdDate: -1 } }
          );
          if (two) {
            if (!mileage) mileage = two.odometer || two.mileageIn || two.mileage || two.odometerIn || null;
            if (!customerName) customerName = two.customerName || null;
            console.log(`[Extension] Autoflow dual-shop enrich from Tekmetric WO: vin=${vin}, mileage=${mileage}`);
          }
        }

        // Enrich missing fields from the customers collection if the VIN is
        // known but the DVI row + linked provider were sparse.
        if (vin && (!customerName || !mileage)) {
          const customer = await db.collection("customers").findOne({
            shopId: { $in: [mosShopId, Number(mosShopId)] },
            "vehicle.vin": vin,
          });
          if (customer) {
            customerName = customerName || customer.name || null;
            if (!mileage) mileage = customer.vehicle?.odometer || null;
          }
        }
        // AutoFlow has no entries in work_orders; suppress that fallthrough.
        workOrder = null;
      } else if (provider === "tekmetric") {
        workOrder = await db.collection("tekmetric_work_orders").findOne({
          shopId: { $in: [String(mosShopId), Number(mosShopId)] },
          workOrderId: String(roId)
        });
        console.log(`[Extension] Tekmetric WO lookup: mosShopId=${mosShopId}, roId=${roId}, found=${!!workOrder}`);
        
        const liveData = await fetchTekmetricRoCached(String(roId), forceRefresh, mosShopId ? Number(mosShopId) : undefined);
        if (liveData) {
          const liveOdometer = liveData.milesIn || liveData.mileageIn || liveData.vehicle?.mileage;
          let roVin = liveData.vehicle?.vin || liveData.vehicleVin;

          if (!roVin && liveData.vehicleId) {
            try {
              const { getCachedVehicle, cacheVehicle } = await import("@/lib/integrations/tekmetric/incremental-sync");
              const vehicleId = Number(liveData.vehicleId);
              const cachedVeh = await getCachedVehicle(db, vehicleId);
              if (cachedVeh) {
                roVin = cachedVeh.vin;
                console.log(`[Extension] Vehicle ${vehicleId} found in MongoDB cache`);
              } else {
                const { tekmetricRequest } = await import("@/lib/integrations/tekmetric/client");
                const vehData = await withUpstreamTimeout(
                  tekmetricRequest(`/vehicles/${vehicleId}`, {}, mosShopId ? Number(mosShopId) : undefined),
                  4000,
                  `tekmetric /vehicles/${vehicleId}`,
                  null,
                );
                roVin = vehData?.vin;
                if (vehData) await cacheVehicle(db, vehicleId, vehData).catch(() => {});
              }
            } catch (e: any) {
              console.warn(`[Extension] Vehicle lookup failed for vehicleId=${liveData.vehicleId}, roId=${roId}:`, e?.message);
            }
          }

          if (workOrder) {
            if (liveOdometer) workOrder.odometer = liveOdometer;
            if (roVin) workOrder.vin = workOrder.vin || roVin;
            if (liveData.repairOrderNumber) workOrder.repairOrderNumber = liveData.repairOrderNumber;
            if (liveData.customer) {
              workOrder.customerName = liveData.customer?.firstName && liveData.customer?.lastName
                ? `${liveData.customer.firstName} ${liveData.customer.lastName}`
                : liveData.customer?.name || workOrder.customerName;
            }
            console.log(`[Extension] Tekmetric WO updated with live API data: odometer=${workOrder.odometer}`);
          }
          if (liveData.jobs && Array.isArray(liveData.jobs)) {
            currentRoAllJobs = liveData.jobs
              .filter((j: any) => j.name)
              .map((j: any) => j.name);
            currentRoAuthorizedJobs = liveData.jobs
              .filter((j: any) => j.authorized && j.name)
              .map((j: any) => j.name);
            console.log(`[Extension] Current RO jobs: ${currentRoAllJobs.length} total, ${currentRoAuthorizedJobs.length} authorized (${currentRoAuthorizedJobs.join(', ')})`);
          }
          if (!workOrder) {
            workOrder = {
              vin: roVin,
              odometer: liveOdometer,
              repairOrderNumber: liveData.repairOrderNumber,
              customerName: liveData.customer?.firstName && liveData.customer?.lastName
                ? `${liveData.customer.firstName} ${liveData.customer.lastName}`
                : liveData.customer?.name
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

    if (roId && vin && provider === "tekmetric" && currentRoAuthorizedJobs.length === 0) {
      const liveData = await fetchTekmetricRoCached(String(roId), forceRefresh, mosShopId ? Number(mosShopId) : undefined);
      if (liveData) {
        if (!mileage) {
          const liveOdometer = liveData.milesIn || liveData.mileageIn || liveData.vehicle?.mileage;
          if (liveOdometer) mileage = liveOdometer;
        }
        if (liveData.jobs && Array.isArray(liveData.jobs)) {
          currentRoAllJobs = liveData.jobs
            .filter((j: any) => j.name)
            .map((j: any) => j.name);
          currentRoAuthorizedJobs = liveData.jobs
            .filter((j: any) => j.authorized && j.name)
            .map((j: any) => j.name);
          console.log(`[Extension] Fetched RO jobs (vin+roId path): ${currentRoAllJobs.length} total, ${currentRoAuthorizedJobs.length} authorized (${currentRoAuthorizedJobs.join(', ')})`);
        }
        if (!repairOrderNumber && liveData.repairOrderNumber) {
          repairOrderNumber = String(liveData.repairOrderNumber);
        }
        if (!customerName && liveData.customer) {
          customerName = liveData.customer?.firstName && liveData.customer?.lastName
            ? `${liveData.customer.firstName} ${liveData.customer.lastName}`
            : liveData.customer?.name || null;
        }
      }
    }

    if (vin) {
      vehicle = await db.collection("vehicles").findOne({
        vin: vin.toUpperCase(),
        shopId: mosShopId
      });

      // NOTE: we intentionally do NOT take mileage from the vehicles snapshot
      // here. vehicles.* has no recurring sync (stale), so the CARFAX estimate
      // below is preferred; the snapshot is only used as a LAST-resort mileage
      // fallback (added after the CARFAX block) so Detect Dog anchors on the
      // same value as the partner VHI endpoint. The vehicle doc itself is still
      // used for year/make/model in the VIN decode fallback just below.

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
    // Task #943: which estimate variant won when mileageEstimated is true —
    // "estimated_annual" when the stale-reading forward projection won,
    // else "estimated_carfax". Persisted onto the analysis cache so the
    // external VHI fallback echoes the same basis.
    let mileageEstimatedSource: "estimated_carfax" | "estimated_annual" = "estimated_carfax";

    // Task #649: capture the best already-known reading BEFORE the entered
    // odometer overwrites `mileage` below. This is the most-recent open-RO /
    // cached WO odometer the route resolved above and serves as the "last
    // record" we compare the advisor's typed value against for the
    // disagreement warning. (The monotonicity guard may discard a too-low
    // entered value, so we must remember the prior reading independently.)
    const priorKnownMileage = typeof mileage === "number" && mileage > 0 ? mileage : null;

    // Task #645: anchor on the odometer the advisor typed on the open RO.
    // It sits at the top of the mileage waterfall — above the cached/live WO
    // odometer (already resolved into `mileage` above), the CARFAX estimate
    // (below), and the stale vehicles snapshot. Monotonicity guard: an
    // odometer only moves forward, so ignore an entered value that's clearly
    // LOWER than a higher already-known reading (a mis-scrape or typo should
    // not regress a real higher mileage). Setting `mileage` here also short-
    // circuits the CARFAX block (which only fills when mileage is empty) so
    // the result is correctly tagged `actual`, not `estimated`.
    let anchoredOnEnteredOdometer = false;
    if (enteredOdometer != null) {
      const known = typeof mileage === "number" && mileage > 0 ? mileage : 0;
      if (enteredOdometer >= known) {
        anchoredOnEnteredOdometer = true;
        if (mileage !== enteredOdometer) {
          console.log(`[Extension] Anchoring on entered RO odometer ${enteredOdometer} (was ${mileage ?? "none"}) for ${vin ?? roId}`);
        }
        mileage = enteredOdometer;
        mileageEstimated = false;

        // Keep the shared plan cache consistent: the partner VHI endpoint and
        // dashboard resolve their anchor from the Tekmetric WO mirror
        // (`tekmetric_work_orders.odometer`, read by lib/plan-build/
        // open-ro-mileage.ts), NOT from this `odometer` param. Persist the
        // entered reading onto the mirror (fire-and-forget, monotonic — only
        // when missing or lower) so all three plan-cache consumers converge on
        // the same value instead of thrashing an entered-vs-estimate cache key.
        // Not awaited → no added latency on the cached-hit path.
        if (provider === "tekmetric" && roId) {
          const enteredFinal = enteredOdometer;
          db.collection("tekmetric_work_orders").updateOne(
            {
              workOrderId: String(roId),
              shopId: { $in: [String(mosShopId), Number(mosShopId)] },
              $or: [{ odometer: { $exists: false } }, { odometer: { $lt: enteredFinal } }],
            },
            { $set: { odometer: enteredFinal } },
          ).catch((e: any) =>
            console.warn(`[Extension] Failed to mirror entered odometer to tekmetric_work_orders RO ${roId}: ${e?.message}`),
          );
        }
      } else {
        console.log(`[Extension] Ignoring entered odometer ${enteredOdometer} < known ${known} (monotonicity guard) for ${vin ?? roId}`);
      }
    }

    if (vin) {
      try {
        const estimate = await withUpstreamTimeout(
          estimateMileageFromCarfax(mosShopId, vin.toUpperCase()),
          5000,
          `carfax estimateMileage ${vin}`,
          { estimated: false as const, mileage: null, reason: "timeout" } as any,
        );
        // Task #872 (amends Task #476's "most-recent RO wins"): a stale RO
        // odometer (older than RO_ODOMETER_FRESHNESS_DAYS) no longer
        // short-circuits the CARFAX rolling estimate — take the LARGER of
        // the two (monotonic guard: a real reading is a floor the estimate
        // may exceed, never undercut). The entered on-screen odometer
        // (anchoredOnEnteredOdometer) is typed today and is always fresh.
        // Same rule as both partner VHI routes so the shared plan cache
        // (vin+shopId+mileage±500) keys identically across surfaces.
        const roReadingIsStale =
          !anchoredOnEnteredOdometer &&
          typeof mileage === "number" && mileage > 0 &&
          isRoOdometerStale(currentRoDate);
        if (!mileage || mileage <= 0 || roReadingIsStale) {
          const estMiles = estimate.estimated && estimate.mileage && estimate.mileage > 0 ? estimate.mileage : null;
          const reconciled = reconcileStaleActualWithEstimate({
            actualMiles: roReadingIsStale ? mileage : null,
            actualSource: "open_ro",
            estimateMiles: estMiles,
            // Task #943: no-estimate fallback — project the stale RO reading
            // forward from its date at the default annual rate. Same rule as
            // both partner routes so the shared plan cache keys identically.
            staleReadingDate: roReadingIsStale ? currentRoDate ?? null : null,
          });
          if (reconciled.projectionWon && reconciled.miles) {
            mileage = reconciled.miles;
            mileageEstimated = true;
            mileageEstimatedSource = "estimated_annual";
            mileageEstimateDetails = reconciled.projectionDetails;
            console.log(
              `[Extension] Stale RO odometer projected forward for ${vin}: ` +
              `ro=${(reconciled.projectionDetails as any)?.baseMiles} → projected=${mileage} ` +
              `roDate=${(reconciled.projectionDetails as any)?.baseDate} (no usable CARFAX estimate)`
            );
          } else if (reconciled.estimateWon && reconciled.miles) {
            mileage = reconciled.miles;
            mileageEstimated = true;
            mileageEstimateDetails = {
              confidence: estimate.confidence,
              dataPoints: estimate.dataPoints,
              lastRecordedMileage: estimate.lastRecordedMileage,
              lastRecordedDate: estimate.lastRecordedDate,
              milesPerDay: estimate.milesPerDay,
            };
            console.log(`[Extension] Estimated mileage for ${vin}: ${mileage} mi (${estimate.confidence}, ${estimate.dataPoints} CARFAX points, ${estimate.milesPerDay} mi/day)${roReadingIsStale ? " — estimate won over stale RO reading" : ""}`);
          } else if (roReadingIsStale) {
            console.log(`[Extension] Stale RO odometer retained for ${vin}: ro=${mileage} roDate=${currentRoDate ? new Date(currentRoDate).toISOString() : "n/a"} estimate=${estMiles ?? "none"}`);
          } else {
            console.log(`[Extension] Cannot estimate mileage for ${vin}: ${(estimate as any).reason}`);
          }
        } else if (mileage > 0) {
          console.log(`[Extension] Using actual mileage ${mileage} for ${vin} (not estimating)`);
        }
      } catch (e: any) {
        console.warn(`[Extension] CARFAX mileage estimation failed for ${vin}: ${e.message}`);
      }
    }

    // Last-resort mileage: the stale vehicles snapshot, applied only after the
    // open-RO odometer and the CARFAX estimate have both come up empty. Kept
    // below CARFAX so Detect Dog anchors on the same (fresher) value as the
    // partner VHI endpoint. vehicles.* has no recurring sync, so it's stale.
    if ((!mileage || mileage <= 0) && vehicle) {
      const snapshotMiles = vehicle.currentMileage || vehicle.mileage || vehicle.lastMileage || null;
      if (snapshotMiles && snapshotMiles > 0) {
        mileage = snapshotMiles;
        console.log(`[Extension] Using vehicles snapshot mileage ${mileage} for ${vin} (open RO + CARFAX unavailable)`);
      }
    }

    // Task #649: warn the advisor when the odometer they typed on the open RO
    // disagrees sharply with what we already have on record. Now that the VHI
    // anchors on the entered value (Task #645), a typo (a dropped digit, or a
    // value far below the last reading) drives the overdue/due-soon math
    // directly. This mirrors the partner endpoint's `mileage_discrepancy`
    // signal (lib/plan-build/open-ro-mileage.ts `pickMileageInput`) — it fires
    // when the entered reading is below a higher prior reading beyond the
    // existing tolerance, since an odometer is monotonic. We compare against
    // the entered value itself (not the resolved `mileage`, which the
    // monotonicity guard may have left at the higher prior reading). The flag
    // is advisory only; the math still runs on the anchored mileage.
    let mileageDiscrepancyFlag: ReturnType<typeof buildMileageDiscrepancyFlag> | null = null;
    if (enteredOdometer != null) {
      const shopHistoryReadings = priorKnownMileage != null
        ? [{ mileage: priorKnownMileage, date: currentRoDate ?? null }]
        : [];
      const snapshotMiles = vehicle?.currentMileage || vehicle?.mileage || vehicle?.lastMileage || null;
      const carfaxReadings: { odometer: number; date: string | null }[] = [];
      if (snapshotMiles && snapshotMiles > 0) carfaxReadings.push({ odometer: snapshotMiles, date: null });
      if (mileageEstimateDetails?.lastRecordedMileage) {
        carfaxReadings.push({
          odometer: mileageEstimateDetails.lastRecordedMileage,
          date: mileageEstimateDetails.lastRecordedDate ?? null,
        });
      }
      const discrepancy = detectMileageDiscrepancy({
        currentMiles: enteredOdometer,
        shopHistory: shopHistoryReadings,
        carfaxRecords: carfaxReadings,
        shopHistoryLabel: shopHistoryLabelFromProvider(provider),
      });
      if (discrepancy) {
        mileageDiscrepancyFlag = buildMileageDiscrepancyFlag(discrepancy);
        console.log(
          `[Extension] Mileage discrepancy for ${vin ?? roId}: entered ${enteredOdometer} vs ${discrepancy.priorSource} ${discrepancy.priorMiles} (gap ${discrepancy.gapMiles})`,
        );
      }
    }
    const mileageFlags = mileageDiscrepancyFlag ? [mileageDiscrepancyFlag] : [];

    if (!vin) {
      return NextResponse.json({
        vehicle: null,
        mileage: null,
        overdue: [],
        dueSoon: [],
        recommended: [],
        distanceUnit: shopDistanceUnit,
        message: "VIN not available for this repair order"
      }, { headers: corsHeaders });
    }

    // Task #271: VIN-based gating removed. Still record the view so the
    // running "VINs viewed: N" total stays accurate for admin views.
    try {
      await trackViewedVin(db, mosShopId, vin.toUpperCase(), roId);
    } catch (e: any) {
      console.warn(`[Extension] Failed to record viewed VIN: ${e?.message}`);
    }

    if (provider === "tekmetric" && roId && (!repairOrderNumber || !customerName) && shopDoc?.tekmetric?.shopId) {
      const data = await fetchTekmetricRoCached(String(roId), forceRefresh, mosShopId ? Number(mosShopId) : undefined);
      if (data) {
        if (!repairOrderNumber) repairOrderNumber = data.repairOrderNumber || null;
        if (!customerName) {
          if (data.customer?.firstName && data.customer?.lastName) {
            customerName = `${data.customer.firstName} ${data.customer.lastName}`;
          } else if (data.customer?.name) {
            customerName = data.customer.name;
          } else if (data.customerId) {
            try {
              const { getCachedCustomer, cacheCustomer } = await import("@/lib/integrations/tekmetric/incremental-sync");
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
                const custData = await withUpstreamTimeout(
                  tekmetricRequest(`/customers/${customerId}`, {}, mosShopId ? Number(mosShopId) : undefined),
                  4000,
                  `tekmetric /customers/${customerId}`,
                  null,
                );
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
    // Task #336: pass shop unit so a stale cache built before the unit
    // flip (e.g. shop switched mi→km) is rejected as mismatched and rebuilt.
    const tBeforeCache = Date.now();
    const cachedPlan = !forceRefresh ? await getCachedPlan(db, vin.toUpperCase(), mosShopId, mileage, shopDistanceUnit) : null;
    console.log(`[Extension Plan] TIMING preCache=${tBeforeCache - reqStart}ms cacheLookup=${Date.now() - tBeforeCache}ms cacheHit=${!!cachedPlan} vin=${vin?.toUpperCase()} shop=${mosShopId} mileage=${mileage}`);

    let currentRoDviFindings: Array<{ name: string; status: "red" | "yellow"; dviSource: string; finding?: string }> = [];
    if (provider === "tekmetric" && roId) {
      try {
        const cachedWO = await db.collection("tekmetric_work_orders").findOne({
          workOrderId: String(roId),
          shopId: { $in: [String(mosShopId), Number(mosShopId)] }
        });
        const inspections = cachedWO?.inspections || [];
        for (const inspection of inspections) {
          for (const group of inspection.inspectionTasks || []) {
            for (const task of group.tasks || []) {
              const code = task.inspectionRating?.code;
              if (code === "RQRSATTN") {
                currentRoDviFindings.push({ name: task.name, status: "red", dviSource: "tekmetric", finding: task.finding });
              } else if (code === "MAYRQRATTN") {
                currentRoDviFindings.push({ name: task.name, status: "yellow", dviSource: "tekmetric", finding: task.finding });
              }
            }
          }
          if (currentRoDviFindings.length === 0) {
            for (const item of inspection.items || []) {
              if (item.status === "bad") {
                currentRoDviFindings.push({ name: item.name, status: "red", dviSource: "tekmetric" });
              } else if (item.status === "marginal") {
                currentRoDviFindings.push({ name: item.name, status: "yellow", dviSource: "tekmetric" });
              }
            }
          }
        }
        if (currentRoDviFindings.length > 0) {
          console.log(`[Extension] Tekmetric DVI for current RO ${roId}: ${currentRoDviFindings.length} findings`);
        }
      } catch (err: any) {
        console.warn(`[Extension] Tekmetric DVI fetch failed for RO ${roId}:`, err.message);
      }
    }


    if (cachedPlan && cachedPlan.plan?.buckets) {
      console.log(`[Extension] Using dashboard cached plan: overdue=${cachedPlan.plan.buckets.overdue?.length || 0}, dueSoon=${cachedPlan.plan.buckets.dueSoon?.length || 0}, upcoming=${cachedPlan.plan.buckets.upcoming?.length || 0}, cachedMiles=${cachedPlan.mileage}, currentMiles=${mileage}`);
      if (currentRoAuthorizedJobs.length > 0) {
        const allItems = [...(cachedPlan.plan.buckets.overdue || []), ...(cachedPlan.plan.buckets.dueSoon || []), ...(cachedPlan.plan.buckets.upcoming || [])];
        const oilItem = allItems.find((i: any) => i.serviceKey === 'oil');
        if (oilItem) {
          const sk = oilItem.serviceKey;
          const pats = SERVICE_KEY_PATTERNS[sk];
          const matchResult = currentRoAuthorizedJobs.map((j: string) => `${j}:${pats ? pats.some(p => p.test(j)) : 'no-pats'}`);
          console.log(`[Extension] Oil item debug: title="${oilItem.title}", serviceKey="${sk}", authorizedJobs=[${currentRoAuthorizedJobs.join(', ')}], matchResults=[${matchResult.join(', ')}]`);
        }
      }

      const plan = {
        overdue: [] as any[],
        dueSoon: [] as any[],
        recommended: [] as any[],
        complimentary: [] as any[]
      };
      
      const cachedCurrentMiles = mileage || cachedPlan.plan.currentMiles || 0;
      // Synthetic DVI-only findings have no interval data; they get the
      // overdue icon directly because they were flagged red on inspection.
      const dviSyntheticProgress = computeIntervalProgress({}, null);
      const convertItem = (item: any, bucket?: "overdue" | "dueSoon" | "upcoming" | "complimentary") =>
        convertCachedPlanItemForSidePanel(item, bucket, {
          cachedCurrentMiles,
          currentRoAuthorizedJobs,
          currentRoAllJobs,
          // Task #336: render "5,000 km" / "5,000 mi" to match shop preference.
          distanceUnit: shopDistanceUnit,
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
          if (hideInspectPlanItem(item, showInspectItems)) continue;
          const dueAt = item.dueAtMiles;
          if (isComplimentaryItem(item)) {
            plan.complimentary.push(convertItem(item, "complimentary"));
          } else if (dueAt != null && dueAt > 0) {
            const milesToGo = dueAt - currentMiles;
            let targetBucket: "overdue" | "dueSoon" | "upcoming" =
              currentMiles >= dueAt ? "overdue" :
              (dueAt - currentMiles <= DUE_SOON_THRESHOLD) ? "dueSoon" :
              "upcoming";
            // Refresh milesToGo on the source object BEFORE convertItem so
            // computeIntervalProgress sees the new mileage anchor and the
            // resulting `progress` matches the recategorized bucket.
            item.milesToGo = milesToGo;
            const converted = convertItem(item, targetBucket);
            converted.milesToGo = milesToGo;
            const recat = computeEstimatedDate(converted.milesToGo, item.intervalMiles, item.intervalMonths, item.last?.date, item.dueAtDate);
            converted.daysToGo = recat.daysToGo;
            converted.estimatedDueDate = recat.estimatedDueDate;
            (targetBucket === "overdue" ? plan.overdue : targetBucket === "dueSoon" ? plan.dueSoon : plan.recommended).push(converted);
          } else {
            plan.recommended.push(convertItem(item, "upcoming"));
          }
        }
      } else {
        for (const item of (cachedPlan.plan.buckets.overdue || [])) {
          if (hideInspectPlanItem(item, showInspectItems)) continue;
          if (isComplimentaryItem(item)) { plan.complimentary.push(convertItem(item, "complimentary")); continue; }
          plan.overdue.push(convertItem(item, "overdue"));
        }
        for (const item of (cachedPlan.plan.buckets.dueSoon || [])) {
          if (hideInspectPlanItem(item, showInspectItems)) continue;
          if (isComplimentaryItem(item)) { plan.complimentary.push(convertItem(item, "complimentary")); continue; }
          plan.dueSoon.push(convertItem(item, "dueSoon"));
        }
        for (const item of (cachedPlan.plan.buckets.upcoming || [])) {
          if (hideInspectPlanItem(item, showInspectItems)) continue;
          if (isComplimentaryItem(item)) { plan.complimentary.push(convertItem(item, "complimentary")); continue; }
          plan.recommended.push(convertItem(item, "upcoming"));
        }
      }
      
      if (currentRoDviFindings.length > 0) {
        const dviMap = new Map<string, { status: "red" | "yellow"; name: string; dviSource: string }>();
        const unmappedDvi: Array<{ status: "red" | "yellow"; name: string; dviSource: string }> = [];
        for (const finding of currentRoDviFindings) {
          const key = mapServiceToKey(finding.name);
          if (key) {
            const existing = dviMap.get(key);
            if (!existing || (finding.status === "red" && existing.status !== "red")) {
              dviMap.set(key, finding);
            }
          } else {
            unmappedDvi.push(finding);
          }
        }
        const usedDviKeys = new Set<string>();
        // Iterate in reverse so in-place splice() doesn't skip the next
        // item in the same bucket when a red DVI promotes one to overdue.
        for (const bucket of [plan.overdue, plan.dueSoon, plan.recommended]) {
          for (let idx = bucket.length - 1; idx >= 0; idx--) {
            const item = bucket[idx];
            const itemKey = mapServiceToKey(item.name || item.service);
            if (itemKey && dviMap.has(itemKey)) {
              const dvi = dviMap.get(itemKey)!;
              item.bump = dvi.status;
              item.dviSource = dvi.dviSource;
              usedDviKeys.add(itemKey);
              if (dvi.status === "red" && bucket !== plan.overdue) {
                bucket.splice(idx, 1);
                // Realign icon to new bucket so the side panel shows the
                // overdue icon, matching partner-API triage semantics.
                item.iconStatus = "overdue";
                plan.overdue.push(item);
              } else if (dvi.status === "yellow" && bucket === plan.recommended) {
                // A yellow DVI bumps a recommended item into "due soon"
                // visually; keep the row but escalate the icon.
                if (item.iconStatus === "ok") item.iconStatus = "soon";
              }
            }
          }
        }
        for (const [dviKey, dvi] of dviMap) {
          if (usedDviKeys.has(dviKey)) continue;
          plan.overdue.push({
            name: dvi.name, service: dvi.name, category: "DVI Finding",
            intervalText: "", interval: null, intervalMonths: null,
            intervalSource: "dvi", dueAt: null, milesToGo: null,
            daysToGo: null, estimatedDueDate: null,
            source: "dvi", bump: dvi.status, dviSource: dvi.dviSource,
            last: null, reason: `Flagged ${dvi.status === "red" ? "bad" : "marginal"} on current inspection`,
            approvedThisVisit: isApprovedThisVisit(dvi.name, currentRoAuthorizedJobs, dviKey),
            onCurrentRO: isOnCurrentRO(dvi.name, currentRoAllJobs, dviKey),
            progress: dviSyntheticProgress,
            iconStatus: "overdue",
          });
        }
        for (const unmapped of unmappedDvi) {
          plan.overdue.push({
            name: unmapped.name, service: unmapped.name, category: "DVI Finding",
            intervalText: "", interval: null, intervalMonths: null,
            intervalSource: "dvi", dueAt: null, milesToGo: null,
            daysToGo: null, estimatedDueDate: null,
            source: "dvi", bump: unmapped.status, dviSource: unmapped.dviSource,
            last: null, reason: `Flagged ${unmapped.status === "red" ? "bad" : "marginal"} on current inspection`,
            approvedThisVisit: isApprovedThisVisit(unmapped.name, currentRoAuthorizedJobs),
            onCurrentRO: isOnCurrentRO(unmapped.name, currentRoAllJobs),
            progress: dviSyntheticProgress,
            iconStatus: "overdue",
          });
        }
        console.log(`[Extension] DVI overlay on cached plan: ${dviMap.size + unmappedDvi.length} findings, ${usedDviKeys.size} matched, ${dviMap.size - usedDviKeys.size + unmappedDvi.length} standalone`);
      }

      backgroundPrefetchShopPlans(mosShopId, vin, showInspectItems, shopIntervals, intervalApplyMode, shopDistanceUnit)
        .catch(e => console.error('[Extension Prefetch] Unhandled:', e.message));

      const cachedVehicle = cachedPlan.plan.vehicle || vehicle || {};
      const cachedAuthorizedHash = currentRoAuthorizedJobs.length > 0
        ? currentRoAuthorizedJobs.sort().join('|')
        : null;

      const reportUrl = vin ? buildReportUrl(vin.toUpperCase(), mosShopId) : null;

      if (vin) {
        const approvedServiceKeys = [...plan.overdue, ...plan.dueSoon]
          .filter((i: any) => i.approvedThisVisit && i.serviceKey)
          .map((i: any) => i.serviceKey as string);
        // Task #998: flag-dispatched PG/Mongo facade writes (fire-and-forget).
        if (approvedServiceKeys.length > 0) {
          upsertReportApprovedItemsDoc(mosShopId, vin, approvedServiceKeys, db).catch(() => {});
        } else {
          deleteReportApprovedItemsDoc(mosShopId, vin, db).catch(() => {});
        }
      }

      console.log(`[Extension Plan] TIMING CACHE_HIT_RETURN total=${Date.now() - reqStart}ms vin=${vin?.toUpperCase()} shop=${mosShopId}`);
      return NextResponse.json({
        vehicle: { ...cachedVehicle, vin: cachedVehicle.vin || vin?.toUpperCase() || null },
        mileage: cachedPlan.plan.currentMiles || mileage,
        mileageEstimated,
        mileageEstimateDetails: mileageEstimated ? mileageEstimateDetails : undefined,
        flags: mileageFlags,
        distanceUnit: shopDistanceUnit,
        ...plan,
        deferredWork: cachedPlan.plan.deferredWork || [],
        fromDashboardCache: true,
        repairOrderNumber,
        customerName,
        shopLogo: shopDoc?.branding?.logo || null,
        locationIdentifier: shopDoc?.locationIdentifier || shopDoc?.name || null,
        authorizedJobsHash: cachedAuthorizedHash,
        reportUrl,
      }, { headers: corsHeaders });
    }
    
    // Fall back to running our own analysis if no cached plan
    console.log(`[Extension] No dashboard cache, running on-demand analysis`);
    
    // Task #998: flag-dispatched PG/Mongo facade read.
    let analysisData: any = await getMaintenanceAnalysisDoc(mosShopId, vin, db);

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

    // Task #175: treat pre-Task-#175 cached analyses as stale so installs
    // pick up engineRiskFlag/engineRiskReason + the auto-inserted Safety
    // Check — Oil Level row without manual reload.
    const cachedSchemaVersion = analysisData?.schemaVersion ?? 1;
    const schemaStale = cachedSchemaVersion < ANALYSIS_CACHE_SCHEMA_VERSION;

    console.log(`[Extension] Analysis cache check: exists=${!!analysisData}, age=${Math.round(analysisAge/1000)}s, hasRecs=${hasRecommendations}, prefsChanged=${prefsChanged}, mileageChanged=${mileageChanged} (cached=${cachedAnalysisMileage}, current=${currentAnalysisMileage}), schemaVersion=${cachedSchemaVersion}/${ANALYSIS_CACHE_SCHEMA_VERSION}${schemaStale ? " STALE" : ""}`);

    if (!analysisData || forceRefresh || analysisAge > maxAge || prefsChanged || !hasRecommendations || mileageChanged || schemaStale) {
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
        
        let tekDviFindings: Array<{ name?: string; status?: string | number; source?: string; finding?: string }> = [];
        if (provider === "tekmetric" && roId) {
          try {
            const cachedWOForDvi = await db.collection("tekmetric_work_orders").findOne({
              workOrderId: String(roId),
              shopId: { $in: [String(mosShopId), Number(mosShopId)] }
            });
            const inspectionsForDvi = cachedWOForDvi?.inspections || [];
            for (const inspection of inspectionsForDvi) {
              for (const group of inspection.inspectionTasks || []) {
                for (const task of group.tasks || []) {
                  const code = task.inspectionRating?.code;
                  if (code === "RQRSATTN") {
                    tekDviFindings.push({ name: task.name, status: "0", source: "tekmetric", finding: task.finding });
                  } else if (code === "MAYRQRATTN") {
                    tekDviFindings.push({ name: task.name, status: "1", source: "tekmetric", finding: task.finding });
                  }
                }
              }
              if (tekDviFindings.length === 0) {
                for (const item of inspection.items || []) {
                  if (item.status === "bad") {
                    tekDviFindings.push({ name: item.name, status: "0", source: "tekmetric" });
                  } else if (item.status === "marginal") {
                    tekDviFindings.push({ name: item.name, status: "1", source: "tekmetric" });
                  }
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

        // Task #860: merge findings parsed from public DVI share links found
        // on Protractor WOs (AutoServe1, avlink.io, AutoFlow microsites, …)
        // so the extension's on-demand branch matches plan-build. Read-only;
        // returns [] unless links have been ingested.
        const dviLinkFindings = await gatherDviLinkFindings(mosShopId, vin);
        const combinedDviFindings = [...tekDviFindings, ...dviLinkFindings];

        const tBeforeAnalysis = Date.now();
        const recommendations = await runOnDemandAnalysis(
          mosShopId, vin, mileage, showInspectItems, shopIntervals, carfaxRecords,
          { oemResult, shopWorkOrders },
          combinedDviFindings.length > 0 ? combinedDviFindings : undefined,
          intervalApplyMode,
          currentRoAuthorizedJobs,
          currentRoAllJobs,
          // Task #336: forwarded so OEM intervals are converted to the
          // shop's unit (km for Canadian shops) before being persisted to
          // maintenance_analysis_cache + rendered in the side panel.
          shopDistanceUnit,
          // Task #384: persist mileage provenance on the analysis cache so
          // the external VHI endpoint echoes the same fields when it
          // serves from this fallback.
          mileageEstimated ? mileageEstimatedSource : "actual",
          mileageEstimated ? mileageEstimateDetails : null,
        );
        console.log(`[Extension Plan] TIMING runOnDemandAnalysis=${Date.now() - tBeforeAnalysis}ms parallelFetch=${tBeforeAnalysis - startTime}ms vin=${vin?.toUpperCase()}`);
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

    // Look up enriched canned jobs to include full labor/parts details.
    // Gated repo (task #1000): PG-canonical when CANNED_JOBS_PG_CANONICAL=1,
    // else the verbatim Mongo `find({ shopId, enriched: true })`.
    const cannedJobs = await findEnrichedCannedJobs(mosShopId);
    
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
        
        const existingDueDate2 = (rec.daysToGo != null && rec.daysToGo > 0)
          ? new Date(Date.now() + rec.daysToGo * 86400000).toISOString()
          : rec.dueAtDate || null;
        const est2 = computeEstimatedDate(rec.milesToGo, rec.interval || rec.intervalMiles, rec.intervalMonths, rec.last?.date, existingDueDate2);
        let itemDaysToGo = est2.daysToGo;
        let itemEstDate = est2.estimatedDueDate;
        const recProgress = computeIntervalProgress(
          {
            intervalMiles: rec.interval || rec.intervalMiles || null,
            intervalMonths: rec.intervalMonths || null,
            last: rec.last || null,
            dueAtMiles: rec.dueMileage ?? null,
            dueAtDate: rec.dueAtDate ?? null,
            milesToGo: rec.milesToGo ?? null,
          },
          mileage || null,
          undefined,
          shopDistanceUnit
        );
        const nameForCheck = { serviceKey: rec.serviceKey || "", key: rec.key || "", title: rec.service || rec.name || "" };
        const recBucket: "overdue" | "dueSoon" | "upcoming" | "complimentary" =
          isComplimentaryItem(nameForCheck) ? "complimentary" :
          (rec.status === "overdue" || rec.isOverdue) ? "overdue" :
          (rec.status === "due_soon" || rec.isDueSoon) ? "dueSoon" :
          "upcoming";
        const item = {
          name: rec.service || rec.name,
          serviceKey: rec.serviceKey || null,
          category: rec.category || null,
          dueAt: rec.dueMileage,
          milesToGo: rec.milesToGo,
          daysToGo: itemDaysToGo,
          estimatedDueDate: itemEstDate,
          interval: rec.interval,
          intervalMonths: rec.intervalMonths,
          intervalText: rec.intervalText || `OEM: ${(rec.interval || 0).toLocaleString()} ${getDistanceLabel(shopDistanceUnit)}`,
          intervalSource: rec.intervalSource || 'oem',
          source: rec.source || "oe",
          lastPerformedBy: rec.lastPerformedBy || rec.last?.source || null,
          lastPerformedMileage: rec.lastPerformedMileage || rec.last?.miles || null,
          last: rec.last || null,
          priority: rec.priority,
          laborItems: matchingCannedJob?.laborLines || [],
          parts: matchingCannedJob?.partLines || rec.parts || [],
          laborHours: matchingCannedJob?.laborLines?.reduce((sum: number, l: any) => sum + (l.hours || 0), 0) || rec.laborHours || 1,
          amount: matchingCannedJob?.totalAmount || 0,
          cannedJobId: matchingCannedJob?._id?.toString() || null,
          reason: rec.reason,
          bump: rec.bump || null,
          dviSource: rec.dviSource || null,
          // Task #175: surface engine-aware oil warning + the auto-inserted
          // Safety Check — Oil Level row's metadata in the side panel.
          engineRiskFlag: !!rec.engineRiskFlag,
          engineRiskReason: rec.engineRiskReason ?? null,
          recommendedDefault: !!rec.recommendedDefault,
          recommendedReason: rec.recommendedReason ?? null,
          approvedThisVisit: isApprovedThisVisit(rec.service || rec.name, currentRoAuthorizedJobs, rec.serviceKey || undefined),
          onCurrentRO: isOnCurrentRO(rec.service || rec.name, currentRoAllJobs, rec.serviceKey || undefined),
          // Declined-job flag (same shape as the cached-plan path's
          // `item.declined`) so the side panel shows the Declined badge on
          // on-demand-analysis plans too.
          declined: rec.declined || null,
          progress: recProgress,
          // Bucket-driven (matches partner API semantics): an item triaged
          // into "overdue" always shows the overdue icon even if it had no
          // mileage anchors for progress math.
          iconStatus:
            recBucket === "overdue" ? "overdue" :
            recBucket === "dueSoon" ? "soon" :
            (recBucket === "upcoming" || recBucket === "complimentary") ? "ok" :
            (recProgress.status ?? null),
        };

        if (recBucket === "complimentary") plan.complimentary.push(item);
        else if (recBucket === "overdue") plan.overdue.push(item);
        else if (recBucket === "dueSoon") plan.dueSoon.push(item);
        else plan.recommended.push(item);
      }
    }

    backgroundPrefetchShopPlans(mosShopId, vin, showInspectItems, shopIntervals, intervalApplyMode, shopDistanceUnit)
      .catch(e => console.error('[Extension Prefetch] Unhandled:', e.message));

    const authorizedJobsHash = currentRoAuthorizedJobs.length > 0
      ? currentRoAuthorizedJobs.sort().join('|')
      : null;

    const reportUrl2 = vin ? buildReportUrl(vin.toUpperCase(), mosShopId) : null;

    if (vin) {
      const approvedServiceKeys = [...plan.overdue, ...plan.dueSoon]
        .filter((i: any) => i.approvedThisVisit && i.serviceKey)
        .map((i: any) => i.serviceKey as string);
      // Task #998: flag-dispatched PG/Mongo facade writes (fire-and-forget).
      if (approvedServiceKeys.length > 0) {
        upsertReportApprovedItemsDoc(mosShopId, vin, approvedServiceKeys, db).catch(() => {});
      } else {
        deleteReportApprovedItemsDoc(mosShopId, vin, db).catch(() => {});
      }
    }

    console.log(`[Extension Plan] TIMING FALLBACK_RETURN total=${Date.now() - reqStart}ms vin=${vin?.toUpperCase()} shop=${mosShopId} analyzed=${!!analysisData}`);
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
      flags: mileageFlags,
      distanceUnit: shopDistanceUnit,
      overdue: plan.overdue,
      dueSoon: plan.dueSoon,
      recommended: plan.recommended,
      complimentary: plan.complimentary,
      analyzed: !!analysisData,
      repairOrderNumber,
      customerName,
      shopLogo: shopDoc?.branding?.logo || null,
      locationIdentifier: shopDoc?.locationIdentifier || shopDoc?.name || null,
      authorizedJobsHash,
      reportUrl: reportUrl2,
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error("[Extension Plan] Error:", error);
    return NextResponse.json(
      { error: "Failed to load plan" },
      { status: 500, headers: corsHeaders }
    );
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const GET = withExtensionErrorMarker(_GET as any);
