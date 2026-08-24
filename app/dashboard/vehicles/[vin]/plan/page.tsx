import { Suspense } from "react";
import Link from "next/link";
import OilDutyToggle from "@/components/plan/OilDutyToggle";
import { getDb } from "@/lib/mongo";
import { findLatestEventByVin as findLatestAutoflowEventByVin } from "@/lib/data/repositories/autoflow-cache";
import { getLatestRepairOrderMilesRecordForVin } from "@/lib/miles";
import { requireSession } from "@/lib/auth";
import { 
  resolveAutoflowConfig, 
  fetchDviWithCache 
} from "@/lib/integrations/autoflow";
import { 
  resolveCarfaxConfig, 
  fetchCarfaxWithCache,
  estimateMileageFromCarfax,
  getCachedCarfaxRecalls
} from "@/lib/integrations/carfax";
import { mergeRecallsWithCarfax, type CarfaxRecallRecord } from "@/lib/carfax-recalls";
import { getMaintenanceScheduleCached } from "@/lib/integrations/dataone-api";
import {
  type EngineProfile,
  type EngineRiskResult,
  classifyEngineRisk,
  loadEngineRiskOverrides,
  OIL_INTERVAL_RISK_THRESHOLD_MILES,
  SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES,
  SAFETY_CHECK_OIL_LEVEL_KEY,
  SAFETY_CHECK_OIL_LEVEL_TITLE,
} from "@/lib/engine-risk";
import { getVehicleRecallsLocal, getEnhancedVehicleDataLocal, type VehicleRecall } from "@/lib/integrations/dataone-local";
import {
  resolveProtractorConfig,
  fetchVehicleWithCache as fetchProtractorVehicle,
  fetchDeferredWorkWithCache as fetchProtractorDeferredWork,
  fetchCannedJobsWithCache,
  type ProtractorDeferredWork,
} from "@/lib/integrations/protractor";
import {
  resolveAutoVitalsConfig,
  fetchAutoVitalsInspectionByVin,
} from "@/lib/integrations/autovitals";
import { AddToROButton } from "@/components/ui/AddToROButton";
import { AddToROWithHistory } from "@/components/ui/AddToROWithHistory";
import { AddAllDeferredButton } from "@/components/ui/AddAllDeferredButton";
import { PlanTrialGate } from "@/components/ui/PlanTrialGate";
import { PrintButton } from "@/components/ui/PrintButton";
import { CarfaxMatchBadge } from "@/components/ui/CarfaxMatchBadge";
import ServiceIcon from "@/components/vehicle-health-report/ServiceIcon";
import { getCachedPlan, setCachedPlan, type CachedPlanData, type TriagedItemCache, type CachedPlanVariant } from "@/lib/plan-cache";
import {
  getEnabledChemicalProviders,
  providerIntervalsToOverrides,
} from "@/lib/plan-build/chemical-providers";
import { evaluateBgLppEligibility } from "@/lib/plan-build/provider-templates";
import PlanTabs, { type TabBadge } from "@/components/plan/PlanTabs";
import ProtectionPlanControls from "@/components/plan/ProtectionPlanControls";
import {
  computeLapseRisk,
  detectProviderEligibility,
  resolveProtectionPlanStatus,
  type ProtectionPlanStatus,
} from "@/lib/plan-build/protection-plan";
import { listEnrollmentsForVehicle } from "@/lib/data/repositories/protection-plan-enrollments";
import { listJobNamesForVehicle } from "@/lib/data/repositories/job-index";
import { gatherDviLinkFindings } from "@/lib/dvi-links/plan-findings";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import AutoDviPanel from "./AutoDviPanel";
import { ShareReportButton } from "@/components/ui/ShareReportButton";
import { IntervalProgressRow } from "@/components/ui/IntervalProgressRow";
import { getProgressTriggers, formatTriggerSuffix } from "@/lib/vhi-progress";
import PlanLoading from "./loading";
import { getOELogoUrl } from "@/lib/oe-logos";
import {
  LIFETIME_FLUID_DEFAULT_MILES,
  isLifetimeFluidItem,
  isInspectOnlyFluidItem,
  parseServiceAction,
  splitServicePhrases,
  isInspectOnlyHistoryPhrase,
  INSPECTION_SERVICE_KEYS,
  type ServiceAction,
} from "@/lib/service-keys";
import { listTekmetricDeferredWorkByVin } from "@/lib/data/repositories/tekmetric-deferred-work";
import { getShopDviBestPracticeMap } from "@/lib/dvi-best-practices";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";

export const runtime = "nodejs";

// Per-call upstream budgets for the dashboard VHI build. These cap each slow
// external/Mongo call so a stalled upstream degrades to cached/partial data
// instead of hanging the page (the loading UI promises "up to 30 seconds").
// Budgets are sized so the worst-case SEQUENTIAL cache-miss path stays under
// ~28s: canned 5 + early-miles 2 + events 2 + RO-source 2.5 + external group 7
// + deferred 5 + miles/OEM group 5 = ~28.5s (calls inside a single Promise.all
// run concurrently and count once). Every timeout logs one [upstream-timeout]
// line in BetterStack so stalls become visible. Note: withUpstreamTimeout uses
// Promise.race and does NOT cancel the underlying op — the loser keeps running
// in the background; acceptable here since each wrapped call is bounded work.
const VHI_EXTERNAL_FETCH_TIMEOUT_MS = 7000; // DVI, CARFAX, Protractor vehicle, AutoVitals
const VHI_CANNED_TIMEOUT_MS = 5000; // Protractor canned-jobs (can paginate)
const VHI_DEFERRED_TIMEOUT_MS = 5000; // Protractor deferred work
const VHI_OEM_TIMEOUT_MS = 5000; // DataOne maintenance schedule
const VHI_MILES_TIMEOUT_MS = 2000; // Mongo mileage lookup
const VHI_EVENTS_TIMEOUT_MS = 2000; // Mongo events RO aggregate
const VHI_DB_TIMEOUT_MS = 2500; // Mongo scan-style queries (RO-source + completed-WO finds)
// Task #737: total-build duration at/above which a [PlanSlowLoad] line (and
// a `slow_plan_load_logs` record) is emitted, even if no single budget blew.
const SLOW_PLAN_LOAD_THRESHOLD_MS = 5000;
export const dynamic = "force-dynamic";

/* ---------------- small utils ---------------- */
type DistanceUnit = "miles" | "kilometers";
const MILES_TO_KM = 1.60934;

// Task #333: distance values flowing through the plan are now stored in the
// shop's local unit (kilometers for Canadian shops, miles otherwise). OEM
// `intervalMiles` is converted exactly once at intake inside `triage()`, so
// the display layer just formats the number — no further conversion.
function fmtDistance(m?: number | null, _unit: DistanceUnit = "miles") {
  if (m === 0) return "0";
  if (m == null) return "";
  return m.toLocaleString();
}

function fmtMiles(m?: number | null) {
  if (m === 0) return "0";
  if (m == null) return "";
  return m.toLocaleString();
}

function getDistanceLabel(unit: DistanceUnit): string {
  return unit === "kilometers" ? "km" : "mi";
}
function daysBetween(a: Date, b: Date) {
  const ms = Math.abs(a.getTime() - b.getTime());
  return ms / (1000 * 60 * 60 * 24);
}
function addMonths(d: Date, months: number) {
  const dt = new Date(d);
  dt.setMonth(dt.getMonth() + months);
  return dt;
}
function parseCarfaxDate(d?: string | null): Date | null {
  if (!d) return null;
  const trimmed = String(d).trim();
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mm = Number(m[1]), dd = Number(m[2]), yy = Number(m[3]);
    const dt = new Date(yy, mm - 1, dd);
    return isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(trimmed);
  return isNaN(dt.getTime()) ? null : dt;
}
function toSquish(vin: string) {
  const v = String(vin).toUpperCase().trim();
  return v.slice(0, 8) + v.slice(9, 11);
}

function formatOverdueDate(date: Date | null | undefined): { text: string; isVeryOverdue: boolean; yearsOverdue: number } {
  if (!date) return { text: "", isVeryOverdue: false, yearsOverdue: 0 };
  const now = new Date();
  const daysPast = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  const yearsOverdue = Math.floor(daysPast / 365);
  const monthsOverdue = Math.floor(daysPast / 30);
  
  let text = date.toLocaleDateString();
  if (yearsOverdue >= 1) {
    text = `${date.toLocaleDateString()} (${yearsOverdue}+ years overdue)`;
  } else if (monthsOverdue >= 6) {
    text = `${date.toLocaleDateString()} (${monthsOverdue} months overdue)`;
  }
  
  return { 
    text, 
    isVeryOverdue: yearsOverdue >= 1 || monthsOverdue >= 6,
    yearsOverdue 
  };
}

/* ---------------- Smart mileage interpolation for CARFAX gaps ---------------- */
type CarfaxRecordWithParsed = {
  date: Date | null;
  miles: number | null;
  description?: string;
};

function fillCarfaxMileageGaps(
  records: Array<{ date?: string; odometer?: number; description?: string }>,
  opts: { today: Date; currentMiles: number | null; defaultRate: number | null }
): CarfaxRecordWithParsed[] {
  // Parse and sort by date ascending
  const parsed: CarfaxRecordWithParsed[] = records.map(r => ({
    date: parseCarfaxDate(r.date ?? null),
    miles: typeof r.odometer === "number" && r.odometer > 0 ? r.odometer : null,
    description: r.description,
  }));

  // Sort by date (nulls at end)
  parsed.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.getTime() - b.date.getTime();
  });

  // Build list of records with known mileage for interpolation reference
  const knownPoints: Array<{ date: Date; miles: number; index: number }> = [];
  for (let i = 0; i < parsed.length; i++) {
    const rec = parsed[i];
    if (rec.date && rec.miles != null) {
      knownPoints.push({ date: rec.date, miles: rec.miles, index: i });
    }
  }

  // Add current mileage as a reference point if available
  if (opts.currentMiles != null) {
    knownPoints.push({ date: opts.today, miles: opts.currentMiles, index: -1 });
    knownPoints.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  // Fill gaps using interpolation or extrapolation
  for (let i = 0; i < parsed.length; i++) {
    const rec = parsed[i];
    if (rec.miles != null || !rec.date) continue; // Already has miles or no date

    const recTime = rec.date.getTime();

    // Find closest known points before and after
    let before: { date: Date; miles: number; index: number } | null = null;
    let after: { date: Date; miles: number; index: number } | null = null;

    for (const kp of knownPoints) {
      if (kp.date.getTime() <= recTime) {
        before = kp;
      } else if (!after) {
        after = kp;
        break;
      }
    }

    if (before && after) {
      // Interpolate between two known points
      const totalDays = (after.date.getTime() - before.date.getTime()) / (1000 * 60 * 60 * 24);
      const daysSinceBefore = (recTime - before.date.getTime()) / (1000 * 60 * 60 * 24);
      
      if (totalDays > 0) {
        const ratio = daysSinceBefore / totalDays;
        const estimated = Math.round(before.miles + ratio * (after.miles - before.miles));
        // Clamp to ensure monotonic (between before and after)
        rec.miles = Math.max(before.miles, Math.min(after.miles, estimated));
      } else {
        rec.miles = before.miles;
      }
    } else if (before) {
      // Extrapolate forward from the last known point
      // Find rate from before's surrounding points
      const beforeIdx = knownPoints.indexOf(before);
      if (beforeIdx > 0) {
        const prevPoint = knownPoints[beforeIdx - 1];
        const days = (before.date.getTime() - prevPoint.date.getTime()) / (1000 * 60 * 60 * 24);
        if (days > 0) {
          const rate = (before.miles - prevPoint.miles) / days;
          const daysSince = (recTime - before.date.getTime()) / (1000 * 60 * 60 * 24);
          rec.miles = Math.round(before.miles + rate * daysSince);
        }
      } else if (opts.defaultRate != null) {
        // Use default rate
        const daysSince = (recTime - before.date.getTime()) / (1000 * 60 * 60 * 24);
        rec.miles = Math.round(before.miles + opts.defaultRate * daysSince);
      }
    } else if (after) {
      // Extrapolate backward from the first known point
      // Find rate from after's surrounding points
      const afterIdx = knownPoints.indexOf(after);
      if (afterIdx < knownPoints.length - 1) {
        const nextPoint = knownPoints[afterIdx + 1];
        const days = (nextPoint.date.getTime() - after.date.getTime()) / (1000 * 60 * 60 * 24);
        if (days > 0) {
          const rate = (nextPoint.miles - after.miles) / days;
          const daysBefore = (after.date.getTime() - recTime) / (1000 * 60 * 60 * 24);
          rec.miles = Math.round(after.miles - rate * daysBefore);
        }
      } else if (opts.defaultRate != null) {
        // Use default rate going backward
        const daysBefore = (after.date.getTime() - recTime) / (1000 * 60 * 60 * 24);
        rec.miles = Math.round(after.miles - opts.defaultRate * daysBefore);
      }
    }

    // Ensure non-negative
    if (rec.miles != null && rec.miles < 0) rec.miles = null;
  }

  return parsed;
}

/* ---------------- Get latest miles from multiple sources ---------------- */
async function getLatestMilesForVin(db: any, vinRaw: string): Promise<{ miles: number | null; recordedDate: Date | null }> {
  const vin = String(vinRaw || "").toUpperCase();
  const toPos = (v: unknown) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // Latest RO mileage (normalized_work_orders PG — task #1000)
  const roRecord = await getLatestRepairOrderMilesRecordForVin(vin);
  const mRO = toPos(roRecord.miles);
  const dRO = roRecord.recordedDate || null;

  // Latest event with mileage
  const af = await db.collection("events").aggregate([
    {
      $match: {
        $expr: {
          $eq: [
            { $toUpper: { $ifNull: ["$vehicleVin", { $ifNull: ["$vin", "$payload.vehicle.vin"] }] } },
            vin,
          ],
        },
      },
    },
    { $sort: { createdAt: -1 } },
    { $limit: 10 },
    {
      $project: {
        createdAt: 1,
        mileage: {
          $ifNull: [
            "$payload.ticket.mileage",
            {
              $ifNull: [
                "$payload.mileage",
                { $ifNull: ["$payload.vehicle.mileage", { $ifNull: ["$payload.vehicle.miles", "$payload.vehicle.odometer"] }] },
              ],
            },
          ],
        },
      },
    },
  ]).toArray();
  const afMatch = af.find((x: any) => toPos(x?.mileage) != null);
  const mAF = afMatch ? toPos(afMatch.mileage) : null;
  const dAF = afMatch?.createdAt || null;

  // Vehicle-level odometer/lastMileage/mileage (Tekmetric stores as mileage)
  const veh = await db.collection("vehicles").findOne({ vin }, { projection: { odometer: 1, lastMileage: 1, mileage: 1, updatedAt: 1 } });
  const mVeh = toPos(veh?.mileage) ?? toPos(veh?.odometer) ?? toPos(veh?.lastMileage);
  const dVeh = veh?.updatedAt || null;

  // Return the most recent mileage reading (by date) to ensure projection uses the latest data point
  const candidates: { miles: number; date: Date | null }[] = [];
  if (mRO != null) candidates.push({ miles: mRO, date: dRO ? new Date(dRO) : null });
  if (mAF != null) candidates.push({ miles: mAF, date: dAF ? new Date(dAF) : null });
  if (mVeh != null) candidates.push({ miles: mVeh, date: dVeh ? new Date(dVeh) : null });

  if (candidates.length === 0) return { miles: null, recordedDate: null };
  // Prefer candidate with most recent date; fall back to highest miles if no dates
  const withDates = candidates.filter(c => c.date != null);
  if (withDates.length > 0) {
    withDates.sort((a, b) => b.date!.getTime() - a.date!.getTime());
    return { miles: withDates[0].miles, recordedDate: withDates[0].date };
  }
  candidates.sort((a, b) => b.miles - a.miles);
  return { miles: candidates[0].miles, recordedDate: null };
}

/* ---------------- Normalization / rules engine ---------------- */
type OEMItem = {
  maintenance_id: number;
  name: string;
  category: string;
  notes?: string | null;
  miles?: number | null;
  months?: number | null;
  intervals?: Array<{ units?: string | null; value?: number | null }>;
  // Task #166: duty-cycle aware intervals from DataOne.
  intervalMilesNormal?: number | null;
  intervalMonthsNormal?: number | null;
  intervalMilesSevere?: number | null;
  intervalMonthsSevere?: number | null;
};
type LastDone = {
  miles?: number | null;
  date?: Date | null;
  source?: "carfax" | "protractor" | "shop";
  /** Task #434: stable id of the parent service when the anchor was implied. */
  impliedFromParentKey?: string | null;
  /** Task #434: human-readable parent service name for implied anchors. */
  impliedFromParentName?: string | null;
};

// Display names for normalized service keys
const SERVICE_KEY_DISPLAY_NAMES: Record<string, string> = {
  oil: "Oil Change",
  tire_rotation: "Tire Rotation",
  cabin_air: "Cabin Air Filter",
  engine_air: "Engine Air Filter",
  coolant: "Coolant Service",
  brake_fluid: "Brake Fluid Service",
  trans_auto: "Automatic Transmission Fluid",
  trans_manual: "Manual Transmission Fluid",
  transfer_case: "Transfer Case Fluid",
  front_differential: "Front Differential Fluid",
  rear_differential: "Rear Differential Fluid",
  power_steering: "Power Steering Fluid",
  fuel_filter: "Fuel Filter",
  spark_plugs: "Spark Plugs",
  serpentine_belt: "Serpentine Belt",
  timing_belt: "Timing Belt",
  fuel_system: "Fuel System Cleaning",
  front_brake_pads: "Front Brake Pads",
  rear_brake_pads: "Rear Brake Pads",
  front_brake_rotors: "Front Brake Rotors",
  rear_brake_rotors: "Rear Brake Rotors",
  front_shocks: "Front Shocks / Struts",
  rear_shocks: "Rear Shocks / Struts",
  wheel_alignment: "Wheel Alignment",
  battery: "Battery",
  wiper_blades: "Wiper Blades",
  ac_refrigerant: "A/C Service",
  emissions: "Emissions Inspection",
};

// Service key mappings aligned with CARFAX categories
// Note: Order matters - more specific patterns should come first to avoid false matches
const SERVICE_KEYS: Record<string, string[]> = {
  oil: [
    "oil and filter", "engine oil", "oil change", "replace engine oil", 
    "oil filter", "replace oil filter", "change oil", "motor oil",
    "crankcase oil", "oil & filter", "synthetic oil"
  ],
  tire_rotation: ["rotate tires", "tire rotation", "rotate tyre", "tires rotated", "rotate wheels"],
  cabin_air: ["cabin air filter", "cabin filter", "pollen filter", "hvac filter", "interior air filter"],
  engine_air: [
    "engine air filter", "air cleaner element", "air filter element",
    "remove & replace air filter", "air filter replace", "replace air filter"
  ],
  coolant: [
    "engine coolant", "coolant flush", "replace coolant", "cooling system", 
    "antifreeze", "radiator flush", "drain and fill coolant", "coolant service",
    "bg coolant", "cooling system service"
  ],
  brake_fluid: [
    "brake fluid", "dot4", "dot 4", "dot3", "dot 3", "brake flush", 
    "brake fluid service", "brake fluid change", "brake fluid flush"
  ],
  trans_auto: [
    "automatic transmission fluid", "atf fluid", "atf flush", "auto trans fluid",
    "transmission service", "transmission flush", "bg automatic transmission",
    "transmission fluid service"
  ],
  trans_manual: ["manual transmission fluid", "manual trans fluid", "mtf fluid"],
  transfer_case: ["transfer case fluid", "transfer case flush", "transfer case oil"],
  front_differential: [
    "front differential", "front axle fluid", "front diff",
    "front differential fluid", "front differential service"
  ],
  rear_differential: [
    "rear differential", "rear axle fluid", "rear diff",
    "rear differential fluid", "rear differential service", "gear oil"
  ],
  power_steering: ["power steering fluid", "power steering flush", "power steering service"],
  fuel_filter: ["fuel filter"],
  spark_plugs: ["spark plug", "spark plugs", "ignition tune", "tune-up", "tune up"],
  serpentine_belt: ["serpentine belt", "drive belt", "accessory belt", "v-belt", "fan belt"],
  timing_belt: ["timing belt", "timing chain", "cam belt", "replace timing belt"],
  fuel_system: [
    "fuel system cleaning", "fuel injector cleaning", "fuel system service", "fuel induction",
    "bg fuel", "bg platinum fuel", "induction cleaning", "throttle body cleaning"
  ],
  front_brake_pads: [
    "front brake pads", "front brake lining", "front brakes replaced",
    "front brake pads replaced", "front disc brake"
  ],
  rear_brake_pads: [
    "rear brake pads", "rear brake lining", "rear brakes replaced",
    "rear brake pads replaced", "rear disc brake", "brake shoes"
  ],
  front_brake_rotors: [
    "front brake rotor", "front rotor", "front brake rotors replaced"
  ],
  rear_brake_rotors: [
    "rear brake rotor", "rear rotor", "rear brake rotors replaced"
  ],
  front_shocks: ["front shock", "front strut", "front shocks", "front struts"],
  rear_shocks: ["rear shock", "rear strut", "rear shocks", "rear struts"],
  wheel_alignment: ["wheel alignment", "alignment", "all wheel alignment", "front alignment", "rear alignment"],
  battery: ["battery replaced", "battery replacement", "battery/charging", "replace battery", "new battery"],
  wiper_blades: [
    "wiper blade", "windshield wiper", "wiper replace", "wiper insert",
    "replace wiper", "wiper blades"
  ],
  ac_refrigerant: [
    "a/c refrigerant", "ac refrigerant", "air conditioning refill", 
    "a/c recharge", "ac recharge", "refrigerant", "r-134a", "r134a",
    "a/c service", "ac service", "air conditioning service"
  ],
  emissions: ["emissions test", "emissions inspection", "smog test", "smog check", "emission test"],
};

function toKeyFromName(name: string): string | null {
  const n = name.toLowerCase();
  
  if (n.includes("cabin") && n.includes("air") && n.includes("filter")) return "cabin_air";
  
  for (const [key, vals] of Object.entries(SERVICE_KEYS)) {
    if (vals.some((v) => n.includes(v))) return key;
  }
  
  if (n.includes("air filter") && !n.includes("cabin")) return "engine_air";
  if (n.includes("exhaust system")) return "exhaust";
  if (n.includes("transmission fluid") || n.includes("transmission flush")) return "trans_auto";
  if (n.includes("differential") && !n.includes("front") && !n.includes("rear")) return "rear_differential";
  if (n.includes("shock") || n.includes("strut")) {
    if (n.includes("front")) return "front_shocks";
    if (n.includes("rear")) return "rear_shocks";
    return "front_shocks";
  }
  if (n.includes("brake rotor") || n.includes("rotor replaced") || n.includes("rotor(s) replaced")) {
    if (n.includes("front")) return "front_brake_rotors";
    if (n.includes("rear")) return "rear_brake_rotors";
    return "front_brake_rotors";
  }
  if (n.includes("brake pad") || n.includes("brake lining") || n.includes("brakes replaced") || n.includes("brakes serviced") || n.includes("disc brake")) {
    if (n.includes("front")) return "front_brake_pads";
    if (n.includes("rear")) return "rear_brake_pads";
    return "front_brake_pads";
  }
  return null;
}

function toKeyFromFreeText(desc: string): string[] {
  const d = desc.toLowerCase();
  const hits: string[] = [];
  for (const [key, vals] of Object.entries(SERVICE_KEYS)) {
    if (vals.some((v) => d.includes(v))) hits.push(key);
  }
  if (d.includes("oil") && !hits.includes("oil")) hits.push("oil");
  if (d.includes("rotate") && d.includes("tire") && !hits.includes("tire_rotation")) hits.push("tire_rotation");
  return Array.from(new Set(hits));
}

// Resolve free-text history (CARFAX record / shop line item) to the service
// keys it should ANCHOR as "last done", verb-guarding each phrase so an
// inspection ("Drive belts checked") never resets a replacement clock. CARFAX
// joins multiple bullet lines with "; " so we split first and guard per phrase.
// Only INSPECTION_SERVICE_KEYS (e.g. emissions) may be anchored by an inspect
// verb. Mirrors toAnchorKeysFromHistory in lib/service-keys.ts but reuses this
// page's local key dictionary so anchor keys stay aligned with toKeyFromName.
function toAnchorKeysLocal(text: string): string[] {
  const out = new Set<string>();
  for (const phrase of splitServicePhrases(text)) {
    const keys = toKeyFromFreeText(phrase);
    if (keys.length === 0) continue;
    const inspectOnly = isInspectOnlyHistoryPhrase(phrase);
    for (const k of keys) {
      if (inspectOnly && !INSPECTION_SERVICE_KEYS.has(k)) continue;
      out.add(k);
    }
  }
  return Array.from(out);
}

// Find CARFAX records that may have addressed deferred work
// Returns the best matching CARFAX record if found, considering date (must be after deferral)
// Only returns HIGH confidence matches (service key match) to minimize false positives
function findCarfaxMatchForDeferred(
  deferredTitle: string,
  deferredDate: Date | null,
  carfaxRecords: Array<{ date?: string; odometer?: number; description?: string; location?: string }>
): CarfaxMatch | undefined {
  if (!carfaxRecords || carfaxRecords.length === 0) return undefined;
  
  const deferredKeys = toKeyFromFreeText(deferredTitle);
  
  // Only proceed if we can extract meaningful service keys from the deferred work
  if (deferredKeys.length === 0) return undefined;
  
  // If no deferral date, only consider records from the last 6 months to be conservative
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const minDate = deferredDate || sixMonthsAgo;
  
  // Find matching CARFAX records after the deferral date
  const matches: Array<{ record: typeof carfaxRecords[0]; confidence: "high" | "medium"; date: Date }> = [];
  
  for (const record of carfaxRecords) {
    if (!record.description || !record.date) continue;
    
    const recordDate = parseCarfaxDate(record.date);
    if (!recordDate) continue;
    
    // Only consider records AFTER the deferred date (service done elsewhere after deferral)
    if (recordDate <= minDate) continue;
    
    const recordKeys = toKeyFromFreeText(record.description);
    
    // Only high confidence: exact service key match required
    // This ensures we only match specific services (oil change, brake pads, etc.)
    const keyMatch = deferredKeys.some(k => recordKeys.includes(k));
    if (keyMatch) {
      matches.push({ record, confidence: "high", date: recordDate });
    }
  }
  
  if (matches.length === 0) return undefined;
  
  // Sort by date (most recent first)
  matches.sort((a, b) => b.date.getTime() - a.date.getTime());
  
  const best = matches[0];
  return {
    date: best.record.date!,
    odometer: best.record.odometer ?? null,
    description: best.record.description!,
    location: best.record.location ?? null,
    confidence: best.confidence,
  };
}

type DeclinedServiceEntry = {
  serviceKey: string;
  serviceName: string;
  mileage?: number | null;
  reason?: string | null;
  declinedAt: string;
  /** Task #808: "tekmetric" = declined job from Tekmetric history; "shop"/missing = manual list. */
  origin?: "shop" | "tekmetric";
  /** Task #808: RO number the job was declined on (Tekmetric only). */
  roNumber?: number | null;
};

/** Task #808: declined/unauthorized job pulled from Tekmetric history. */
type TekmetricDeclinedJob = {
  id: string;
  title: string;
  date?: string | null;
  originalWorkOrderNumber?: number | null;
};

type MatchedDeferred = {
  id: string;
  title: string;
};

type CarfaxMatch = {
  date: string;
  odometer: number | null;
  description: string;
  location: string | null;
  confidence: "high" | "medium";
};

type TriagedItem = {
  key: string;
  serviceKey: string;
  title: string;
  category?: string;
  intervalMiles?: number | null;
  intervalMonths?: number | null;
  last?: LastDone;
  dueAtMiles?: number | null;
  dueAtDate?: Date | null;
  milesToGo?: number | null;
  daysToGo?: number | null;
  bump?: "red" | "yellow" | null;
  source?: "oem" | "dvi" | "protractor" | "common" | "declined";
  dviSource?: "autoflow" | "autovitals" | "tekmetric" | "autoserve1" | "mastertech";
  reason?: string;
  declined?: DeclinedServiceEntry | null;
  usingShopInterval?: boolean;
  protractorDeferredId?: string;
  matchedDeferred?: MatchedDeferred; // OEM item has matching deferred work
  carfaxMatch?: CarfaxMatch; // Possible CARFAX record that may have addressed this deferred work
  /** Verb extracted from the source row ("inspect", "replace", ...). */
  action?: ServiceAction | null;
  /** Free-text note carried from DataOne (e.g. "If equipped with dipstick"). */
  notes?: string | null;
  /**
   * True when this item is a shop-recommended default rather than an
   * OEM-scheduled interval (lifetime fluids AND the Safety Check row).
   */
  recommendedDefault?: boolean;
  /** Human-readable rationale shown when recommendedDefault is true. */
  recommendedReason?: string | null;
  /**
   * Task #868: True ONLY when the interval came from the lifetime-fluid
   * default — distinguishes real lifetime fluids from other
   * recommendedDefault rows (Safety Check — Oil Level) for badge text.
   */
  lifetimeFluidDefault?: boolean;
  /** Task #198: True when OEM only schedules an "Inspect …" verb on a known fluid. */
  inspectOnly?: boolean;
  /** Task #198: Tooltip / chip rationale for inspectOnly. */
  inspectOnlyReason?: string | null;
  // Task #166: engine-aware oil interval metadata.
  engineRiskFlag?: boolean;
  engineRiskReason?: string | null;
  intervalSchedule?: "severe" | "normal" | null;
  intervalMilesNormal?: number | null;
  intervalMonthsNormal?: number | null;
  intervalMilesSevere?: number | null;
  intervalMonthsSevere?: number | null;
  bestPracticeBlurb?: string | null;
  /** Task #434: whether the anchor was a direct match or implied from a parent service. */
  lastSource?: "direct" | "implied" | null;
};

type ShopIntervalOverride = {
  useShop: boolean;
  excluded?: boolean;
  miles: number | null;
  months: number | null;
};

type Buckets = { overdue: TriagedItem[]; dueSoon: TriagedItem[]; upcoming: TriagedItem[] };

const DEFAULT_SOON_MILES = 1000;
const DEFAULT_SOON_DAYS = 30;

type ShopServiceHistory = {
  serviceName: string;
  mileage: number | null;
  date: Date | null;
};

const MILEAGE_TOLERANCE = 10;
const DATE_TOLERANCE_DAYS = 3;

function isMatchingHistory(
  shopRecord: { miles?: number | null; date?: Date | null },
  carfaxRecord: { miles?: number | null; date?: Date | null }
): boolean {
  if (shopRecord.miles == null || carfaxRecord.miles == null) return false;
  if (shopRecord.date == null || carfaxRecord.date == null) return false;
  
  const milesDiff = Math.abs(shopRecord.miles - carfaxRecord.miles);
  const daysDiff = Math.abs(shopRecord.date.getTime() - carfaxRecord.date.getTime()) / (1000 * 60 * 60 * 24);
  
  return milesDiff <= MILEAGE_TOLERANCE && daysDiff <= DATE_TOLERANCE_DAYS;
}

function triage({
  oemItems,
  carfaxRecords,
  shopServiceHistory = [],
  currentMiles,
  today = new Date(),
  dviFindings,
  protractorDeferredWork = [],
  declinedServices = [],
  tekmetricDeclinedJobs = [],
  soonMiles = DEFAULT_SOON_MILES,
  soonDays = DEFAULT_SOON_DAYS,
  milesPerDay = null,
  shopIntervals = {},
  intervalApplyMode = "always",
  vehicleYear = null,
  engineRisk = null,
  oilDutyPreference = "severe",
  distanceUnit = "miles",
}: {
  oemItems: OEMItem[];
  carfaxRecords: Array<{ date?: string; odometer?: number; description?: string; location?: string }>;
  shopServiceHistory?: ShopServiceHistory[];
  currentMiles: number | null;
  today?: Date;
  dviFindings: Array<{ name?: string; status?: string | number; source?: string; notes?: string | null }>;
  protractorDeferredWork?: ProtractorDeferredWork[];
  declinedServices?: DeclinedServiceEntry[];
  /** Task #808: Tekmetric declined jobs, matched by free-text service key (mirrors lib/plan-build/triage). */
  tekmetricDeclinedJobs?: TekmetricDeclinedJob[];
  soonMiles?: number;
  soonDays?: number;
  milesPerDay?: number | null;
  shopIntervals?: Record<string, ShopIntervalOverride>;
  intervalApplyMode?: string;
  vehicleYear?: number | null;
  // Task #166: engine-aware oil interval inputs.
  engineRisk?: EngineRiskResult | null;
  oilDutyPreference?: "normal" | "severe";
  // Task #333: shop's distance preference. OEM-sourced miles are converted to
  // this unit at intake so all downstream arithmetic and storage is in shop
  // units. Tekmetric/CARFAX odometer values are already in shop units.
  distanceUnit?: DistanceUnit;
}): Buckets {
  // Task #333: convert an OEM "miles" value into the shop's distance unit
  // exactly once, at intake. After this point, every miles-named field in a
  // TriagedItem is in `distanceUnit`.
  const isMetricShop = distanceUnit === "kilometers";
  const oemToShopMiles = (mi: number | null | undefined): number | null => {
    if (mi == null) return null;
    return isMetricShop ? Math.round(mi * MILES_TO_KM) : mi;
  };
  const distLabelLocal = isMetricShop ? "km" : "mi";
  // Earliest possible date: January 1st of the vehicle's model year (or 20 years ago as fallback)
  const earliestDate = vehicleYear 
    ? new Date(vehicleYear, 0, 1) // Jan 1 of model year
    : new Date(today.getTime() - 20 * 365 * 24 * 60 * 60 * 1000); // 20 years ago fallback
  // Enrich CARFAX records with interpolated mileage for gaps
  const enrichedRecords = fillCarfaxMileageGaps(carfaxRecords || [], {
    today,
    currentMiles,
    defaultRate: milesPerDay,
  });

  // Build shop service history map (from Protractor and/or Tekmetric work orders)
  const shopHistoryByKey = new Map<string, { miles: number | null; date: Date | null }[]>();
  for (const sh of shopServiceHistory || []) {
    const keys = toAnchorKeysLocal(sh.serviceName || "");
    for (const k of keys) {
      if (!shopHistoryByKey.has(k)) shopHistoryByKey.set(k, []);
      shopHistoryByKey.get(k)!.push({ miles: sh.mileage, date: sh.date });
    }
  }

  // last-done map: merge CARFAX with shop history (shop wins if matching)
  const lastMap = new Map<string, LastDone>();
  
  // First, add all shop service history as shop source
  for (const sh of shopServiceHistory || []) {
    const keys = toAnchorKeysLocal(sh.serviceName || "");
    for (const k of keys) {
      const prev = lastMap.get(k);
      const cand: LastDone = { miles: sh.mileage, date: sh.date, source: "shop" };
      const prevScore = prev?.date ? prev.date.getTime() : -Infinity;
      const candScore = sh.date ? sh.date.getTime() : -Infinity;
      if (!prev || candScore > prevScore) lastMap.set(k, cand);
    }
  }

  // Then process CARFAX records
  for (const r of enrichedRecords) {
    const date = r.date;
    const miles = r.miles;
    
    const desc = String(r.description || "").trim();
    const keys = toAnchorKeysLocal(desc);
    for (const k of keys) {
      const prev = lastMap.get(k);
      
      // Check if this CARFAX record matches any shop record (±10mi, ±3 days)
      const shopRecords = shopHistoryByKey.get(k) || [];
      const matchesShop = shopRecords.some(sr => isMatchingHistory(sr, { miles, date }));
      
      if (matchesShop) {
        // CARFAX matches shop record - keep shop source (already in lastMap)
        continue;
      }
      
      // No matching shop record - use CARFAX source
      const cand: LastDone = { miles, date, source: "carfax" };
      const prevScore = prev?.date ? prev.date.getTime() : -Infinity;
      const candScore = date ? date.getTime() : -Infinity;
      if (!prev || candScore > prevScore) lastMap.set(k, cand);
    }
  }

  // DVI bumps - track which items we've seen (from AutoFlow or AutoVitals).
  // Merge: red beats yellow; pick the longer non-empty note on ties or when
  // the higher-priority status arrives without a note.
  const dviMap = new Map<string, { status: "red" | "yellow"; name: string; dviSource?: "autoflow" | "autovitals" | "tekmetric"; notes?: string | null }>();
  const unmappedDviFindings: Array<{ status: "red" | "yellow"; name: string; dviSource: "autoflow" | "autovitals" | "tekmetric"; notes?: string | null }> = [];
  const pickDviNote = (a?: string | null, b?: string | null): string | null => {
    const aT = (a || "").trim();
    const bT = (b || "").trim();
    if (!aT) return bT || null;
    if (!bT) return aT || null;
    return bT.length > aT.length ? bT : aT;
  };
  for (const it of dviFindings || []) {
    const rawName = String(it.name || "");
    if (!rawName) continue;
    const key = toKeyFromName(rawName);
    const s = String(it.status ?? "");
    const dviSource = (it.source === "autovitals" ? "autovitals" : it.source === "tekmetric" ? "tekmetric" : "autoflow") as "autoflow" | "autovitals" | "tekmetric";
    const mappedStatus = s === "0" ? "red" : s === "1" ? "yellow" : null;
    if (!mappedStatus) continue;
    const notes = it.notes ? String(it.notes).trim() || null : null;
    if (key) {
      const existing = dviMap.get(key);
      if (mappedStatus === "red") {
        const mergedNotes = existing ? pickDviNote(existing.notes, notes) : notes;
        dviMap.set(key, { status: "red", name: rawName, dviSource, notes: mergedNotes });
      } else if (!existing || existing.status !== "red") {
        const mergedNotes = existing ? pickDviNote(existing.notes, notes) : notes;
        dviMap.set(key, { status: "yellow", name: rawName, dviSource, notes: mergedNotes });
      }
    } else {
      unmappedDviFindings.push({ status: mappedStatus, name: rawName, dviSource, notes });
    }
  }

  // Declined services map - key is the serviceKey
  const declinedMap = new Map<string, DeclinedServiceEntry>();
  for (const d of declinedServices || []) {
    if (d.serviceKey) {
      declinedMap.set(d.serviceKey, d);
    }
  }

  const triaged: TriagedItem[] = [];
  const usedDviKeys = new Set<string>();
  const usedServiceKeys = new Set<string>(); // Dedupe items with same serviceKey
  
  // Pre-compute deferred work info to match with OEM items
  // Maps serviceKey → first matching deferred item (for attaching "+ deferred" button to OEM items)
  const deferredByServiceKey = new Map<string, MatchedDeferred>();
  const seenDeferredTitles = new Set<string>();
  const deferredServiceKeysUsedByOem = new Set<string>(); // Track which deferred items matched OEM
  for (const dw of protractorDeferredWork || []) {
    const title = dw.Title 
      || dw.ServicePackageHeader?.Title 
      || dw.Code 
      || dw.Description 
      || dw.ServicePackageHeader?.Description
      || "Deferred Service";
    const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seenDeferredTitles.has(normalizedTitle)) continue;
    seenDeferredTitles.add(normalizedTitle);
    
    const serviceKey = toKeyFromName(title);
    if (serviceKey && !deferredByServiceKey.has(serviceKey)) {
      deferredByServiceKey.set(serviceKey, { id: dw.ID, title });
    }
  }

  // Task #198: precompute OEM keys that have a replacement-style row, so
  // a fluid is only flagged inspectOnly when the OEM ships an Inspect verb
  // and no matching Replace / Flush / Service / Drain (or interval-only)
  // row exists for the same key. Mirrors lib/plan-build/triage.ts.
  const oemReplacementKeys = new Set<string>();
  for (const o of oemItems) {
    const mk = toKeyFromName(o.name || "");
    if (!mk) continue;
    const a = parseServiceAction(o.name || "");
    if (a === null || a === "replace" || a === "flush" || a === "service" || a === "drain") {
      oemReplacementKeys.add(mk);
    }
  }

  for (const o of oemItems) {
    const serviceKey = toKeyFromName(o.name || "") || `misc_${o.maintenance_id}`;
    
    // Check if there's matching deferred work for this OEM item
    const matchedDeferred = deferredByServiceKey.get(serviceKey);
    if (matchedDeferred) {
      deferredServiceKeysUsedByOem.add(serviceKey); // Mark as used so we hide it from deferred section
    }
    
    // Skip duplicate service keys - only keep first occurrence
    // This prevents "Change engine oil" and "Replace oil filter" from both showing
    if (usedServiceKeys.has(serviceKey) && !serviceKey.startsWith("misc_")) {
      continue;
    }
    usedServiceKeys.add(serviceKey);
    
    const uniqueKey = `${serviceKey}_${o.maintenance_id}`;
    const last = lastMap.get(serviceKey) ?? null;
    
    // Skip items that the shop has marked as excluded
    const shopOverride = shopIntervals[serviceKey];
    if (shopOverride?.excluded) {
      continue;
    }

    const action = parseServiceAction(o.name);
    
    // Check for shop interval override. Mirrors lib/plan-build/triage.ts:
    // the override applies when the shop turned it on (useShop === true) and
    // either the shop's intervalApplyMode is 'always' (the default) or the
    // service was last performed at this shop.
    const lastPerformedAtShop = last?.source === 'shop';
    const usingShopInterval = shopOverride?.useShop === true && (intervalApplyMode === 'always' || lastPerformedAtShop);
    // Task #166: oil rows honour the per-vehicle Normal/Severe duty
    // preference when the shop hasn't supplied a custom interval. Severe is
    // the safer default and matches OEM "Severe-duty" guidance.
    const isOilRow = serviceKey === "oil";
    // Task #333: OEM duty intervals are in real miles. Convert to shop unit
    // up-front so they can be combined with shop-unit anchors below without
    // mixing units.
    const dutyMilesNormal = oemToShopMiles(o.intervalMilesNormal ?? null);
    const dutyMilesSevere = oemToShopMiles(o.intervalMilesSevere ?? null);
    const dutyMonthsNormal = o.intervalMonthsNormal ?? null;
    const dutyMonthsSevere = o.intervalMonthsSevere ?? null;
    const dutyMiles = oilDutyPreference === "normal"
      ? (dutyMilesNormal ?? dutyMilesSevere ?? null)
      : (dutyMilesSevere ?? dutyMilesNormal ?? null);
    const dutyMonths = oilDutyPreference === "normal"
      ? (dutyMonthsNormal ?? dutyMonthsSevere ?? null)
      : (dutyMonthsSevere ?? dutyMonthsNormal ?? null);

    // Shop overrides are entered in the shop's local unit, so they need no
    // conversion. OEM `o.miles` is in real miles and must be converted.
    let intervalMiles = usingShopInterval && shopOverride.miles != null
      ? shopOverride.miles
      : (isOilRow && dutyMiles != null ? dutyMiles : oemToShopMiles(o.miles ?? null));
    let intervalMonths = usingShopInterval && shopOverride.months != null
      ? shopOverride.months
      : (isOilRow && dutyMonths != null ? dutyMonths : (o.months ?? null));

    // Engine-risk threshold is defined in miles; compare against the
    // intervalMiles in its original (miles) form so metric shops aren't
    // falsely flagged just because km values numerically exceed 7,500.
    const intervalMilesForRiskCheck = intervalMiles == null
      ? null
      : (isMetricShop ? intervalMiles / MILES_TO_KM : intervalMiles);
    const oilEngineRiskFlag = !!(
      isOilRow &&
      engineRisk?.flagged &&
      intervalMilesForRiskCheck != null &&
      intervalMilesForRiskCheck >= OIL_INTERVAL_RISK_THRESHOLD_MILES
    );
    const oilEngineRiskReason = oilEngineRiskFlag
      ? (engineRisk?.reasons?.[0] ?? "Engine flagged for accelerated oil wear.")
      : null;

    // Lifetime-fluid handling: when the OE source has no actionable
    // interval but lists this fluid as "lifetime" / "fill for life", surface a
    // recommended-default interval (LIFETIME_FLUID_DEFAULT_MILES) so it shows
    // up on the customer plan as a shop recommendation rather than
    // disappearing silently. Mirrors the same logic in
    // app/api/plan-build/route.ts so cached & freshly-built plans agree.
    let recommendedDefault = false;
    let recommendedReason: string | null = null;
    // Task #868: dedicated flag so badges can tell a genuine lifetime
    // fluid apart from other recommendedDefault rows (Safety Check).
    let lifetimeFluidDefault = false;
    const isReplacementRow =
      action === null ||
      action === "replace" ||
      action === "flush" ||
      action === "service" ||
      action === "drain";
    if (
      !usingShopInterval &&
      isReplacementRow &&
      !serviceKey.startsWith("misc_") &&
      isLifetimeFluidItem({
        serviceKey,
        name: o.name,
        notes: o.notes,
        miles: o.miles ?? null,
        months: o.months ?? null,
        intervals: o.intervals ?? [],
      })
    ) {
      // Task #333: store the default in shop unit so downstream arithmetic
      // (anchor + interval) doesn't mix km and mi.
      intervalMiles = oemToShopMiles(LIFETIME_FLUID_DEFAULT_MILES);
      intervalMonths = null;
      recommendedDefault = true;
      lifetimeFluidDefault = true;
      recommendedReason = `OEM lists this fluid as lifetime / fill for life. Shop recommendation at ${(intervalMiles ?? LIFETIME_FLUID_DEFAULT_MILES).toLocaleString()} ${distLabelLocal}.`;
    }

    // Task #198: surface OEM "Inspect …" rows on known fluids with the
    // OEM-stated interval. Mirrors lib/plan-build/triage.ts so cached &
    // freshly-built plans agree.
    let inspectOnly = false;
    let inspectOnlyReason: string | null = null;
    if (
      !recommendedDefault &&
      !usingShopInterval &&
      !serviceKey.startsWith("misc_") &&
      !oemReplacementKeys.has(serviceKey) &&
      isInspectOnlyFluidItem({ serviceKey, action })
    ) {
      inspectOnly = true;
      const intervalText = intervalMiles && intervalMiles > 0
        ? `every ${intervalMiles.toLocaleString()} ${distLabelLocal}`
        : (intervalMonths && intervalMonths > 0 ? `every ${intervalMonths} mo` : "per OEM schedule");
      inspectOnlyReason = `OEM only schedules an inspection (not a replacement) ${intervalText}. Have your technician check the fluid's condition; replacement is at the technician's discretion.`;
    }

    // Track that we've used this DVI key
    if (dviMap.has(serviceKey)) usedDviKeys.add(serviceKey);

    let dueAtMiles: number | null = null;
    let dueAtDate: Date | null = null;

    // Miles-based next due
    // Track if this item has never been done (for overdue calculation)
    let neverDone = false;
    if (intervalMiles && intervalMiles > 0) {
      // When shop history captured the date but not the odometer, fall back
      // to a mileage estimate derived from the recorded date and the
      // vehicle's average miles/day. Otherwise a recently-completed service
      // would falsely appear "31,859 mi over" because we'd treat
      // miles-anchor as the very first interval.
      let anchorMiles: number | null = null;
      if (last?.miles != null && last.miles > 0) {
        anchorMiles = last.miles;
      } else if (
        last?.date &&
        currentMiles != null &&
        milesPerDay != null &&
        milesPerDay > 0
      ) {
        const daysSince = Math.max(
          0,
          Math.floor((today.getTime() - last.date.getTime()) / 86400000),
        );
        anchorMiles = Math.max(0, currentMiles - daysSince * milesPerDay);
      }

      if (anchorMiles != null) {
        dueAtMiles = anchorMiles + intervalMiles;
      } else if (currentMiles != null) {
        // No history at all: was due at the first interval.
        dueAtMiles = intervalMiles;
        neverDone = true;
      }
    }

    // Time-based next due
    if (intervalMonths && intervalMonths > 0) {
      if (last?.date) dueAtDate = addMonths(last.date, intervalMonths);
      else if (!neverDone) dueAtDate = addMonths(today, 0 + intervalMonths);
      // If neverDone, don't set a future date - we'll estimate from mileage below
    }

    const milesToGo = currentMiles != null && dueAtMiles != null ? dueAtMiles - currentMiles : null;

    // If no time-based interval but we have miles and miles/day, estimate date
    // Also applies when service was never done (neverDone=true) to avoid showing future dates for overdue items
    if (dueAtDate == null && milesToGo != null && milesPerDay != null && milesPerDay > 0) {
      const daysUntilDue = Math.round(milesToGo / milesPerDay);
      dueAtDate = new Date(today.getTime() + daysUntilDue * 24 * 60 * 60 * 1000);
    }
    
    // If calculated date is before the vehicle was built, don't show a date at all
    // Just show miles overdue instead of a confusing/impossible date
    if (dueAtDate && dueAtDate < earliestDate) {
      dueAtDate = null;
    }

    const daysToGo =
      dueAtDate != null ? Math.ceil((dueAtDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : null;

    const dviInfo = dviMap.get(serviceKey);
    const declinedInfo = declinedMap.get(serviceKey) || null;
    // Always prefer the original DataOne row name so the verb (Inspect /
    // Replace / Flush / Rotate / ...) is preserved end-to-end. Fall back to
    // the canonical display label only when the source row has no name.
    //
    // Exception (mirrors lib/plan-build/triage.ts): when the shop-interval
    // override is in force, the shop has declared this a real recurring
    // service — an OEM "Inspect …" title would misrepresent it. Swap in the
    // canonical service name and drop the inspect verb.
    const isInspectWording =
      action === "inspect" || /^\s*(inspect|check)\b/i.test(o.name || "");
    const shopServiceRetitle =
      usingShopInterval && isInspectWording && !!SERVICE_KEY_DISPLAY_NAMES[serviceKey];
    const displayTitle = shopServiceRetitle
      ? SERVICE_KEY_DISPLAY_NAMES[serviceKey]
      : (o.name || SERVICE_KEY_DISPLAY_NAMES[serviceKey] || "Maintenance Item");
    const effectiveAction = shopServiceRetitle && action === "inspect" ? "service" : action;

    triaged.push({
      key: uniqueKey,
      serviceKey,
      title: displayTitle,
      category: o.category,
      intervalMiles,
      intervalMonths,
      last: last || undefined,
      dueAtMiles,
      dueAtDate,
      milesToGo,
      daysToGo,
      bump: dviInfo?.status ?? null,
      source: "oem",
      dviSource: dviInfo?.dviSource,
      declined: declinedInfo,
      usingShopInterval,
      matchedDeferred, // Attach matching deferred work for "+ deferred" button
      action: effectiveAction ?? null,
      notes: dviInfo?.notes ?? o.notes ?? null,
      // The recommended-default rationale is surfaced via a dedicated badge
      // in the renderer, so we deliberately do not duplicate it into `reason`
      // (which would render again as the gray italic pill).
      recommendedDefault: recommendedDefault || undefined,
      recommendedReason: recommendedReason ?? undefined,
      lifetimeFluidDefault: lifetimeFluidDefault || undefined,
      // Task #198: inspect-only fluid flag for the "OEM: Inspect every X mi"
      // chip and the showInspectItems-filter exemption.
      inspectOnly: inspectOnly || undefined,
      inspectOnlyReason: inspectOnlyReason ?? undefined,
      // Task #166: surface engine-aware oil metadata so the dashboard can
      // render the soft warning chip and remember which schedule was used.
      engineRiskFlag: oilEngineRiskFlag || undefined,
      engineRiskReason: oilEngineRiskReason,
      intervalSchedule: isOilRow
        ? (oilDutyPreference === "normal" ? "normal" : "severe")
        : null,
      intervalMilesNormal: isOilRow ? dutyMilesNormal : null,
      intervalMonthsNormal: isOilRow ? dutyMonthsNormal : null,
      intervalMilesSevere: isOilRow ? dutyMilesSevere : null,
      intervalMonthsSevere: isOilRow ? dutyMonthsSevere : null,
    });
  }

  // Task #166: when an oil row exists, anchor an interim "Safety Check —
  // oil level" item at SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES (3,000 mi) off
  // the oil's lastPerformed mileage. This protects vehicles running long
  // synthetic intervals from running low between scheduled changes.
  const oilTriaged = triaged.find((t) => t.serviceKey === "oil");
  if (oilTriaged && !usedServiceKeys.has(SAFETY_CHECK_OIL_LEVEL_KEY)) {
    // Task #333: convert the 3,000-mi safety interval into the shop's unit
    // before adding it to oilLastMiles / currentMiles (which are in shop unit).
    const safetyIntervalShop = oemToShopMiles(SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES) ?? SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES;
    const oilLastMiles = oilTriaged.last?.miles ?? null;
    const safetyDueAtMiles = oilLastMiles != null
      ? oilLastMiles + safetyIntervalShop
      : (currentMiles != null ? currentMiles + safetyIntervalShop : null);
    const safetyMilesToGo =
      currentMiles != null && safetyDueAtMiles != null
        ? safetyDueAtMiles - currentMiles
        : null;
    triaged.push({
      key: `oem_${SAFETY_CHECK_OIL_LEVEL_KEY}`,
      serviceKey: SAFETY_CHECK_OIL_LEVEL_KEY,
      title: SAFETY_CHECK_OIL_LEVEL_TITLE,
      category: "Safety Check",
      intervalMiles: safetyIntervalShop,
      intervalMonths: null,
      last: oilTriaged.last,
      dueAtMiles: safetyDueAtMiles,
      dueAtDate: null,
      milesToGo: safetyMilesToGo,
      daysToGo: null,
      bump: null,
      source: "oem",
      reason: "Interim safety check anchored to oil change history.",
      recommendedDefault: true,
      recommendedReason: "Auto-inserted by Detect Dog to verify oil level mid-interval.",
    });
    usedServiceKeys.add(SAFETY_CHECK_OIL_LEVEL_KEY);
  }

  // Add standalone DVI findings (red/yellow items not matched to OEM).
  // The per-shop blurb is applied post-triage so admin edits surface on
  // the next page load without busting the plan cache.
  for (const [dviKey, dviInfo] of dviMap) {
    if (usedDviKeys.has(dviKey)) continue; // already matched to OEM item
    triaged.push({
      key: `dvi_${dviKey}`,
      serviceKey: dviKey,
      title: dviInfo.name,
      category: "DVI Finding",
      intervalMiles: null,
      intervalMonths: null,
      last: undefined,
      dueAtMiles: null,
      dueAtDate: null,
      milesToGo: null,
      daysToGo: null,
      bump: dviInfo.status,
      source: "dvi",
      dviSource: dviInfo.dviSource,
      notes: dviInfo.notes ?? null,
    });
  }

  for (const unmapped of unmappedDviFindings) {
    const safeKey = `dvi_unmapped_${unmapped.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`;
    triaged.push({
      key: safeKey,
      serviceKey: safeKey,
      title: unmapped.name,
      category: "DVI Finding",
      intervalMiles: null,
      intervalMonths: null,
      last: undefined,
      dueAtMiles: null,
      dueAtDate: null,
      milesToGo: null,
      daysToGo: null,
      bump: unmapped.status,
      source: "dvi",
      dviSource: unmapped.dviSource,
      notes: unmapped.notes ?? null,
    });
  }

  // Add Protractor deferred work (shop recommendations)
  // These are services that were recommended but not performed - they're already overdue
  // seenDeferredTitles was already built above for OEM matching - reuse it here
  for (const dw of protractorDeferredWork || []) {
    const title = dw.Title 
      || dw.ServicePackageHeader?.Title 
      || dw.Code 
      || dw.Description 
      || dw.ServicePackageHeader?.Description
      || "Deferred Service";
    
    // Normalize title for deduplication (already computed above, check if seen)
    const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!seenDeferredTitles.has(normalizedTitle)) {
      continue; // Only process items that were seen in pre-computation (handles dedup)
    }
    // Mark as processed by removing from set (first occurrence wins)
    seenDeferredTitles.delete(normalizedTitle);
    
    const protractorServiceKey = toKeyFromName(title) || `protractor_${dw.ID}`;
    
    // Skip deferred items that matched an OEM item - they'll show the "+ deferred" button on the OEM row
    if (deferredServiceKeysUsedByOem.has(protractorServiceKey)) {
      continue;
    }
    
    // Check if CARFAX has a record that may have addressed this deferred work
    const deferredDate = dw.CreatedDate ? new Date(dw.CreatedDate) : 
                         dw.Header?.CreationTime ? new Date(dw.Header.CreationTime) : null;
    const carfaxMatch = findCarfaxMatchForDeferred(title, deferredDate, carfaxRecords);
    
    triaged.push({
      key: `protractor_${dw.ID}`,
      serviceKey: protractorServiceKey,
      title,
      category: "Shop Recommendation",
      intervalMiles: null,
      intervalMonths: null,
      last: undefined,
      dueAtMiles: null,
      dueAtDate: null,
      milesToGo: null,
      daysToGo: null,
      bump: "red", // Deferred = already recommended = already overdue
      source: "protractor",
      reason: dw.Reason || undefined,
      protractorDeferredId: dw.ID || dw.ServiceItemID,
      carfaxMatch,
    });
  }

  // Task #808: fold Tekmetric declined/unauthorized jobs into the plan
  // (mirrors lib/plan-build/triage.ts). Matched items carry the declined
  // flag (origin "tekmetric") and are forced into overdue below; unmatched
  // jobs become their own labeled overdue entries. Jobs performed after
  // the decline date are treated as resolved and dropped.
  if ((tekmetricDeclinedJobs || []).length > 0) {
    const itemsByServiceKey = new Map<string, TriagedItem[]>();
    for (const t of triaged) {
      if (!t.serviceKey) continue;
      const arr = itemsByServiceKey.get(t.serviceKey);
      if (arr) arr.push(t);
      else itemsByServiceKey.set(t.serviceKey, [t]);
    }

    const seenDeclinedTitles = new Set<string>();
    for (const dj of tekmetricDeclinedJobs || []) {
      const title = (dj.title || "").trim() || "Declined Service";
      const normalizedTitle = title.toLowerCase().replace(/\s+/g, " ");
      if (seenDeclinedTitles.has(normalizedTitle)) continue;
      seenDeclinedTitles.add(normalizedTitle);

      const keys = toKeyFromFreeText(title) || [];
      const declinedDate = dj.date ? new Date(dj.date) : null;
      const entry: DeclinedServiceEntry = {
        serviceKey: keys[0] || `tek_declined_${dj.id}`,
        serviceName: title,
        mileage: null,
        reason: null,
        declinedAt: dj.date || "",
        origin: "tekmetric",
        roNumber: dj.originalWorkOrderNumber ?? null,
      };

      let matchedAny = false;
      for (const k of keys) {
        for (const t of itemsByServiceKey.get(k) || []) {
          matchedAny = true;
          if (
            declinedDate &&
            !isNaN(declinedDate.getTime()) &&
            t.last?.date &&
            t.last.date > declinedDate
          ) {
            continue;
          }
          if (!t.declined) t.declined = entry;
        }
      }

      if (!matchedAny) {
        triaged.push({
          key: `declined_${dj.id}`,
          serviceKey: entry.serviceKey,
          title,
          category: "Customer Declined",
          intervalMiles: null,
          intervalMonths: null,
          last: undefined,
          dueAtMiles: null,
          dueAtDate: null,
          milesToGo: null,
          daysToGo: null,
          bump: "red",
          source: "declined",
          reason: undefined,
          declined: entry,
        });
      }
    }
  }

  const overdue: TriagedItem[] = [];
  const dueSoon: TriagedItem[] = [];
  const upcoming: TriagedItem[] = [];

  for (const t of triaged) {
    const mOver = t.milesToGo != null && t.milesToGo <= 0;
    const dOver = t.daysToGo != null && t.daysToGo <= 0;
    const mSoon = t.milesToGo != null && t.milesToGo > 0 && t.milesToGo <= soonMiles;
    const dSoon = t.daysToGo != null && t.daysToGo > 0 && t.daysToGo <= soonDays;

    // DVI bump forces severity
    if (t.bump === "red") {
      overdue.push(t);
      continue;
    }
    // Task #808: Tekmetric-declined matches are grouped in overdue
    // regardless of computed due state (mirrors lib/plan-build/triage).
    if (t.declined?.origin === "tekmetric") {
      overdue.push(t);
      continue;
    }
    if (t.bump === "yellow") {
      if (!(mOver || dOver)) dueSoon.push(t);
      else overdue.push(t);
      continue;
    }

    if (mOver || dOver) overdue.push(t);
    else if (mSoon || dSoon) dueSoon.push(t);
    else upcoming.push(t);
  }

  // Helper to check if item title contains "Inspect" or starts with "Check" (lower priority)
  const isInspectItem = (item: TriagedItem) => {
    const title = item.title?.toLowerCase() || "";
    return title.includes("inspect") || title.startsWith("check ");
  };

  const hasDviBump = (item: TriagedItem) => item.bump === "red" || item.bump === "yellow";

  overdue.sort((a, b) => {
    const aDvi = hasDviBump(a) ? 0 : 1;
    const bDvi = hasDviBump(b) ? 0 : 1;
    if (aDvi !== bDvi) return aDvi - bDvi;
    const aInspect = isInspectItem(a) ? 1 : 0;
    const bInspect = isInspectItem(b) ? 1 : 0;
    if (aInspect !== bInspect) return aInspect - bInspect;
    const aBehind = (a.milesToGo ?? 0) < 0 ? -(a.milesToGo ?? 0) : 0;
    const bBehind = (b.milesToGo ?? 0) < 0 ? -(b.milesToGo ?? 0) : 0;
    return bBehind - aBehind;
  });
  dueSoon.sort((a, b) => {
    const aDvi = hasDviBump(a) ? 0 : 1;
    const bDvi = hasDviBump(b) ? 0 : 1;
    if (aDvi !== bDvi) return aDvi - bDvi;
    const aInspect = isInspectItem(a) ? 1 : 0;
    const bInspect = isInspectItem(b) ? 1 : 0;
    if (aInspect !== bInspect) return aInspect - bInspect;
    const aLeft = a.milesToGo ?? Infinity;
    const bLeft = b.milesToGo ?? Infinity;
    return aLeft - bLeft;
  });
  upcoming.sort((a, b) => {
    const aInspect = isInspectItem(a) ? 1 : 0;
    const bInspect = isInspectItem(b) ? 1 : 0;
    if (aInspect !== bInspect) return aInspect - bInspect; // Non-inspect first
    const aNext = a.dueAtMiles ?? Number.POSITIVE_INFINITY;
    const bNext = b.dueAtMiles ?? Number.POSITIVE_INFINITY;
    return aNext - bNext;
  });

  return { overdue, dueSoon, upcoming };
}

/* ---------------- Page ---------------- */
type PageProps = { params: Promise<{ vin: string }>; searchParams?: Promise<{ refresh?: string }> };

export default function VehiclePlanPage({ params, searchParams }: PageProps) {
  return (
    <Suspense fallback={<PlanLoading />}>
      <PlanContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function PlanContent({ params, searchParams }: PageProps) {
  // Task #737: slow-load observability. Track the wall-clock duration of the
  // whole build plus WHICH upstream budgets were exhausted, and emit a single
  // structured [PlanSlowLoad] line (plus a Mongo record) when the load was
  // slow or degraded, so reports like "VIN attributes take 30 minutes" can be
  // traced to a shop/VIN/timestamp/budget.
  const planLoadStart = Date.now();
  const exhaustedBudgets: string[] = [];
  const budgeted = <T,>(promise: Promise<T>, timeoutMs: number, label: string, fallback: T): Promise<T> =>
    withUpstreamTimeout(promise, timeoutMs, label, fallback, {
      onTimeout: () => exhaustedBudgets.push(label),
    });

  const session = await requireSession();
  const db = await getDb();
  const resolvedSearchParams = await searchParams;
  const forceRefresh = resolvedSearchParams?.refresh === "1";
  const shopId = Number(session.shopId);

  const { vin: vinParam } = await params;
  const vin = String(vinParam || "").toUpperCase();

  const shop = await db.collection("shops").findOne(
    { shopId },
    { projection: { maintenance: 1, protractor: 1, preferences: 1 } }
  );
  const distanceUnit: DistanceUnit = shop?.preferences?.distanceUnit || "miles";
  const distLabel = getDistanceLabel(distanceUnit);
  const featureEntitlements = await getFeatureEntitlements(shopId);
  const hasJobLookupFeature = featureEntitlements.effectiveFeatures.job_lookup;
  const showInspectItems = shop?.preferences?.showInspectItems !== false; // default true
  const showRecalls = shop?.preferences?.showRecalls !== false; // default true
  const recallsExpanded = shop?.preferences?.recallsExpanded !== false; // default true
  const soonMiles = shop?.maintenance?.dueSoonMiles ?? DEFAULT_SOON_MILES;
  const soonDays = shop?.maintenance?.dueSoonDays ?? DEFAULT_SOON_DAYS;
  const rawIntervals: Record<string, ShopIntervalOverride> = shop?.maintenance?.intervals ?? {};
  const intervalApplyMode: string = shop?.maintenance?.intervalApplyMode || "always";
  const LEGACY_KEY_MAP: Record<string, string[]> = {
    differential: ["front_differential", "rear_differential"],
    alignment: ["wheel_alignment"],
    brake_pads: ["front_brake_pads", "rear_brake_pads"],
  };
  const shopIntervals: Record<string, ShopIntervalOverride> = { ...rawIntervals };
  for (const [oldKey, newKeys] of Object.entries(LEGACY_KEY_MAP)) {
    if (shopIntervals[oldKey]) {
      for (const nk of newKeys) {
        if (!shopIntervals[nk]) shopIntervals[nk] = shopIntervals[oldKey];
      }
    }
  }
  const rawMappings = shop?.protractor?.cannedJobMappings ?? {};
  const cannedJobMappings: Record<string, string[]> = {};
  for (const key in rawMappings) {
    const val = rawMappings[key];
    if (Array.isArray(val)) {
      cannedJobMappings[key] = val;
    } else if (typeof val === "string" && val) {
      cannedJobMappings[key] = [val];
    }
  }
  for (const [oldKey, newKeys] of Object.entries(LEGACY_KEY_MAP)) {
    if (cannedJobMappings[oldKey]) {
      for (const nk of newKeys) {
        if (!cannedJobMappings[nk]) cannedJobMappings[nk] = cannedJobMappings[oldKey];
      }
    }
  }
  
  const cannedJobsCache = await budgeted(
    fetchCannedJobsWithCache(shopId),
    VHI_CANNED_TIMEOUT_MS,
    `canned-jobs shop ${shopId}`,
    { ok: false } as unknown as Awaited<ReturnType<typeof fetchCannedJobsWithCache>>,
  );
  const cannedJobsById: Record<string, { id: string; title: string }> = {};
  if (cannedJobsCache.ok && cannedJobsCache.cannedJobs) {
    for (const job of cannedJobsCache.cannedJobs) {
      cannedJobsById[job.id] = { id: job.id, title: job.title };
    }
  }
  
  const manualJobs = shop?.protractor?.manualCannedJobs || [];
  for (const job of manualJobs) {
    if (job.id && !cannedJobsById[job.id]) {
      cannedJobsById[job.id] = { id: job.id, title: job.title || `Job ${job.id}` };
    }
  }
  
  function getCannedJobOptionsForService(serviceKey: string) {
    const ids = cannedJobMappings[serviceKey] || [];
    const result = ids
      .map(id => cannedJobsById[id])
      .filter(Boolean);
    // Debug: log mapping lookup
    if (ids.length > 0 || Object.keys(cannedJobMappings).length > 0) {
      console.log(`[CannedJobs] serviceKey="${serviceKey}" -> mappedIds=[${ids.join(",")}] -> found=${result.length} jobs`);
    }
    return result;
  }
  
  // Debug: log available mappings and canned jobs
  console.log(`[CannedJobs] Shop ${shopId} mappings:`, Object.keys(cannedJobMappings));
  console.log(`[CannedJobs] Shop ${shopId} cannedJobsById count:`, Object.keys(cannedJobsById).length);
  

  const vehicle = await db.collection("vehicles").findOne(
    { shopId, vin },
    { projection: { year: 1, make: 1, model: 1, vin: 1, lastMileage: 1, customerId: 1, updatedAt: 1, declinedServices: 1, oilDutyPreference: 1 } }
  );

  // Early mileage check and cache lookup (skip cache if force refresh)
  const earlyMilesResult = await budgeted(
    getLatestMilesForVin(db, vin),
    VHI_MILES_TIMEOUT_MS,
    `miles ${vin}`,
    { miles: null, recordedDate: null },
  );
  const earlyMiles = earlyMilesResult.miles;
  const cachedPlan = forceRefresh ? null : await getCachedPlan(db, vin, shopId, earlyMiles, distanceUnit);
  const useCachedData = cachedPlan !== null;
  
  if (useCachedData) {
    console.log(`[Plan] Cache HIT for ${vin} - will use cached buckets`);
  } else {
    console.log(`[Plan] Cache MISS for ${vin}${forceRefresh ? " (force refresh)" : ""} - building from sources`);
  }

  // Get repair orders from events collection (AutoFlow webhooks store RO data here)
  // This matches the detail page logic exactly
  const eventRos = await budgeted(
    db.collection("events").aggregate([
    {
      $match: {
        $and: [
          { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
          { provider: "autoflow" },
          {
            $expr: {
              $eq: [
                { $toUpper: { $ifNull: ["$vehicleVin", { $ifNull: ["$vin", "$payload.vehicle.vin"] }] } },
                vin.toUpperCase()
              ]
            }
          }
        ]
      }
    },
    {
      $addFields: {
        roNumber: { $ifNull: ["$payload.ticket.invoice", { $ifNull: ["$payload.ticket.id", "$roNumber"] }] },
        status: { $ifNull: ["$payload.ticket.status", "$status"] },
        mileage: { $ifNull: ["$payload.ticket.mileage", { $ifNull: ["$payload.vehicle.mileage", null] }] }
      }
    },
    { $match: { roNumber: { $ne: null } } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$roNumber",
        roNumber: { $first: "$roNumber" },
        status: { $first: "$status" },
        mileage: { $first: "$mileage" },
        updatedAt: { $first: "$createdAt" },
        createdAt: { $first: "$createdAt" }
      }
    },
    { $sort: { updatedAt: -1 } },
    { $limit: 20 }
  ]).toArray(),
    VHI_EVENTS_TIMEOUT_MS,
    `events-ro ${vin}`,
    [] as any[],
  );

  const ros = eventRos;
  
  let latestRoNumber = ros[0]?.roNumber ?? null;
  let latestWorkOrderId: string | null = null;
  let latestRepairOrderId: string | number | null = null;
  let activeIntegration: "protractor" | "tekmetric" | null = null;
  let customerName: string | null = null;
  let currentRoDate: Date | null = null;
  
  // Helper to extract customer name from work order (works for all integrations)
  const extractCustomerName = (wo: any): string | null => {
    // Tekmetric format
    if (wo?.customerName) return wo.customerName;
    if (wo?.contactName) return wo.contactName;
    // Protractor format - flat fields
    if (wo?.data?.contactName) return wo.data.contactName;
    // Protractor format - nested Contact structure
    const contact = wo?.Contact || wo?.data?.Contact;
    if (contact?.Name) {
      const firstName = contact.Name.FirstName || '';
      const lastName = contact.Name.LastName || '';
      const name = [firstName, lastName].filter(Boolean).join(' ').trim();
      if (name) return name;
    }
    return wo?.data?.customerName || null;
  };
  
  // Query all connected work order sources in parallel
  const vinRegex = new RegExp(`^${vin}$`, 'i');
  
  const [protractorWO, tekmetricWO, autoflowWO] = await budgeted(
    Promise.all([
    // Protractor work orders
    db.collection("protractor_work_orders").findOne(
      { 
        shopId,
        $or: [
          { vin: { $regex: vinRegex } },
          { "data.VIN": { $regex: vinRegex } }
        ]
      },
      { sort: { fetchedAt: -1, createdAt: -1 } }
    ),
    // Tekmetric work orders — exact (uppercased) VIN match so this uses the
    // { shopId, vin, completedDate } index. A case-insensitive `$regex` here is
    // non-indexable and forces a per-shop scan of the ~1.7M-row collection.
    // VINs are stored uppercased on write.
    db.collection("tekmetric_work_orders").findOne(
      { shopId: { $in: [String(shopId), Number(shopId)] }, vin: vin.toUpperCase() },
      // Task #960: sync-written mirror docs carry only Tekmetric's *Date
      // fields (updatedDate/createdDate), not updatedAt/createdAt — include
      // both so "most recent" holds for either writer.
      { sort: { updatedAt: -1, updatedDate: -1, createdAt: -1, createdDate: -1 } }
    ),
    // AutoFlow work orders (via webhook events) — gated behind
    // AUTOFLOW_CACHE_PG_CANONICAL (Mongo body preserved verbatim in the repo).
    findLatestAutoflowEventByVin(shopId, vin)
    ]),
    VHI_DB_TIMEOUT_MS,
    `wo-sources ${vin}`,
    [null, null, null] as any,
  );
  
  // Pick the most recent work order from any connected source
  type WOCandidate = { source: string; roNumber: string; workOrderId: string | null; customerName: string | null; updatedAt: Date };
  const candidates: WOCandidate[] = [];
  
  if (protractorWO) {
    const woNumber = protractorWO.workOrderNumber || protractorWO.WorkOrderNumber || protractorWO.data?.WorkOrderNumber;
    if (woNumber) {
      candidates.push({
        source: 'Protractor',
        roNumber: String(woNumber),
        workOrderId: protractorWO.workOrderId || protractorWO.ID || protractorWO.data?.ID || null,
        customerName: extractCustomerName(protractorWO),
        updatedAt: protractorWO.fetchedAt || protractorWO.createdAt || new Date(0)
      });
    }
  }
  
  if (tekmetricWO) {
    // Tekmetric snapshot uses: workOrderNumber for display, workOrderId for the actual repair order ID
    const woNumber = tekmetricWO.workOrderNumber || tekmetricWO.data?.repairOrderNumber;
    if (woNumber) {
      candidates.push({
        source: 'Tekmetric',
        roNumber: String(woNumber),
        workOrderId: tekmetricWO.workOrderId || (tekmetricWO.data?.id ? String(tekmetricWO.data.id) : null),
        customerName: extractCustomerName(tekmetricWO),
        updatedAt: tekmetricWO.updatedDate ? new Date(tekmetricWO.updatedDate) : (tekmetricWO.fetchedAt || new Date(0))
      });
    }
  }
  
  if (autoflowWO) {
    const woNumber = autoflowWO.payload?.ticket?.invoice || autoflowWO.payload?.ticket?.id || autoflowWO.roNumber;
    if (woNumber) {
      candidates.push({
        source: 'AutoFlow',
        roNumber: String(woNumber),
        workOrderId: null,
        customerName: autoflowWO.payload?.customer?.name || autoflowWO.customerName || null,
        updatedAt: autoflowWO.createdAt || new Date(0)
      });
    }
  }
  
  // Sort by most recent and pick the best candidate
  if (candidates.length > 0) {
    candidates.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const best = candidates[0];
    latestRoNumber = best.roNumber;
    latestWorkOrderId = best.workOrderId ? String(best.workOrderId) : null;
    customerName = best.customerName;
    currentRoDate = new Date(best.updatedAt);
    
    // Set active integration based on which source won
    if (best.source === 'Tekmetric') {
      activeIntegration = 'tekmetric';
      latestRepairOrderId = best.workOrderId;
    } else if (best.source === 'Protractor') {
      activeIntegration = 'protractor';
    }
    
    console.log(`[Plan Debug] Found ${best.source} RO: ${latestRoNumber}, Customer: ${customerName}, Integration: ${activeIntegration}`);
  }
  
  console.log(`[Plan Debug] Latest RO number: ${latestRoNumber}, total ROs: ${ros.length}, sources checked: Protractor/Tekmetric/AutoFlow`);

  // PARALLEL CONFIG RESOLUTION AND LOCAL DATA - always needed for rendering
  const DVI_CACHE_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days
  const CARFAX_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days  
  const PROTRACTOR_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
  const vinUpper = vin.toUpperCase();

  // Declare variables for API results - will be populated conditionally
  let dvi: any = { ok: false };
  let carfax: any = { ok: false };
  let protractorVehicleResult: any = { ok: false };
  let avInspectionResult: any = { ok: false };
  let protractorCompletedWOs: any[] = [];
  let tekmetricCompletedWOs: any[] = [];
  let shopBranding: any = null;
  let autoCfg: any = { configured: false };
  let carfaxCfg: any = { configured: false };
  let protractorCfg: any = { configured: false };
  let autoVitalsCfg: any = { configured: false };
  
  // Fetch NHTSA recalls from local PostgreSQL (always fast, no caching needed)
  // plus any recall records from the cached CARFAX snapshot (cache-only Mongo
  // read — NEVER triggers a live/paid CARFAX fetch). CARFAX recall records
  // carry remedy status ("Remedy Available" / "Remedy Not Yet Available"),
  // which the DataOne NHTSA feed does not provide.
  const [recallsResult, carfaxRecallRecords] = await Promise.all([
    getVehicleRecallsLocal(vin),
    getCachedCarfaxRecalls(shopId, vin).catch((err) => {
      console.warn(`[Plan] Cached CARFAX recall read failed for ${vin}: ${err?.message}`);
      return null;
    }),
  ]);
  const nhtsaRecalls: VehicleRecall[] = recallsResult.ok ? recallsResult.recalls : [];
  // Enrich NHTSA entries with CARFAX remedy status (matched by campaign
  // number) and collect CARFAX-only recalls not in the local DataOne set.
  const { enriched: recalls, carfaxOnly: carfaxOnlyRecalls } = mergeRecallsWithCarfax(
    nhtsaRecalls,
    carfaxRecallRecords
  );
  const recallCount = recalls.length + carfaxOnlyRecalls.length;
  const safetyCriticalCount = recallsResult.ok ? recallsResult.safetyCriticalCount : 0;

  // CACHE HIT: Only fetch cheap local data needed for UI (shop branding, config status).
  // We deliberately do NOT make the live Protractor vehicle/deferred-work calls
  // here — those two external round-trips were the main reason a "cache hit"
  // still took seconds. The cached plan already carries a deferred-work snapshot
  // (used via the fallback below), so the page paints fast on revisit. A manual
  // refresh (?refresh=1) takes the cache-miss path and pulls fresh deferred work.
  if (useCachedData) {
    console.log(`[Plan] Cache HIT - skipping expensive external API calls (incl. live Protractor)`);
    const [localAutoCfg, localCarfaxCfg, localProtractorCfg, localAutoVitalsCfg, localShopBranding] = await Promise.all([
      resolveAutoflowConfig(shopId),
      resolveCarfaxConfig(shopId),
      resolveProtractorConfig(shopId),
      resolveAutoVitalsConfig(shopId),
      db.collection("shops").findOne({ shopId }, { projection: { "branding.logo": 1 } })
    ]);
    autoCfg = localAutoCfg;
    carfaxCfg = localCarfaxCfg;
    protractorCfg = localProtractorCfg;
    autoVitalsCfg = localAutoVitalsCfg;
    shopBranding = localShopBranding;
    // protractorVehicleResult stays { ok: false } → the deferred-work block
    // below falls through to the cached deferred-work snapshot.
  } else {
    // CACHE MISS: Full parallel data fetching - external APIs + local queries
    console.log(`[Plan] Cache MISS - fetching all external data`);
    const [localAutoCfg, localCarfaxCfg, localProtractorCfg, localAutoVitalsCfg] = await Promise.all([
      resolveAutoflowConfig(shopId),
      resolveCarfaxConfig(shopId),
      resolveProtractorConfig(shopId),
      resolveAutoVitalsConfig(shopId)
    ]);
    autoCfg = localAutoCfg;
    carfaxCfg = localCarfaxCfg;
    protractorCfg = localProtractorCfg;
    autoVitalsCfg = localAutoVitalsCfg;

    const [localDvi, localCarfax, localProtractorVehicleResult, localAvInspectionResult, localProtractorCompletedWOs, localTekmetricCompletedWOs, localShopBranding] = await Promise.all([
      latestRoNumber && autoCfg.configured
        ? budgeted(
            fetchDviWithCache(shopId, String(latestRoNumber), DVI_CACHE_TTL),
            VHI_EXTERNAL_FETCH_TIMEOUT_MS,
            `autoflow-dvi ${vin}`,
            { ok: false, error: "AutoFlow timed out." } as unknown as Awaited<ReturnType<typeof fetchDviWithCache>>,
          )
        : Promise.resolve({ ok: false, error: latestRoNumber ? "AutoFlow not connected." : "No RO found." }),
      carfaxCfg.configured
        ? budgeted(
            fetchCarfaxWithCache(shopId, vin, CARFAX_CACHE_TTL),
            VHI_EXTERNAL_FETCH_TIMEOUT_MS,
            `carfax ${vin}`,
            { ok: false, error: "CARFAX timed out." } as unknown as Awaited<ReturnType<typeof fetchCarfaxWithCache>>,
          )
        : Promise.resolve({ ok: false, error: "CARFAX not configured." as const }),
      protractorCfg.configured
        ? budgeted(
            fetchProtractorVehicle(shopId, vin, PROTRACTOR_CACHE_TTL),
            VHI_EXTERNAL_FETCH_TIMEOUT_MS,
            `protractor-vehicle ${vin}`,
            { ok: false } as unknown as Awaited<ReturnType<typeof fetchProtractorVehicle>>,
          )
        : Promise.resolve({ ok: false } as { ok: false }),
      autoVitalsCfg.configured
        ? budgeted(
            fetchAutoVitalsInspectionByVin(shopId, vin, PROTRACTOR_CACHE_TTL),
            VHI_EXTERNAL_FETCH_TIMEOUT_MS,
            `autovitals ${vin}`,
            { ok: false } as unknown as Awaited<ReturnType<typeof fetchAutoVitalsInspectionByVin>>,
          )
        : Promise.resolve({ ok: false } as { ok: false }),
      budgeted(
        db.collection("protractor_work_orders").find({
          shopId,
          $or: [
            { vin: vinUpper },
            { "data.VIN": vinUpper },
            { "ServiceItem.VIN": vinUpper }
          ]
        }).sort({ "Header.LastModifiedTime": -1 }).limit(20).toArray(),
        VHI_DB_TIMEOUT_MS,
        `protractor-completed-wos ${vin}`,
        [] as any[],
      ),
      budgeted(
        db.collection("tekmetric_work_orders").find({
          shopId: Number(shopId),
          vin: vinUpper
        }).sort({ completedDate: -1 }).limit(50).toArray(),
        VHI_DB_TIMEOUT_MS,
        `tekmetric-completed-wos ${vin}`,
        [] as any[],
      ),
      db.collection("shops").findOne({ shopId }, { projection: { "branding.logo": 1 } })
    ]);
    dvi = localDvi;
    carfax = localCarfax;
    protractorVehicleResult = localProtractorVehicleResult;
    avInspectionResult = localAvInspectionResult;
    protractorCompletedWOs = localProtractorCompletedWOs;
    tekmetricCompletedWOs = localTekmetricCompletedWOs;
    shopBranding = localShopBranding;
  }

  // Protractor Deferred Work - always fetch fresh for Protractor shops (it's dynamic)
  let protractorDeferredWork: ProtractorDeferredWork[] = [];
  if (protractorCfg.configured && (protractorVehicleResult as any).ok && (protractorVehicleResult as any).vehicle?.ID) {
    const deferredResult = await budgeted(
      fetchProtractorDeferredWork(
        shopId,
        vin,
        (protractorVehicleResult as any).vehicle.ID,
        PROTRACTOR_CACHE_TTL
      ),
      VHI_DEFERRED_TIMEOUT_MS,
      `protractor-deferred ${vin}`,
      { ok: false } as unknown as Awaited<ReturnType<typeof fetchProtractorDeferredWork>>,
    );
    if (deferredResult.ok && deferredResult.deferredWork) {
      protractorDeferredWork = deferredResult.deferredWork;
    }
  } else if (useCachedData && cachedPlan?.plan?.deferredWork) {
    // Fallback to cached deferred work if Protractor fetch not available
    protractorDeferredWork = cachedPlan.plan.deferredWork as ProtractorDeferredWork[];
  }

  // Load remedied deferred items to exclude from display
  // Task #998: flag-dispatched PG/Mongo facade read.
  const { listRemediedDeferredWorkDocs } = await import(
    "@/lib/data/repositories/plan-cache-store"
  );
  const remediedItems = await listRemediedDeferredWorkDocs(Number(shopId), vin, db);
  const remediedIds = new Set(remediedItems.map(r => r.deferredId));
  
  // Filter out remedied items from deferred work
  if (remediedIds.size > 0) {
    const beforeCount = protractorDeferredWork.length;
    protractorDeferredWork = protractorDeferredWork.filter(dw => {
      const deferredId = dw.ID || dw.ServiceItemID;
      return !remediedIds.has(deferredId);
    });
    if (protractorDeferredWork.length !== beforeCount) {
      console.log(`[Plan] Filtered out ${beforeCount - protractorDeferredWork.length} remedied deferred items`);
    }
  }

  // Extract service history from completed work orders - only on cache miss
  const shopServiceHistory: ShopServiceHistory[] = [];
  if (!useCachedData) {
  for (const wo of protractorCompletedWOs) {
    const mileage = wo.Odometer ?? wo.OutUsage ?? wo.data?.Odometer ?? null;
    const dateStr = wo.Header?.LastModifiedTime ?? wo.Header?.CreationTime ?? wo.data?.Header?.LastModifiedTime ?? null;
    const date = dateStr ? new Date(dateStr) : null;
    
    const servicePackages = wo.ServicePackages ?? wo.data?.ServicePackages ?? [];
    for (const pkg of servicePackages) {
      const serviceName = pkg.Title ?? pkg.Description ?? "";
      if (serviceName) {
        shopServiceHistory.push({ serviceName, mileage, date });
      }
      for (const line of pkg.ServicePackageLines ?? []) {
        const lineName = line.Description ?? "";
        if (lineName && lineName !== serviceName) {
          shopServiceHistory.push({ serviceName: lineName, mileage, date });
        }
      }
    }
  }
  console.log(`[Plan Debug] Protractor service history entries: ${shopServiceHistory.length}`);
  
  // Extract service history from Tekmetric completed work orders
  for (const wo of tekmetricCompletedWOs) {
    const mileage =
      (typeof wo.odometer === "number" && wo.odometer > 0 ? wo.odometer : null) ??
      (typeof wo.data?.milesOut === "number" && wo.data.milesOut > 0 ? wo.data.milesOut : null) ??
      (typeof wo.data?.milesIn === "number" && wo.data.milesIn > 0 ? wo.data.milesIn : null);
    const date = wo.completedDate ? new Date(wo.completedDate) : null;
    
    // Jobs are stored in wo.data.jobs (canonical) or wo.jobs (fallback for legacy documents)
    const jobs = wo.data?.jobs ?? wo.jobs ?? [];
    for (const job of jobs) {
      const serviceName = job.name ?? job.description ?? "";
      if (serviceName) {
        shopServiceHistory.push({ serviceName, mileage, date });
      }
    }
  }
  console.log(`[Plan Debug] Total shop service history entries (Protractor + Tekmetric): ${shopServiceHistory.length}`);
  }

  const shopLogo: string | null = shopBranding?.branding?.logo || null;

  // Miles/day - use cached value on cache hit, calculate on cache miss
  let mpdBlended: number | null = useCachedData ? (cachedPlan?.plan?.mpdBlended ?? null) : null;
  if (!useCachedData && (carfax as any).ok && Array.isArray((carfax as any).serviceRecords)) {
    const recs = (carfax as any).serviceRecords
      .map((r: any) => ({ date: parseCarfaxDate(r?.date ?? null), miles: typeof r?.odometer === "number" ? r.odometer : null }))
      .filter((r: any) => r.date && typeof r.miles === "number") as { date: Date; miles: number }[];
    recs.sort((a, b) => b.date.getTime() - a.date.getTime());

    const todayMiles =
      typeof vehicle?.lastMileage === "number" && vehicle.lastMileage > 0 && (!recs[0] || vehicle.lastMileage >= recs[0].miles)
        ? vehicle.lastMileage
        : null;

    let fromToday: number | null = null,
      fromTwo: number | null = null;

    if (todayMiles != null && recs[0]) {
      const d = Math.max(1, daysBetween(new Date(), recs[0].date));
      const val = (todayMiles - recs[0].miles) / d;
      fromToday = Math.abs(val) < 0.01 ? null : val; // ignore ~0.0 rates
    }
    if (recs[0] && recs[1]) {
      const d = Math.max(1, daysBetween(recs[0].date, recs[1].date));
      fromTwo = (recs[0].miles - recs[1].miles) / d;
    }
    mpdBlended = fromToday != null && fromTwo != null ? (fromToday + fromTwo) / 2 : fromTwo ?? fromToday ?? null;
  }

  // Get current miles and OEM schedule - skip OEM fetch on cache hit
  let currentMiles: number | null;
  let lastRecordedMiles: number | null = null;
  let mileageRecordedDate: Date | null = null;
  let oemData: any = { source: 'cache', count: 0, items: [], vehicle: null };
  
  if (useCachedData) {
    currentMiles = cachedPlan?.plan?.currentMiles ?? null;
    console.log(`[Plan] Using cached currentMiles: ${currentMiles}`);
  } else {
    const [fetchedResult, fetchedOemData] = await Promise.all([
      budgeted(
        getLatestMilesForVin(db, vin),
        VHI_MILES_TIMEOUT_MS,
        `miles ${vin}`,
        { miles: null, recordedDate: null },
      ),
      budgeted(
        getMaintenanceScheduleCached(vin),
        VHI_OEM_TIMEOUT_MS,
        `dataone-oem ${vin}`,
        // Task #737: mark the timeout fallback so the cache write below can
        // flag the plan as oemMissing (degraded) instead of caching an
        // empty-OEM plan as the 4h truth.
        { ok: false, error: 'timeout', source: 'cache', count: 0, items: [], vehicle: null } as unknown as Awaited<ReturnType<typeof getMaintenanceScheduleCached>>,
      )
    ]);
    currentMiles = fetchedResult.miles;
    lastRecordedMiles = fetchedResult.miles;
    mileageRecordedDate = fetchedResult.recordedDate;
    oemData = fetchedOemData;
    console.log(`[Plan] OEM data source: ${oemData.source}, count: ${oemData.count}`);
  }

  // Task #737: true when the OEM/VIN-attribute lookup FAILED during this
  // build (budget exhausted above, or DataOne itself reported an error such
  // as "DB unavailable"). A legitimately empty schedule (ok:true, count 0)
  // is NOT degraded. On the cache-hit path oemData is a stub, so this stays
  // false and the cached row's own flag (carried below) governs.
  const oemLookupFailed = !useCachedData && oemData?.ok === false && !!oemData?.error;
  if (oemLookupFailed) {
    console.warn(`[Plan] OEM lookup failed for ${vin} (${oemData?.error}) — plan will be cached as degraded (oemMissing)`);
  }

  let mileageEstimated = false;
  let mileageEstimateDetails: any = null;

  if (!currentMiles || currentMiles <= 0) {
    try {
      const estimate = await estimateMileageFromCarfax(shopId, vin);
      if (estimate.estimated) {
        currentMiles = estimate.mileage;
        mileageEstimated = true;
        mileageEstimateDetails = {
          confidence: estimate.confidence,
          dataPoints: estimate.dataPoints,
          lastRecordedMileage: estimate.lastRecordedMileage,
          lastRecordedDate: estimate.lastRecordedDate,
          milesPerDay: estimate.milesPerDay,
        };
        console.log(`[Plan] Estimated mileage for ${vin}: ${currentMiles} mi from CARFAX`);
      }
    } catch {}
  } else if (currentMiles > 0 && mpdBlended != null && mpdBlended > 0 && mileageRecordedDate) {
    const projectToDate = currentRoDate || new Date();
    const daysSinceRecorded = daysBetween(projectToDate, mileageRecordedDate);
    if (daysSinceRecorded >= 1 && daysSinceRecorded <= 180) {
      lastRecordedMiles = currentMiles;
      const projected = Math.round(currentMiles + mpdBlended * daysSinceRecorded);
      currentMiles = projected;
      mileageEstimated = true;
      mileageEstimateDetails = {
        confidence: "projected",
        lastRecordedMileage: lastRecordedMiles,
        lastRecordedDate: mileageRecordedDate.toISOString().split("T")[0],
        projectedToDate: projectToDate.toISOString().split("T")[0],
        milesPerDay: Math.round(mpdBlended * 10) / 10,
        daysSinceRecorded: Math.round(daysSinceRecorded),
      };
      console.log(`[Plan] Projected mileage for ${vin}: ${lastRecordedMiles} + (${mpdBlended.toFixed(1)} mi/day × ${Math.round(daysSinceRecorded)} days) = ${currentMiles} mi (projected to ${projectToDate.toISOString().split("T")[0]})`);
    }
  }

  // Always fetch vehicle info from DataOne local for accurate make/model (fast local query)
  const dataoneVehicle = await getEnhancedVehicleDataLocal(vin);
  
  // Vehicle info fallback: try all sources - DataOne local, cache, vehicles collection, and OEM data
  const vehicleYear = dataoneVehicle.vehicle?.year ?? cachedPlan?.plan?.vehicle?.year ?? vehicle?.year ?? oemData.vehicle?.year;
  const vehicleMake = dataoneVehicle.vehicle?.make ?? cachedPlan?.plan?.vehicle?.make ?? vehicle?.make ?? oemData.vehicle?.make;
  const vehicleModel = dataoneVehicle.vehicle?.model ?? cachedPlan?.plan?.vehicle?.model ?? vehicle?.model ?? oemData.vehicle?.model;
  const vehicleEngine = dataoneVehicle.vehicle?.engine ?? cachedPlan?.plan?.vehicle?.engine ?? oemData.vehicle?.engine;
  // Compute the OE logo once so we don't double-record unmatched-make misses
  // in the unmatched-make tally (each conditional + src JSX call would
  // otherwise count twice per render).
  const vehicleOeLogoUrl = getOELogoUrl(vehicleMake);

  // Build normalized inputs

  const carfaxRecords: Array<{ date?: string; odometer?: number; description?: string; location?: string }> =
    (carfax as any).ok && Array.isArray((carfax as any).serviceRecords)
      ? (carfax as any).serviceRecords.map((r: any) => ({
          date: r.date,
          odometer: r.odometer,
          description: String(r.description || ""),
          location: r.location || null,
        }))
      : [];

  const autoflowDviFindings: Array<{ name?: string; status?: string | number; source?: string; notes?: string | null }> =
    (dvi as any).ok && Array.isArray((dvi as any).categories)
      ? (dvi as any).categories.flatMap((c: any) =>
          Array.isArray(c.items) ? c.items.map((it: any) => ({ name: it.name, status: it.status, source: "autoflow", notes: it.notes ?? null })) : []
        )
      : [];

  // AutoVitals DVI findings (already fetched in parallel above).
  let autoVitalsDviFindings: Array<{ name?: string; status?: string | number; source?: string; notes?: string | null }> = [];
  if ((avInspectionResult as any).ok && (avInspectionResult as any).items) {
    autoVitalsDviFindings = (avInspectionResult as any).items
      .filter((item: any) => item.status === "red" || item.status === "yellow")
      .map((item: any) => ({
        name: item.name,
        status: item.status === "red" ? "0" : "1",
        source: "autovitals",
        notes: item.notes || item.techNotes || null,
      }));
    console.log(`[Plan Debug] AutoVitals DVI items: ${autoVitalsDviFindings.length}`);
  }

  let tekmetricDviFindings: Array<{ name?: string; status?: string | number; source?: string; notes?: string | null }> = [];
  if (activeIntegration === "tekmetric" && latestRepairOrderId) {
    try {
      const cachedWO = await db.collection("tekmetric_work_orders").findOne({
        workOrderId: String(latestRepairOrderId),
        shopId: { $in: [String(shopId), Number(shopId)] }
      });
      const inspections = cachedWO?.inspections || [];
      for (const inspection of inspections) {
        for (const group of inspection.inspectionTasks || []) {
          for (const task of group.tasks || []) {
            const code = task.inspectionRating?.code;
            if (code === "RQRSATTN") {
              tekmetricDviFindings.push({ name: task.name, status: "0", source: "tekmetric", notes: task.finding ?? null });
            } else if (code === "MAYRQRATTN") {
              tekmetricDviFindings.push({ name: task.name, status: "1", source: "tekmetric", notes: task.finding ?? null });
            }
          }
        }
        if (tekmetricDviFindings.length === 0 && inspection.items) {
          for (const item of inspection.items) {
            if (item.status === "bad") {
              tekmetricDviFindings.push({ name: item.name, status: "0", source: "tekmetric", notes: item.note ?? item.notes ?? null });
            } else if (item.status === "marginal") {
              tekmetricDviFindings.push({ name: item.name, status: "1", source: "tekmetric", notes: item.note ?? item.notes ?? null });
            }
          }
        }
      }
      if (tekmetricDviFindings.length > 0) {
        console.log(`[Plan Debug] Tekmetric DVI items: ${tekmetricDviFindings.length} from cached RO ${latestRepairOrderId}`);
      }
    } catch (err: any) {
      console.warn(`[Plan Debug] Tekmetric DVI fetch failed:`, err.message);
    }
  }

  // Task #860: findings parsed from public DVI share links found on
  // Protractor WOs (AutoServe1, avlink.io, AutoFlow microsites, …).
  // Read-only; returns [] unless links have been ingested.
  const dviLinkFindings = await gatherDviLinkFindings(shopId, vin);

  const dviFindings: Array<{ name?: string; status?: string | number; source?: string; notes?: string | null }> = [
    ...autoflowDviFindings,
    ...autoVitalsDviFindings,
    ...tekmetricDviFindings,
    ...dviLinkFindings,
  ];

  const oemItems: OEMItem[] = (oemData.items as any[]).map((x) => ({
    maintenance_id: x.maintenance_id,
    name: x.maintenance_name || x.name,
    category: x.maintenance_category || x.category,
    notes: x.maintenance_notes || x.notes,
    miles: x.miles ?? null,
    months: x.months ?? null,
    intervals: Array.isArray(x.intervals)
      ? x.intervals.map((iv: any) => ({ units: iv?.units ?? null, value: iv?.value ?? null }))
      : [],
    // Task #166: forward duty-cycle aware intervals so the dashboard's
    // local triage can honour the per-vehicle Normal/Severe preference.
    intervalMilesNormal: x.intervalMilesNormal ?? null,
    intervalMonthsNormal: x.intervalMonthsNormal ?? null,
    intervalMilesSevere: x.intervalMilesSevere ?? null,
    intervalMonthsSevere: x.intervalMonthsSevere ?? null,
  }));

  // Debug: Log what data we have
  console.log(`[Plan Debug] VIN: ${vin}`);
  console.log(`[Plan Debug] Current Miles: ${currentMiles}`);
  console.log(`[Plan Debug] OEM Items count: ${oemItems.length}`);
  console.log(`[Plan Debug] CARFAX Records count: ${carfaxRecords.length}`);
  console.log(`[Plan Debug] DVI Findings count: ${dviFindings.length}`);
  if (oemItems.length > 0) {
    console.log(`[Plan Debug] Sample OEM items:`, oemItems.slice(0, 3).map(o => o.name));
  }
  if (carfaxRecords.length > 0) {
    console.log(`[Plan Debug] Sample CARFAX records:`, carfaxRecords.slice(0, 3).map(r => r.description?.substring(0, 50)));
  }
  if (dviFindings.length > 0) {
    console.log(`[Plan Debug] Sample DVI findings:`, dviFindings.slice(0, 5).map(d => ({ name: d.name, status: d.status })));
  }
  console.log(`[Plan Debug] Protractor deferred work count: ${protractorDeferredWork.length}`);

  const declinedServices: DeclinedServiceEntry[] = (vehicle?.declinedServices || []).map((d: any) => ({
    serviceKey: d.serviceKey,
    serviceName: d.serviceName,
    mileage: d.mileage ?? null,
    reason: d.reason ?? null,
    declinedAt: d.declinedAt,
  }));

  // Task #808: fold Tekmetric declined/unauthorized jobs into the local
  // triage (mirrors app/api/plan-build/route.ts). The repository query is
  // scoped to Tekmetric job_index rows, so non-Tekmetric shops simply get
  // an empty list. Fail-open — a slow read never blocks the page.
  let tekmetricDeclinedJobs: TekmetricDeclinedJob[] = [];
  try {
    const declinedRows = await listTekmetricDeferredWorkByVin(Number(shopId), vin, 50);
    tekmetricDeclinedJobs = declinedRows.map((r) => ({
      id: r.id,
      title: r.title,
      date: r.date,
      originalWorkOrderNumber: r.originalWorkOrderNumber,
    }));
  } catch (err) {
    console.warn(`[Plan] Tekmetric declined-work lookup failed for ${vin}:`, err);
  }

  // Filter out "Inspect" or "Check" items if preference is off
  const isInspectItemFilter = (item: TriagedItem) => {
    // Task #198: keep inspect-only fluid rows visible regardless of the
    // showInspectItems toggle — they are the only OEM signal a customer
    // gets about that fluid, and silently dropping them is worse than the
    // user having to ignore one extra row.
    if (item.inspectOnly) return false;
    const title = item.title?.toLowerCase() || "";
    return title.includes("inspect") || title.startsWith("check ");
  };

  // Task #166: classify the engine for oil-interval risk so the dashboard's
  // local triage can flag long intervals on at-risk engines and the soft
  // warning chip surfaces consistently with the extension.
  const oilDutyPreference: "normal" | "severe" =
    vehicle?.oilDutyPreference === "normal" ? "normal" : "severe";
  const dataoneVehicleProfile: any = oemData?.vehicle ?? {};
  const engineProfile: EngineProfile = {
    engine_name: dataoneVehicleProfile.engine ?? null,
    engine_size: typeof dataoneVehicleProfile.engine_size === "number" ? dataoneVehicleProfile.engine_size : null,
    engine_block: dataoneVehicleProfile.engine_block ?? null,
    engine_cylinders: typeof dataoneVehicleProfile.engine_cylinders === "number" ? dataoneVehicleProfile.engine_cylinders : null,
    engine_induction: dataoneVehicleProfile.engine_induction ?? null,
    engine_aspiration: dataoneVehicleProfile.engine_aspiration ?? null,
    fuel_type: dataoneVehicleProfile.fuel_type ?? null,
    make: vehicleMake ?? null,
    model: vehicleModel ?? null,
    year: vehicleYear ?? null,
  };
  let engineRisk: EngineRiskResult | null = null;
  try {
    const overrides = await loadEngineRiskOverrides(db);
    engineRisk = classifyEngineRisk(engineProfile, overrides);
  } catch (err) {
    console.warn(`[Plan] engine-risk classification failed for ${vin}:`, err);
    engineRisk = null;
  }

  // Load shop blurbs once; reapplied post-triage on both fresh and cached
  // paths so admin edits surface without busting the plan cache.
  let shopDviBestPracticeMap = new Map<string, string>();
  try {
    shopDviBestPracticeMap = await getShopDviBestPracticeMap(Number(shopId), db);
  } catch (err) {
    console.warn(`[Plan] Failed to load DVI best-practice blurbs for shop ${shopId}:`, err);
  }

  // Use cached buckets if available, otherwise build from triage
  let buckets: Buckets;

  // Task #803: multi-plan variants (OE / Shop / one per enabled chemical
  // provider). Stays null when the shop has no enabled providers — the page
  // then renders the single Shop plan exactly as before (no tabs).
  type PlanVariantView = {
    id: string;
    kind: "oe" | "shop" | "provider";
    label: string;
    buckets: Buckets;
  };
  let planVariants: PlanVariantView[] | null = null;
  const chemicalProviders = getEnabledChemicalProviders(
    shop?.maintenance?.chemicalProviders
  );
  
  // Check if cached buckets are missing deferred work that should be included
  const cachedDeferredCount = cachedPlan?.plan?.buckets 
    ? [...(cachedPlan.plan.buckets.overdue || []), ...(cachedPlan.plan.buckets.dueSoon || [])].filter((i: any) => i.source === "protractor").length 
    : 0;
  const hasDeferredMismatch = protractorDeferredWork.length > 0 && cachedDeferredCount === 0;
  
  if (useCachedData && cachedPlan) {
    console.log(`[Plan] Using cached buckets for ${vin}`);
    const cached = cachedPlan.plan;
    
    // Convert cached items back to TriagedItem format (dates stored as ISO strings)
    const convertCacheItem = (item: TriagedItemCache): TriagedItem => ({
      ...item,
      action: (item.action as ServiceAction | null | undefined) ?? null,
      last: item.last ? {
        miles: item.last.miles,
        date: item.last.date ? new Date(item.last.date) : null,
        source: item.last.source as "carfax" | "protractor" | "shop" | undefined,
        // Task #434: rehydrate the implied-parent provenance so cached
        // reads render "Anchored to <parent> on <date>" identically to
        // freshly-built plans.
        impliedFromParentKey: item.last.impliedFromParentKey ?? null,
        impliedFromParentName: item.last.impliedFromParentName ?? null,
      } : undefined,
      lastSource: item.lastSource ?? null,
      dueAtDate: item.dueAtDate ? new Date(item.dueAtDate) : null,
    });
    
    buckets = {
      overdue: cached.buckets.overdue.map(convertCacheItem),
      dueSoon: cached.buckets.dueSoon.map(convertCacheItem),
      upcoming: cached.buckets.upcoming.map(convertCacheItem),
    };
    
    // If we have fresh deferred work that's not in cached buckets, add it now
    if (hasDeferredMismatch) {
      console.log(`[Plan] Adding ${protractorDeferredWork.length} deferred items to cached buckets`);
      const existingKeys = new Set([
        ...buckets.overdue.map(i => i.serviceKey),
        ...buckets.dueSoon.map(i => i.serviceKey),
        ...buckets.upcoming.map(i => i.serviceKey),
      ]);
      
      for (const dw of protractorDeferredWork) {
        const title = dw.Title || dw.ServicePackageHeader?.Title || dw.Code || dw.Description || "Deferred Service";
        const serviceKey = toKeyFromName(title) ?? `protractor_deferred_${dw.ID}`;
        
        // Skip if already in buckets (as OEM or other item)
        if (existingKeys.has(serviceKey)) continue;
        
        const deferredItem: TriagedItem = {
          key: `protractor_deferred_${dw.ID}`,
          serviceKey,
          title,
          category: dw.Chapter || "Maintenance",
          intervalMiles: null,
          intervalMonths: null,
          last: undefined,
          dueAtMiles: null,
          dueAtDate: null,
          milesToGo: null,
          daysToGo: null,
          bump: null,
          source: "protractor",
          reason: "Previously recommended but not performed",
          protractorDeferredId: dw.ID,
        };
        buckets.overdue.push(deferredItem);
        existingKeys.add(serviceKey);
      }
    }

    // Task #803: rehydrate cached multi-plan variants. The shop variant
    // reuses the primary `buckets` reference so the deferred-mismatch
    // additions above stay consistent across the primary panel and the
    // Shop tab. Cached rows built before providers were enabled have no
    // `plans` — the page then falls back to the single-plan render.
    if (chemicalProviders.length > 0 && Array.isArray(cached.plans) && cached.plans.length > 0) {
      planVariants = cached.plans.map((v) => ({
        id: v.id,
        kind: v.kind,
        label: v.label,
        buckets: v.kind === "shop" ? buckets : {
          overdue: v.buckets.overdue.map(convertCacheItem),
          dueSoon: v.buckets.dueSoon.map(convertCacheItem),
          upcoming: v.buckets.upcoming.map(convertCacheItem),
        },
      }));
    }
  } else {
    const triageInput = {
      oemItems,
      carfaxRecords,
      shopServiceHistory,
      currentMiles,
      dviFindings,
      protractorDeferredWork,
      declinedServices,
      tekmetricDeclinedJobs,
      soonMiles,
      soonDays,
      milesPerDay: mpdBlended,
      shopIntervals,
      intervalApplyMode,
      vehicleYear: vehicle?.year ?? null,
      engineRisk,
      oilDutyPreference,
      distanceUnit,
    };
    const rawBuckets = triage(triageInput);

    const applyInspectFilter = (raw: Buckets): Buckets => showInspectItems ? raw : {
      overdue: raw.overdue.filter(i => !isInspectItemFilter(i)),
      dueSoon: raw.dueSoon.filter(i => !isInspectItemFilter(i)),
      upcoming: raw.upcoming.filter(i => !isInspectItemFilter(i)),
    };

    buckets = applyInspectFilter(rawBuckets);

    // Task #803: build the OE + provider variants with the SAME triage
    // inputs, only the interval overrides differ. Expensive upstream work
    // (CARFAX/DVI/OEM/deferred fetches) already happened once above.
    if (chemicalProviders.length > 0) {
      const buildVariant = (intervals: Record<string, ShopIntervalOverride>): Buckets =>
        applyInspectFilter(triage({ ...triageInput, shopIntervals: intervals }));
      planVariants = [
        { id: "oe", kind: "oe", label: "OE Plan", buckets: buildVariant({}) },
        { id: "shop", kind: "shop", label: "Shop Plan", buckets },
        ...chemicalProviders.map((p) => ({
          id: `provider:${p.id}`,
          kind: "provider" as const,
          label: p.name,
          buckets: buildVariant(providerIntervalsToOverrides(p) as Record<string, ShopIntervalOverride>),
        })),
      ];
    }

    console.log(`[Plan Debug] Thresholds: soonMiles=${soonMiles}, soonDays=${soonDays}`);
    console.log(`[Plan Debug] Buckets: overdue=${rawBuckets.overdue.length}, dueSoon=${rawBuckets.dueSoon.length}, upcoming=${rawBuckets.upcoming.length}${!showInspectItems ? ` (filtered: overdue=${buckets.overdue.length}, dueSoon=${buckets.dueSoon.length}, upcoming=${buckets.upcoming.length})` : ''}`);
  }

  // Attach per-shop blurbs to DVI Finding tiles (covers fresh + cached
  // paths). OEM rows are excluded so blurbs never collide with row notes.
  if (shopDviBestPracticeMap.size > 0) {
    const applyBlurb = (item: TriagedItem) => {
      if (item.category === "DVI Finding" && item.serviceKey) {
        const blurb = shopDviBestPracticeMap.get(item.serviceKey);
        if (blurb) item.bestPracticeBlurb = blurb;
      }
    };
    buckets.overdue.forEach(applyBlurb);
    buckets.dueSoon.forEach(applyBlurb);
    buckets.upcoming.forEach(applyBlurb);
    // Task #803: variant tabs get the same blurbs (idempotent — the shop
    // variant shares the primary buckets reference).
    if (planVariants) {
      for (const v of planVariants) {
        v.buckets.overdue.forEach(applyBlurb);
        v.buckets.dueSoon.forEach(applyBlurb);
        v.buckets.upcoming.forEach(applyBlurb);
      }
    }
  }

  // Task #804: protection-plan enrollment status per provider. Enrollment
  // is metadata only — it never feeds triage/plan math. Reads are cheap
  // (one enrollments find + one bounded job_index find) and run on BOTH
  // the cached and fresh plan paths so badges survive cache hits.
  type ProtectionPlanInfo = {
    providerId: string;
    providerName: string;
    status: ProtectionPlanStatus;
    enrolledAt: Date | null;
    enrolledBy: string | null;
    overdueRequired: { serviceKey: string; title: string }[];
    eligibilityMatches: string[];
  };
  const protectionPlanByVariantId = new Map<string, ProtectionPlanInfo>();
  if (chemicalProviders.length > 0 && planVariants && planVariants.length > 0) {
    const [enrollments, historyJobNames] = await Promise.all([
      budgeted(
        listEnrollmentsForVehicle(shopId, vin),
        3000,
        `protection-plan enrollments ${vin}`,
        [] as Awaited<ReturnType<typeof listEnrollmentsForVehicle>>,
      ),
      budgeted(
        listJobNamesForVehicle(shopId, vin),
        3000,
        `protection-plan history ${vin}`,
        [] as string[],
      ),
    ]);
    // Fresh builds also carry shopServiceHistory names — fold them in so
    // eligibility works even before job_index catches up.
    const allHistoryNames = [
      ...historyJobNames,
      ...shopServiceHistory.map((h) => h.serviceName),
    ];
    for (const provider of chemicalProviders) {
      const variantId = `provider:${provider.id}`;
      const variant = planVariants.find((v) => v.id === variantId);
      if (!variant) continue;
      const enrollment = enrollments.find((e) => e.providerId === provider.id) ?? null;
      const lapse = computeLapseRisk(provider, variant.buckets.overdue);
      const eligibility = detectProviderEligibility(provider, allHistoryNames);
      protectionPlanByVariantId.set(variantId, {
        providerId: provider.id,
        providerName: provider.name,
        status: resolveProtectionPlanStatus({
          enrolled: !!enrollment,
          atRisk: lapse.atRisk,
          eligible: eligibility.eligible,
        }),
        enrolledAt: enrollment?.enrolledAt ?? null,
        enrolledBy: enrollment?.enrolledBy ?? null,
        overdueRequired: lapse.overdueRequired,
        eligibilityMatches: eligibility.matches,
      });
    }
  }
  // Enrolled vehicles land on their provider's tab by default. First
  // enrolled provider wins if a vehicle is somehow enrolled in several.
  const enrolledVariantId =
    Array.from(protectionPlanByVariantId.entries()).find(
      ([, info]) => info.status === "enrolled" || info.status === "at_risk",
    )?.[0] ?? null;

  const COMPLIMENTARY_KEYS = new Set([
    "oil_reminder", "oil_replacement_reminder", "reset_oil_replacement_reminder",
    "chassis_body", "tighten_nuts_bolts",
    "multi_point_inspection", "tire_pressure", "tire_pressure_check",
  ]);
  const COMPLIMENTARY_TITLE_KEYWORDS = [
    "oil replacement reminder", "maint reqd", "oil reset", "reset oil",
    "tighten nuts and bolts", "tighten nuts & bolts", "chassis and body", "chassis & body",
    "multi-point inspection", "multi point inspection",
    "tire pressure check", "tire pressure set", "set tire pressure",
  ];
  const isComplimentary = (t: TriagedItem) => {
    const key = (t.serviceKey || t.key || "").toLowerCase();
    if (COMPLIMENTARY_KEYS.has(key)) return true;
    const title = t.title.toLowerCase();
    return COMPLIMENTARY_TITLE_KEYWORDS.some(kw => title.includes(kw));
  };

  const complimentaryOverdue = buckets.overdue.filter(t => isComplimentary(t) && t.source !== "protractor");
  const complimentaryDueSoon = buckets.dueSoon.filter(isComplimentary);
  const allComplimentary = [...complimentaryOverdue, ...complimentaryDueSoon];

  // Separate overdue items into non-deferred and deferred, excluding complimentary
  const overdueNonDeferred = buckets.overdue.filter(t => t.source !== "protractor" && !isComplimentary(t));
  const overdueDeferred = buckets.overdue.filter(t => t.source === "protractor");
  const dueSoonFiltered = buckets.dueSoon.filter(t => !isComplimentary(t));
  
  const counts = {
    overdue: overdueNonDeferred.length,
    deferred: overdueDeferred.length,
    soon: dueSoonFiltered.length,
    upcoming: buckets.upcoming.length,
    complimentary: allComplimentary.length,
  };

  // Cache the assembled plan for future requests (non-blocking)
  // Also re-cache if we rebuilt due to stale deferred work
  if ((!useCachedData || hasDeferredMismatch) && currentMiles != null) {
    const cacheItem = (item: TriagedItem): TriagedItemCache => ({
      key: item.key,
      serviceKey: item.serviceKey,
      title: item.title,
      category: item.category,
      intervalMiles: item.intervalMiles,
      intervalMonths: item.intervalMonths,
      last: item.last ? {
        miles: item.last.miles,
        date: item.last.date?.toISOString() ?? null,
        source: item.last.source,
        // Task #434: persist implied-parent provenance into the cache so
        // cached reads render "Anchored to <parent> on <date>".
        impliedFromParentKey: item.last.impliedFromParentKey ?? null,
        impliedFromParentName: item.last.impliedFromParentName ?? null,
      } : undefined,
      lastSource: item.lastSource ?? null,
      dueAtMiles: item.dueAtMiles,
      dueAtDate: item.dueAtDate?.toISOString() ?? null,
      milesToGo: item.milesToGo,
      daysToGo: item.daysToGo,
      bump: item.bump,
      source: item.source,
      dviSource: item.dviSource,
      reason: item.reason,
      usingShopInterval: item.usingShopInterval,
      protractorDeferredId: item.protractorDeferredId,
      matchedDeferred: item.matchedDeferred,
      action: item.action ?? null,
      notes: item.notes ?? null,
      // Task #166: persist engine-aware metadata so cached plans render
      // the soft warning chip and remember which duty schedule was used.
      engineRiskFlag: item.engineRiskFlag,
      engineRiskReason: item.engineRiskReason ?? null,
      intervalSchedule: item.intervalSchedule ?? null,
      intervalMilesNormal: item.intervalMilesNormal ?? null,
      intervalMonthsNormal: item.intervalMonthsNormal ?? null,
      intervalMilesSevere: item.intervalMilesSevere ?? null,
      intervalMonthsSevere: item.intervalMonthsSevere ?? null,
      recommendedDefault: item.recommendedDefault,
      recommendedReason: item.recommendedReason ?? null,
      // Task #868: persist the lifetime-fluid distinction so cached reads
      // render the correct badge (lifetime text vs generic shop rec).
      lifetimeFluidDefault: item.lifetimeFluidDefault ?? false,
      // Task #198: persist inspect-only fluid flag so cached plans render
      // the OEM-inspect chip and apply the showInspectItems exemption.
      inspectOnly: item.inspectOnly,
      inspectOnlyReason: item.inspectOnlyReason ?? null,
    });
    
    const planData: CachedPlanData = {
      buckets: {
        overdue: buckets.overdue.map(cacheItem),
        dueSoon: buckets.dueSoon.map(cacheItem),
        upcoming: buckets.upcoming.map(cacheItem),
      },
      vehicle: {
        year: vehicleYear ?? null,
        make: vehicleMake ?? null,
        model: vehicleModel ?? null,
        engine: vehicleEngine ?? null,
      },
      currentMiles,
      mpdBlended,
      customerName,
      latestRoNumber,
      distanceUnit,
      soonMiles,
      soonDays,
      showInspectItems,
      // Persist the freshly-fetched Protractor deferred work into the cache so
      // a later cache HIT can render it without re-making the live Protractor
      // round-trips. The cache-hit path reads this back via the
      // `cachedPlan.plan.deferredWork` fallback.
      deferredWork: protractorDeferredWork,
      // Task #166: persist classifier output and active duty preference so
      // cached reads keep the chip + interval choice in sync.
      engineRisk: engineRisk
        ? {
            flagged: engineRisk.flagged,
            reasons: engineRisk.reasons ?? [],
            source: engineRisk.source,
            matchedOverrideId: engineRisk.matchedOverrideId ?? null,
            matchedOverrideLabel: engineRisk.matchedOverrideLabel ?? null,
          }
        : undefined,
      oilDutyPreference,
      // Task #384: persist mileage provenance so external VHI responses
      // echo the same `mileageSource` / `mileageEstimateDetails` whether
      // they're served from this cached plan or freshly built. The
      // dashboard estimates either via CARFAX (`estimated_carfax`) or via
      // a date-projection from the last recorded reading (also CARFAX-backed).
      mileageSource: mileageEstimated ? "estimated_carfax" : "actual",
      mileageEstimateDetails: mileageEstimated ? mileageEstimateDetails : null,
      // Task #737: flag plans built while the OEM lookup failed so the cache
      // layer stores them with a short TTL and skips them on the next read
      // (forcing the OEM fetch to be retried and the plan upgraded). On the
      // re-cache path (deferred mismatch, cache hit) carry the cached row's
      // own flag forward instead of silently clearing it.
      oemMissing: useCachedData
        ? (cachedPlan?.plan?.oemMissing === true ? true : undefined)
        : (oemLookupFailed ? true : undefined),
      // Task #803: persist the multi-plan variants so cache hits render the
      // OE/Shop/provider tabs without re-running triage.
      ...(planVariants
        ? {
            plans: planVariants.map((v): CachedPlanVariant => ({
              id: v.id,
              kind: v.kind,
              label: v.label,
              buckets: {
                overdue: v.buckets.overdue.map(cacheItem),
                dueSoon: v.buckets.dueSoon.map(cacheItem),
                upcoming: v.buckets.upcoming.map(cacheItem),
              },
            })),
          }
        : {}),
    };
    
    setCachedPlan(db, vin, shopId, currentMiles, planData).catch(err => {
      console.error(`[Plan] Failed to cache plan for ${vin}:`, err);
    });
  }

  // Task #737: slow-load observability. One structured line per slow or
  // degraded load (plus a best-effort Mongo record in `slow_plan_load_logs`)
  // so the next "VIN attributes take forever" report can be traced to a
  // shop/VIN/timestamp and to WHICH upstream budget was exhausted. Fast,
  // healthy loads log nothing.
  {
    const planLoadDurationMs = Date.now() - planLoadStart;
    const slowLoad = planLoadDurationMs >= SLOW_PLAN_LOAD_THRESHOLD_MS;
    if (slowLoad || exhaustedBudgets.length > 0 || oemLookupFailed) {
      const record = {
        shopId,
        vin,
        durationMs: planLoadDurationMs,
        cacheHit: useCachedData,
        forceRefresh,
        exhaustedBudgets,
        oemMissing: oemLookupFailed,
        createdAt: new Date(),
      };
      console.warn(`[PlanSlowLoad] ${JSON.stringify(record)}`);
      db.collection("slow_plan_load_logs").insertOne(record).catch((err) => {
        console.error(`[PlanSlowLoad] Failed to record slow load for ${vin}:`, err);
      });
    }
  }

  return (
    <PlanTrialGate vin={vin}>
      <>
      {/* Sticky summary header - no nested overflow wrapper, uses dashboard layout's scroll.
          Hidden in print so the dedicated print-only header below is the single
          vehicle header that reaches the PDF. */}
      <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b shadow-sm print:hidden">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 py-3">
          {/* Top navigation menu */}
          <nav className="flex items-center gap-4 text-sm text-blue-600 mb-2">
            <Link href="/dashboard" className="hover:underline">← Back</Link>
            <Link href={`/dashboard/vehicles/${vin}?tab=oe`} className="hover:underline">OE</Link>
            <Link href={`/dashboard/vehicles/${vin}?tab=dvi`} className="hover:underline">DVI</Link>
            <Link href={`/dashboard/vehicles/${vin}?tab=carfax`} className="hover:underline">CARFAX</Link>
          </nav>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex items-center gap-3">
              {vehicleOeLogoUrl && (
                <img 
                  src={vehicleOeLogoUrl} 
                  alt={vehicleMake || ""} 
                  className="h-10 sm:h-12 object-contain flex-shrink-0" 
                />
              )}
              <div>
                <h1 className="text-xl sm:text-2xl font-bold truncate">
                  {[vehicleYear, vehicleMake, vehicleModel].filter(Boolean).join(" ") || "Vehicle"}
                </h1>
                <div className="text-sm text-neutral-600">
                  {customerName && <><span className="font-medium text-neutral-800">{customerName}</span> • </>}
                  {latestRoNumber && <>RO# <code className="font-medium">{latestRoNumber}</code> • </>}
                  VIN <code>{vin}</code>
                  {currentMiles != null && currentMiles > 0 && (
                    <> • Current: <span
                      className={mileageEstimated ? 'font-bold italic cursor-help border-b border-dashed border-neutral-400' : ''}
                      title={mileageEstimated && mileageEstimateDetails
                        ? mileageEstimateDetails.confidence === "projected"
                          ? `Projected to check-in ${mileageEstimateDetails.projectedToDate || 'date'}\nLast recorded: ${mileageEstimateDetails.lastRecordedMileage.toLocaleString()} mi on ${mileageEstimateDetails.lastRecordedDate}\n+ ${mileageEstimateDetails.milesPerDay} mi/day × ${mileageEstimateDetails.daysSinceRecorded} days`
                          : `Estimated from CARFAX (${mileageEstimateDetails.dataPoints} data points)\nLast recorded: ${mileageEstimateDetails.lastRecordedMileage.toLocaleString()} mi on ${mileageEstimateDetails.lastRecordedDate}\nAvg: ${mileageEstimateDetails.milesPerDay} mi/day`
                        : undefined}
                    >{fmtMiles(currentMiles)} {distLabel}{mileageEstimated ? ' (est.)' : ''}</span></>
                  )}
                  {mpdBlended != null && <> • <span
                      className="font-bold italic cursor-help border-b border-dashed border-neutral-400"
                      title={`Estimated driving rate based on CARFAX service history`}
                    >~{mpdBlended.toFixed(1)} {distLabel}/day</span></>}
                </div>
              </div>
            </div>
            
            {/* Health Intelligence branding - moved to right */}
            <div className="hidden sm:flex items-center gap-3">
              <img src="/icons/vehicle-health-intelligence.png?v=4" alt="" className="w-14 h-14" />
              <div className="flex flex-col items-center">
                <div className="text-lg font-semibold text-blue-800">Vehicle Health Indicator<sup className="text-xs">™</sup></div>
                <div className="text-xs italic text-blue-600">authentically intelligent</div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <OilDutyToggle vin={vin} initialPreference={vehicle?.oilDutyPreference === "normal" ? "normal" : "severe"} />
              <ShareReportButton vin={vin} />
              <PrintButton />
              <nav className="flex items-center gap-2 text-xs sm:text-sm print:hidden">
                {showRecalls && (
                  <a href="#recalls" className={`rounded-full px-3 py-1 ${recallCount > 0 ? 'bg-red-700' : 'bg-green-600'} text-white`}>
                    {recallCount > 0 ? `Recalls ${recallCount}` : '✓ No Recalls'}
                  </a>
                )}
                <a href="#overdue" className="rounded-full px-3 py-1 bg-red-600 text-white">
                  Needs attention {counts.overdue}
                </a>
                {counts.deferred > 0 && (
                  <a href="#deferred" className="inline-flex items-center gap-1 rounded-full px-3 py-1 bg-blue-600 text-white">
                    <img src="/protractor-icon.png" alt="" className="w-3.5 h-3.5 rounded-full" />
                    Deferred {counts.deferred}
                  </a>
                )}
                <a href="#soon" className="rounded-full px-3 py-1 bg-amber-600 text-white">
                  Due soon {counts.soon}
                </a>
                {counts.complimentary > 0 && (
                  <a href="#complimentary" className="rounded-full px-3 py-1 bg-blue-500 text-white">
                    Additional {counts.complimentary}
                  </a>
                )}
                <a href="#upcoming" className="rounded-full px-3 py-1 bg-emerald-600 text-white">
                  Upcoming {counts.upcoming}
                </a>
              </nav>
            </div>
          </div>
        </div>
      </div>

      {/* Task #991 — Auto DVI: generate a vehicle-specific inspection from
          this VHI plus the shop's custom items. Feature-gated (dark launch). */}
      {featureEntitlements.effectiveFeatures.auto_dvi && (
        <AutoDviPanel
          vin={vin}
          mileage={null}
          isProtractor={Boolean((shop as any)?.protractor?.configured ?? (shop as any)?.protractor)}
        />
      )}

      {/* Print-only header with shop logo */}
      <div className="hidden print:block mb-6 border-b pb-4 mx-auto max-w-5xl px-4 sm:px-6">
        <div className="flex items-center justify-between">
          {shopLogo ? (
            <img src={shopLogo} alt="Shop Logo" className="h-12" />
          ) : (
            <div className="flex items-center gap-2">
              {vehicleOeLogoUrl && (
                <img src={vehicleOeLogoUrl} alt={vehicleMake || ""} className="h-10" />
              )}
              <span className="text-lg font-bold text-neutral-800">
                {[vehicleYear, vehicleMake, vehicleModel].filter(Boolean).join(" ") || "Vehicle"}
              </span>
            </div>
          )}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1 bg-blue-50 rounded-lg border border-blue-100">
              <img src="/icons/vehicle-health-intelligence.png?v=3" alt="" className="w-6 h-6" />
              <div className="flex flex-col items-center">
                <span className="text-sm font-semibold text-blue-800">Vehicle Health Indicator</span>
                <span className="text-[10px] italic text-blue-600">authentically intelligent</span>
              </div>
            </div>
            <div className="text-right text-sm text-neutral-600">
              <div>Report Date: {new Date().toLocaleDateString()}</div>
            </div>
          </div>
        </div>
        <div className="mt-4">
          <h1 className="text-2xl font-bold flex items-center gap-3">
            {vehicleOeLogoUrl && (
              <img src={vehicleOeLogoUrl} alt={vehicleMake || ""} className="h-10" />
            )}
            {[vehicleYear, vehicleMake, vehicleModel].filter(Boolean).join(" ") || "Vehicle"}
          </h1>
          <div className="text-sm text-neutral-600 mt-1">
            VIN: {vin}
            {currentMiles != null && currentMiles > 0 && (
              <> • Current: <span
                className={mileageEstimated ? 'font-bold italic cursor-help border-b border-dashed border-neutral-400' : ''}
                title={mileageEstimated && mileageEstimateDetails
                  ? mileageEstimateDetails.confidence === "projected"
                    ? `Projected to check-in ${mileageEstimateDetails.projectedToDate || 'date'}\nLast recorded: ${mileageEstimateDetails.lastRecordedMileage.toLocaleString()} mi on ${mileageEstimateDetails.lastRecordedDate}\n+ ${mileageEstimateDetails.milesPerDay} mi/day × ${mileageEstimateDetails.daysSinceRecorded} days`
                    : `Estimated from CARFAX (${mileageEstimateDetails.dataPoints} data points)\nLast recorded: ${mileageEstimateDetails.lastRecordedMileage.toLocaleString()} mi on ${mileageEstimateDetails.lastRecordedDate}\nAvg: ${mileageEstimateDetails.milesPerDay} mi/day`
                  : undefined}
              >{fmtMiles(currentMiles)} {distLabel}{mileageEstimated ? ' (est.)' : ''}</span></>
            )}
          </div>
        </div>
      </div>

      {/* Buckets (single column for easy scanning) */}
      <div className="mx-auto max-w-5xl px-4 sm:px-6 space-y-8">
        {/* NHTSA Recalls Section - Conditionally shown based on shop preferences */}
        {showRecalls && (
          <section id="recalls" className="space-y-3">
            <details open={recallsExpanded} className="group">
              <summary className="text-lg font-semibold text-neutral-700 flex items-center gap-2 cursor-pointer list-none">
                <span className="text-xl">🚨</span> NHTSA Recalls ({recallCount})
                <svg className="w-4 h-4 ml-auto transition-transform group-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </summary>
              <div className="mt-3 space-y-3">
                {recallCount === 0 ? (
                  <div className="rounded-xl border border-green-200 bg-green-50 p-4">
                    <div className="flex items-center gap-2 text-green-700">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="font-medium">No open recalls for this vehicle</span>
                    </div>
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {recalls.map((recall) => (
                      <li 
                        key={recall.nhtsa_recall_id} 
                        className={`rounded-xl border-2 p-4 ${
                          recall.isSafetyCritical 
                            ? 'border-red-500 bg-red-50' 
                            : 'border-amber-400 bg-amber-50'
                        }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`text-sm font-bold px-2 py-0.5 rounded ${
                                recall.isSafetyCritical 
                                  ? 'bg-red-600 text-white' 
                                  : 'bg-amber-500 text-white'
                              }`}>
                                {recall.isSafetyCritical ? '⚠️ SAFETY' : 'RECALL'}
                              </span>
                              <code className="text-sm font-mono bg-white/50 px-2 py-0.5 rounded">
                                {recall.nhtsa_campaign_number}
                              </code>
                              <span className="text-sm text-neutral-600">{recall.component_description}</span>
                              {recall.carfaxRemedyStatus && (
                                <span
                                  className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                                    /not\s+yet/i.test(recall.carfaxRemedyStatus)
                                      ? 'bg-orange-100 text-orange-800 border-orange-300'
                                      : 'bg-green-100 text-green-800 border-green-300'
                                  }`}
                                  title={`Per CARFAX${recall.carfaxManufacturerRecallNumber ? ` — Mfr recall #${recall.carfaxManufacturerRecallNumber}` : ''}`}
                                >
                                  {recall.carfaxRemedyStatus} · CARFAX
                                </span>
                              )}
                            </div>
                            
                            {recall.consequence_summary && (
                              <div className="mt-2">
                                <span className="text-xs font-semibold text-red-700 uppercase">Risk: </span>
                                <span className="text-sm text-neutral-700">{recall.consequence_summary}</span>
                              </div>
                            )}
                            
                            {recall.corrective_action_summary && (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-sm text-blue-600 hover:underline">
                                  View fix details
                                </summary>
                                <div className="mt-1 text-sm text-neutral-600 bg-white/50 p-2 rounded">
                                  <span className="font-semibold">Fix: </span>
                                  {recall.corrective_action_summary}
                                </div>
                              </details>
                            )}
                            
                            {recall.potential_units_affected && recall.potential_units_affected > 0 && (
                              <div className="mt-2 text-xs text-neutral-500">
                                {recall.potential_units_affected.toLocaleString()} vehicles affected
                                {recall.record_creation_date && ` • Issued ${new Date(recall.record_creation_date).toLocaleDateString()}`}
                              </div>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {carfaxOnlyRecalls.length > 0 && (
                  <ul className="space-y-3">
                    {carfaxOnlyRecalls.map((cfx: CarfaxRecallRecord, idx: number) => (
                      <li
                        key={cfx.nhtsaCampaignNumber || cfx.manufacturerRecallNumber || `carfax-recall-${idx}`}
                        className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-bold px-2 py-0.5 rounded bg-amber-500 text-white">
                                {cfx.recallType && /emission/i.test(cfx.recallType) ? 'EMISSIONS RECALL' : 'RECALL'}
                              </span>
                              {cfx.nhtsaCampaignNumber && (
                                <code className="text-sm font-mono bg-white/50 px-2 py-0.5 rounded">
                                  {cfx.nhtsaCampaignNumber}
                                </code>
                              )}
                              <span className="text-sm text-neutral-600">
                                {cfx.description || cfx.text.join(' — ')}
                              </span>
                              {cfx.remedyStatus && (
                                <span
                                  className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                                    /not\s+yet/i.test(cfx.remedyStatus)
                                      ? 'bg-orange-100 text-orange-800 border-orange-300'
                                      : 'bg-green-100 text-green-800 border-green-300'
                                  }`}
                                >
                                  {cfx.remedyStatus} · CARFAX
                                </span>
                              )}
                            </div>
                            <div className="mt-2 text-xs text-neutral-500">
                              Reported by CARFAX
                              {cfx.manufacturerRecallNumber && ` • Mfr recall #${cfx.manufacturerRecallNumber}`}
                              {cfx.date && ` • Issued ${cfx.date}`}
                            </div>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          </section>
        )}

        {/* Task #803: all plan sections render through this closure so the
            OE/Shop/provider tabs can re-render them from a different bucket
            set. The primary (Shop) panel keeps the unsuffixed section ids the
            header count pills anchor to; other tabs suffix their ids so the
            DOM stays unique while hidden. */}
        {(() => {
          const renderPlanSections = (sectionBuckets: Buckets, idSuffix: string = "") => {
            const buckets = sectionBuckets;
            const complimentaryOverdue = buckets.overdue.filter(t => isComplimentary(t) && t.source !== "protractor");
            const complimentaryDueSoon = buckets.dueSoon.filter(isComplimentary);
            const allComplimentary = [...complimentaryOverdue, ...complimentaryDueSoon];
            const overdueNonDeferred = buckets.overdue.filter(t => t.source !== "protractor" && !isComplimentary(t));
            const overdueDeferred = buckets.overdue.filter(t => t.source === "protractor");
            const dueSoonFiltered = buckets.dueSoon.filter(t => !isComplimentary(t));
            const counts = {
              overdue: overdueNonDeferred.length,
              deferred: overdueDeferred.length,
              soon: dueSoonFiltered.length,
              upcoming: buckets.upcoming.length,
              complimentary: allComplimentary.length,
            };
            return (
              <>
        {/* Overdue (non-deferred) */}
        <section id={`overdue${idSuffix}`} className="space-y-3">
          <h2 className="text-lg font-semibold text-red-700 flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-600" /> Needs attention
            <span className="text-xs font-semibold rounded-full bg-red-100 text-red-700 px-2 py-0.5">{counts.overdue}</span>
          </h2>
          {overdueNonDeferred.length === 0 ? (
            <div className="text-sm text-neutral-500">Nothing overdue 🎉</div>
          ) : (
            <ul className="space-y-3">
              {overdueNonDeferred.map((t) => (
                <li key={t.key} className="rounded-xl border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <ServiceIcon serviceKey={t.serviceKey} title={t.title} size={22} className="shrink-0 text-neutral-500" />
                        <div className="font-medium">{t.title}</div>
                      </div>
                      {t.notes && t.notes.trim() && (
                        <div className="text-xs italic text-neutral-600 mt-0.5">{t.notes.trim()}</div>
                      )}
                      {t.category === "DVI Finding" && t.bestPracticeBlurb && t.bestPracticeBlurb.trim() && (
                        <div className="text-xs text-neutral-700 mt-0.5 leading-snug">{t.bestPracticeBlurb.trim()}</div>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-neutral-600">
                        {t.category && <span className="rounded-full bg-neutral-100 px-2 py-0.5">{t.category}</span>}
                        {(() => {
                          // Task #392: include the axis that triggered the
                          // overdue state in the badge so users can tell
                          // whether time, mileage, or both pushed the item
                          // past due. Prefer the stamped triage values
                          // (covers cached items round-tripping through
                          // TriagedItemCache); recompute only as a
                          // fallback for legacy rows that pre-date #392.
                          // Task #865: calm sentence-case pill; the trigger
                          // axis moves into the tooltip.
                          const trig =
                            (t as any).byMiles !== undefined || (t as any).byTime !== undefined
                              ? { byMiles: (t as any).byMiles ?? null, byTime: (t as any).byTime ?? null }
                              : getProgressTriggers(t, currentMiles, undefined, distanceUnit);
                          const suffix = formatTriggerSuffix(trig.byMiles, trig.byTime, "overdue");
                          return (
                            <span
                              className="rounded-full bg-red-500 text-white px-2 py-0.5 font-medium"
                              title={suffix ? `Overdue${suffix}` : undefined}
                            >
                              Overdue
                            </span>
                          );
                        })()}
                        {t.recommendedDefault && (
                          <span
                            className="rounded-full bg-blue-600 text-white px-2 py-0.5"
                            title={t.recommendedReason || (t.lifetimeFluidDefault ? "OEM lists this as lifetime fluid; shop recommendation only." : "Shop-recommended service.")}
                          >
                            {t.lifetimeFluidDefault
                              ? <>OEM lifetime fluid · Shop recommendation at {(distanceUnit === "kilometers" ? Math.round(LIFETIME_FLUID_DEFAULT_MILES * 1.60934) : LIFETIME_FLUID_DEFAULT_MILES).toLocaleString()} {distLabel}</>
                              : <>Shop recommendation{t.intervalMiles ? ` · every ${t.intervalMiles.toLocaleString()} ${distLabel}` : ""}</>}
                          </span>
                        )}
                        {t.inspectOnly && (
                          <span
                            className="rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5"
                            title={t.inspectOnlyReason || "OEM only schedules an inspection (not a replacement) for this fluid."}
                          >
                            OEM: Inspect{t.intervalMiles ? ` every ${t.intervalMiles.toLocaleString()} ${distLabel}` : (t.intervalMonths ? ` every ${t.intervalMonths} mo` : "")}
                          </span>
                        )}
                        {t.reason && !t.last?.miles && !t.recommendedDefault && (
                          <span className="rounded-full bg-neutral-200 text-neutral-600 px-2 py-0.5 italic">{t.reason}</span>
                        )}
                        {(t.intervalMiles || t.intervalMonths) && (
                          <span className={`rounded-full border px-2 py-0.5 inline-flex items-center gap-1 ${t.usingShopInterval ? "bg-green-50 border-green-300" : ""}`}>
                            {t.usingShopInterval && shopLogo ? (
                              <img src={shopLogo} alt="Shop" className="h-3 inline" />
                            ) : null}
                            {t.usingShopInterval ? "Shop" : (t.source === "common" ? "Recommended" : "OEM")}: {t.intervalMiles ? `${fmtDistance(t.intervalMiles, distanceUnit)} ${distLabel}` : ""}
                            {t.intervalMiles && t.intervalMonths ? " / " : ""}
                            {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                          </span>
                        )}
                        {t.engineRiskFlag && (
                          <span
                            className="rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5 inline-flex items-center gap-1"
                            title={t.engineRiskReason ?? "Engine flagged for accelerated oil wear."}
                          >
                            ⚠ Engine flagged — long oil interval
                          </span>
                        )}
                        {t.recommendedDefault && t.lifetimeFluidDefault && (
                          <span
                            className="rounded-full bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5"
                            title={t.recommendedReason ?? undefined}
                          >
                            Shop recommendation
                          </span>
                        )}
                        {t.bump === "red" && t.source !== "protractor" && (
                          <span className={`rounded-full text-white px-2 py-0.5 ${t.dviSource === "autovitals" ? "bg-teal-600" : t.dviSource === "tekmetric" ? "bg-orange-600" : "bg-red-600"}`}>
                            {t.dviSource === "autovitals" ? "AutoVitals 🔴" : t.dviSource === "tekmetric" ? "Tekmetric DVI 🔴" : "DVI 🔴"}
                          </span>
                        )}
                        {t.source === "protractor" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 border border-blue-200 px-2 py-0.5">
                            <img 
                              src={shopLogo || "/protractor-icon.png"} 
                              alt="Shop" 
                              className="w-4 h-4 rounded-full object-cover"
                            />
                            <span className="text-blue-700 text-xs">Deferred</span>
                          </span>
                        )}
                        {t.usingShopInterval && <span className="rounded-full bg-green-600 text-white px-2 py-0.5">Shop</span>}
                        {t.declined && (
                          <span className="rounded-full bg-orange-100 text-orange-700 border border-orange-300 px-2 py-0.5 font-medium">
                            Previously declined
                          </span>
                        )}
                      </div>
                    </div>
                    {(() => {
                      const opts = getCannedJobOptionsForService(t.serviceKey);
                      return (
                        <AddToROWithHistory
                          vin={vin}
                          serviceTitle={t.title}
                          serviceKey={t.serviceKey}
                          vehicleYear={vehicleYear}
                          vehicleMake={vehicleMake}
                          vehicleModel={vehicleModel}
                          vehicleEngine={vehicleEngine}
                          workOrderGuid={latestWorkOrderId ?? undefined}
                          workOrderId={latestRoNumber ?? undefined}
                          repairOrderId={latestRepairOrderId ?? undefined}
                          cannedJobOptions={opts}
                          integration={activeIntegration ?? "protractor"}
                          showHistoryButton={hasJobLookupFeature}
                          protractorDeferredId={t.protractorDeferredId}
                          matchedDeferred={t.matchedDeferred}
                        />
                      );
                    })()}
                  </div>

                  <IntervalProgressRow
                    task={t}
                    currentMiles={currentMiles}
                    distanceUnit={distanceUnit}
                    status="overdue"
                  />

                  {(() => {
                    // Prefer the time-interval anchor (last service date +
                    // intervalMonths) over the stored dueAtDate, which can be
                    // a mileage-projected date for high-mileage drivers. This
                    // keeps the "(N months overdue)" pill aligned with the
                    // time progress bar's "X mos over" headline.
                    const timeAxisDate =
                      t.last?.date && t.intervalMonths
                        ? addMonths(t.last.date, t.intervalMonths)
                        : t.dueAtDate ?? null;
                    const overdueFmt = timeAxisDate ? formatOverdueDate(timeAxisDate) : null;
                    return (
                      <div className="text-sm mt-2 text-neutral-600 flex flex-wrap items-center gap-1.5">
                        {t.dueAtMiles != null && (
                          <>
                            Due at <strong className="text-neutral-800">{fmtDistance(t.dueAtMiles, distanceUnit)} {distLabel}</strong>
                            {t.milesToGo != null && (
                              <>
                                {" • "}
                                <span className="text-red-600 font-semibold">
                                  {fmtDistance(Math.abs(t.milesToGo), distanceUnit)} {distLabel} overdue
                                </span>
                              </>
                            )}
                          </>
                        )}
                        {t.dueAtMiles != null && timeAxisDate != null && <> • </>}
                        {overdueFmt && (
                          <span>
                            By{" "}
                            <strong className={overdueFmt.isVeryOverdue ? "text-red-600" : "text-neutral-800"}>
                              {overdueFmt.text}
                            </strong>
                          </span>
                        )}
                      </div>
                    );
                  })()}

                  {t.last?.miles != null && (
                    <div className="text-xs text-neutral-600 mt-1 flex items-center gap-1.5">
                      <span>
                        {/* Task #434: implied anchors lead with "Anchored to <parent>"
                            so customers/advisors aren't told the child service was
                            done on a date when only the parent (e.g. tire replacement)
                            actually happened. */}
                        {t.lastSource === "implied" && t.last?.impliedFromParentName
                          ? `Anchored to ${t.last.impliedFromParentName}`
                          : "Last done"}
                        {" "}at {fmtDistance(t.last.miles, distanceUnit)} {distLabel}
                        {t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}
                      </span>
                      {t.last?.source === "carfax" && (
                        <img src="/badges/carfax.png" alt="CARFAX" className="h-3.5" title="From CARFAX" />
                      )}
                      {(t.last?.source === "protractor" || t.last?.source === "shop") && (
                        shopLogo ? (
                          <img src={shopLogo} alt="Shop" className="h-4" title="From Shop History" />
                        ) : (
                          <img src="/badges/protractor.png" alt="Protractor" className="h-4" title="From Protractor" />
                        )
                      )}
                    </div>
                  )}

                  {t.declined && (
                    <div className="text-xs text-orange-700 mt-1 bg-orange-50 rounded px-2 py-1">
                      Customer declined{(() => {
                        const d = t.declined?.declinedAt ? new Date(t.declined.declinedAt) : null;
                        return d && !isNaN(d.getTime()) ? ` on ${d.toLocaleDateString()}` : "";
                      })()}
                      {t.declined.roNumber ? ` (RO #${t.declined.roNumber})` : ""}
                      {t.declined.mileage && ` at ${fmtDistance(t.declined.mileage, distanceUnit)} ${distLabel}`}
                      {t.declined.reason && ` - ${t.declined.reason}`}
                    </div>
                  )}

                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs underline">Why this is recommended</summary>
                    <div className="mt-2 rounded-lg bg-neutral-50 p-2 text-xs text-neutral-700 space-y-1">
                      <div>
                        <span className="font-medium">{t.usingShopInterval ? "Shop" : (t.source === "common" ? "Recommended" : "OEM")} Interval:</span>{" "}
                        {t.intervalMiles ? `${fmtDistance(t.intervalMiles, distanceUnit)} ${distLabel}` : "—"}
                        {t.intervalMiles && t.intervalMonths ? " / " : ""}
                        {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                      </div>
                      <div>
                        <span className="font-medium inline-flex items-center gap-1">
                          Last done
                          {t.last?.source === "carfax" && <img src="/badges/carfax.png" alt="CARFAX" className="h-3 inline" />}
                          {(t.last?.source === "protractor" || t.last?.source === "shop") && (
                            shopLogo ? (
                              <img src={shopLogo} alt="Shop" className="h-3.5 inline" />
                            ) : (
                              <img src="/badges/protractor.png" alt="Protractor" className="h-3.5 inline" />
                            )
                          )}
                          :
                        </span>{" "}
                        {t.last?.miles != null ? `${fmtDistance(t.last.miles, distanceUnit)} ${distLabel}` : "—"}
                        {t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}
                      </div>
                      <div>
                        <span className="font-medium">Next due:</span>{" "}
                        {t.dueAtMiles != null ? `${fmtDistance(t.dueAtMiles, distanceUnit)} ${distLabel}` : "—"}
                        {t.dueAtDate ? ` or ${t.dueAtDate.toLocaleDateString()}` : ""}
                      </div>
                      {t.bump && t.source !== "protractor" && (
                        <div>
                          <span className="font-medium">DVI:</span> {t.bump === "red" ? "🔴 flagged" : "🟡 caution"}
                        </div>
                      )}
                      {t.source === "protractor" && (
                        <div>
                          <span className="font-medium">Source:</span> Protractor deferred work
                          {t.reason && <> - {t.reason}</>}
                        </div>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Deferred (from Protractor) */}
        {overdueDeferred.length > 0 && (
          <section id={`deferred${idSuffix}`} className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-blue-700 flex items-center gap-2">
                <img src={shopLogo || "/protractor-icon.png"} alt="" className="w-5 h-5 rounded-full object-cover" />
                Deferred
                <span className="text-xs font-semibold rounded-full bg-blue-100 text-blue-700 px-2 py-0.5">{counts.deferred}</span>
              </h2>
              {latestWorkOrderId && activeIntegration === "protractor" && (
                <AddAllDeferredButton 
                  items={overdueDeferred}
                  workOrderGuid={latestWorkOrderId}
                  vin={vin}
                />
              )}
            </div>
            <ul className="space-y-3">
              {overdueDeferred.map((t) => (
                <li key={t.key} className="rounded-xl border border-blue-200 bg-blue-50/30 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <ServiceIcon serviceKey={t.serviceKey} title={t.title} size={22} className="shrink-0 text-neutral-500" />
                        <div className="font-medium">{t.title}</div>
                      </div>
                      {t.notes && t.notes.trim() && (
                        <div className="text-xs italic text-neutral-600 mt-0.5">{t.notes.trim()}</div>
                      )}
                      {t.category === "DVI Finding" && t.bestPracticeBlurb && t.bestPracticeBlurb.trim() && (
                        <div className="text-xs text-neutral-700 mt-0.5 leading-snug">{t.bestPracticeBlurb.trim()}</div>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-neutral-600">
                        {t.category && <span className="rounded-full bg-neutral-100 px-2 py-0.5">{t.category}</span>}
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 border border-blue-300 px-2 py-0.5">
                          <img src={shopLogo || "/protractor-icon.png"} alt="" className="w-3.5 h-3.5 rounded-full object-cover" />
                          <span className="text-blue-700">Deferred</span>
                        </span>
                        {t.recommendedDefault && (
                          <span
                            className="rounded-full bg-blue-600 text-white px-2 py-0.5"
                            title={t.recommendedReason || (t.lifetimeFluidDefault ? "OEM lists this as lifetime fluid; shop recommendation only." : "Shop-recommended service.")}
                          >
                            {t.lifetimeFluidDefault
                              ? <>OEM lifetime fluid · Shop recommendation at {(distanceUnit === "kilometers" ? Math.round(LIFETIME_FLUID_DEFAULT_MILES * 1.60934) : LIFETIME_FLUID_DEFAULT_MILES).toLocaleString()} {distLabel}</>
                              : <>Shop recommendation{t.intervalMiles ? ` · every ${t.intervalMiles.toLocaleString()} ${distLabel}` : ""}</>}
                          </span>
                        )}
                        {t.inspectOnly && (
                          <span
                            className="rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5"
                            title={t.inspectOnlyReason || "OEM only schedules an inspection (not a replacement) for this fluid."}
                          >
                            OEM: Inspect{t.intervalMiles ? ` every ${t.intervalMiles.toLocaleString()} ${distLabel}` : (t.intervalMonths ? ` every ${t.intervalMonths} mo` : "")}
                          </span>
                        )}
                        {t.carfaxMatch && (
                          <CarfaxMatchBadge
                            match={t.carfaxMatch}
                            deferredId={t.protractorDeferredId || t.key}
                            vin={vin}
                            serviceTitle={t.title}
                          />
                        )}
                      </div>
                    </div>
                    {(() => {
                      const opts = getCannedJobOptionsForService(t.serviceKey);
                      return (
                        <AddToROWithHistory
                          vin={vin}
                          serviceTitle={t.title}
                          serviceKey={t.serviceKey}
                          vehicleYear={vehicleYear}
                          vehicleMake={vehicleMake}
                          vehicleModel={vehicleModel}
                          vehicleEngine={vehicleEngine}
                          workOrderGuid={latestWorkOrderId ?? undefined}
                          workOrderId={latestRoNumber ?? undefined}
                          repairOrderId={latestRepairOrderId ?? undefined}
                          cannedJobOptions={opts}
                          integration={activeIntegration ?? "protractor"}
                          showHistoryButton={hasJobLookupFeature}
                          protractorDeferredId={t.protractorDeferredId}
                          matchedDeferred={t.matchedDeferred}
                        />
                      );
                    })()}
                  </div>
                  <IntervalProgressRow
                    task={t}
                    currentMiles={currentMiles}
                    distanceUnit={distanceUnit}
                    status="deferred"
                  />

                  {t.reason && (
                    <div className="text-xs text-blue-700 mt-2 bg-blue-50 rounded px-2 py-1">
                      {t.reason}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Due Soon */}
        <section id={`soon${idSuffix}`} className="space-y-3">
          <h2 className="text-lg font-semibold text-amber-700 flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500" /> Due soon
            <span className="text-xs font-semibold rounded-full bg-amber-100 text-amber-700 px-2 py-0.5">{counts.soon}</span>
          </h2>
          {dueSoonFiltered.length === 0 ? (
            <div className="text-sm text-neutral-500">Nothing due soon.</div>
          ) : (
            <ul className="space-y-3">
              {dueSoonFiltered.map((t) => (
                <li key={t.key} className="rounded-xl border p-3">
                  <div className="flex items-center gap-2">
                    <ServiceIcon serviceKey={t.serviceKey} title={t.title} size={22} className="shrink-0 text-neutral-500" />
                    <div className="font-medium">{t.title}</div>
                  </div>
                  {t.notes && t.notes.trim() && (
                    <div className="text-xs italic text-neutral-600 mt-0.5">{t.notes.trim()}</div>
                  )}
                  {t.category === "DVI Finding" && t.bestPracticeBlurb && t.bestPracticeBlurb.trim() && (
                    <div className="text-xs text-neutral-700 mt-0.5 leading-snug">{t.bestPracticeBlurb.trim()}</div>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-neutral-600">
                    {t.category && <span className="rounded-full bg-neutral-100 px-2 py-0.5">{t.category}</span>}
                    {(() => {
                      // Task #392: same trigger-aware badge as the
                      // overdue list — call out whether time or mileage
                      // pushed the item into Due Soon. Prefer stamped
                      // triage values; recompute only as a fallback.
                      // Task #865: sentence-case pill; trigger axis in tooltip.
                      const trig =
                        (t as any).byMiles !== undefined || (t as any).byTime !== undefined
                          ? { byMiles: (t as any).byMiles ?? null, byTime: (t as any).byTime ?? null }
                          : getProgressTriggers(t, currentMiles, undefined, distanceUnit);
                      const suffix = formatTriggerSuffix(trig.byMiles, trig.byTime, "soon");
                      return (
                        <span
                          className="rounded-full bg-amber-500 text-white px-2 py-0.5 font-medium"
                          title={suffix ? `Due soon${suffix}` : undefined}
                        >
                          Due soon
                        </span>
                      );
                    })()}
                    {t.recommendedDefault && (
                      <span
                        className="rounded-full bg-blue-600 text-white px-2 py-0.5"
                        title={t.recommendedReason || (t.lifetimeFluidDefault ? "OEM lists this as lifetime fluid; shop recommendation only." : "Shop-recommended service.")}
                      >
                        {t.lifetimeFluidDefault
                          ? <>OEM lifetime fluid · Shop recommendation at {(distanceUnit === "kilometers" ? Math.round(LIFETIME_FLUID_DEFAULT_MILES * 1.60934) : LIFETIME_FLUID_DEFAULT_MILES).toLocaleString()} {distLabel}</>
                          : <>Shop recommendation{t.intervalMiles ? ` · every ${t.intervalMiles.toLocaleString()} ${distLabel}` : ""}</>}
                      </span>
                    )}
                    {t.inspectOnly && (
                      <span
                        className="rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5"
                        title={t.inspectOnlyReason || "OEM only schedules an inspection (not a replacement) for this fluid."}
                      >
                        OEM: Inspect{t.intervalMiles ? ` every ${t.intervalMiles.toLocaleString()} ${distLabel}` : (t.intervalMonths ? ` every ${t.intervalMonths} mo` : "")}
                      </span>
                    )}
                    {t.reason && !t.last?.miles && !t.recommendedDefault && (
                      <span className="rounded-full bg-neutral-200 text-neutral-600 px-2 py-0.5 italic">{t.reason}</span>
                    )}
                    {(t.intervalMiles || t.intervalMonths) && (
                      <span className={`rounded-full border px-2 py-0.5 inline-flex items-center gap-1 ${t.usingShopInterval ? "bg-green-50 border-green-300" : ""}`}>
                        {t.usingShopInterval && shopLogo ? (
                          <img src={shopLogo} alt="Shop" className="h-3 inline" />
                        ) : null}
                        {t.usingShopInterval ? "Shop" : (t.source === "common" ? "Recommended" : "OEM")}: {t.intervalMiles ? `${fmtDistance(t.intervalMiles, distanceUnit)} ${distLabel}` : ""}
                        {t.intervalMiles && t.intervalMonths ? " / " : ""}
                        {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                      </span>
                    )}
                    {t.engineRiskFlag && (
                      <span
                        className="rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5 inline-flex items-center gap-1"
                        title={t.engineRiskReason ?? "Engine flagged for accelerated oil wear."}
                      >
                        ⚠ Engine flagged — long oil interval
                      </span>
                    )}
                    {t.recommendedDefault && t.lifetimeFluidDefault && (
                      <span
                        className="rounded-full bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5"
                        title={t.recommendedReason ?? undefined}
                      >
                        Shop recommendation
                      </span>
                    )}
                    {t.bump === "yellow" && t.source !== "protractor" && (
                      <span className={`rounded-full text-white px-2 py-0.5 ${t.dviSource === "autovitals" ? "bg-teal-600" : t.dviSource === "tekmetric" ? "bg-orange-500" : "bg-amber-600"}`}>
                        {t.dviSource === "autovitals" ? "AutoVitals 🟡" : t.dviSource === "tekmetric" ? "Tekmetric DVI 🟡" : "DVI 🟡"}
                      </span>
                    )}
                    {t.source === "protractor" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 border border-blue-200 px-2 py-0.5">
                            <img 
                              src={shopLogo || "/protractor-icon.png"} 
                              alt="Shop" 
                              className="w-4 h-4 rounded-full object-cover"
                            />
                            <span className="text-blue-700 text-xs">Deferred</span>
                          </span>
                        )}
                    {t.usingShopInterval && <span className="rounded-full bg-green-600 text-white px-2 py-0.5">Shop</span>}
                    {t.declined && (
                      <span className="rounded-full bg-orange-100 text-orange-700 border border-orange-300 px-2 py-0.5 font-medium">
                        Previously declined
                      </span>
                    )}
                    {(() => {
                      const opts = getCannedJobOptionsForService(t.serviceKey);
                      return (
                        <AddToROWithHistory
                          vin={vin}
                          serviceTitle={t.title}
                          serviceKey={t.serviceKey}
                          vehicleYear={vehicleYear}
                          vehicleMake={vehicleMake}
                          vehicleModel={vehicleModel}
                          vehicleEngine={vehicleEngine}
                          workOrderGuid={latestWorkOrderId ?? undefined}
                          workOrderId={latestRoNumber ?? undefined}
                          repairOrderId={latestRepairOrderId ?? undefined}
                          cannedJobOptions={opts}
                          integration={activeIntegration ?? "protractor"}
                          showHistoryButton={hasJobLookupFeature}
                          protractorDeferredId={t.protractorDeferredId}
                          matchedDeferred={t.matchedDeferred}
                        />
                      );
                    })()}
                  </div>

                  <IntervalProgressRow
                    task={t}
                    currentMiles={currentMiles}
                    distanceUnit={distanceUnit}
                    status="soon"
                  />

                  <div className="text-sm mt-2">
                    {t.source === "protractor" && t.reason && (
                      <div className="text-neutral-600">{t.reason}</div>
                    )}
                    {t.milesToGo != null && t.milesToGo > 0 && (
                      <>
                        In ~<strong>{fmtDistance(t.milesToGo, distanceUnit)}</strong> {distLabel}
                      </>
                    )}
                    {t.milesToGo != null && t.daysToGo != null && <> • </>}
                    {t.daysToGo != null && t.daysToGo > 0 && (
                      <>
                        In ~<strong>{t.daysToGo}</strong> days
                        {" "}
                        <span className="text-indigo-500 italic">
                          (est. {new Date(Date.now() + t.daysToGo * 86400000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})
                        </span>
                      </>
                    )}
                  </div>

                  {t.last?.miles != null && (
                    <div className="text-xs text-neutral-600 mt-1 flex items-center gap-1.5">
                      <span>
                        {/* Task #434: implied anchors lead with "Anchored to <parent>"
                            so customers/advisors aren't told the child service was
                            done on a date when only the parent (e.g. tire replacement)
                            actually happened. */}
                        {t.lastSource === "implied" && t.last?.impliedFromParentName
                          ? `Anchored to ${t.last.impliedFromParentName}`
                          : "Last done"}
                        {" "}at {fmtDistance(t.last.miles, distanceUnit)} {distLabel}
                        {t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}
                      </span>
                      {t.last?.source === "carfax" && (
                        <img src="/badges/carfax.png" alt="CARFAX" className="h-3.5" title="From CARFAX" />
                      )}
                      {(t.last?.source === "protractor" || t.last?.source === "shop") && (
                        shopLogo ? (
                          <img src={shopLogo} alt="Shop" className="h-4" title="From Shop History" />
                        ) : (
                          <img src="/badges/protractor.png" alt="Protractor" className="h-4" title="From Protractor" />
                        )
                      )}
                    </div>
                  )}

                  {t.declined && (
                    <div className="text-xs text-orange-700 mt-1 bg-orange-50 rounded px-2 py-1">
                      Customer declined{(() => {
                        const d = t.declined?.declinedAt ? new Date(t.declined.declinedAt) : null;
                        return d && !isNaN(d.getTime()) ? ` on ${d.toLocaleDateString()}` : "";
                      })()}
                      {t.declined.roNumber ? ` (RO #${t.declined.roNumber})` : ""}
                      {t.declined.mileage && ` at ${fmtDistance(t.declined.mileage, distanceUnit)} ${distLabel}`}
                      {t.declined.reason && ` - ${t.declined.reason}`}
                    </div>
                  )}

                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs underline">Why this is recommended</summary>
                    <div className="mt-2 rounded-lg bg-neutral-50 p-2 text-xs text-neutral-700 space-y-1">
                      <div>
                        <span className="font-medium">{t.usingShopInterval ? "Shop" : (t.source === "common" ? "Recommended" : "OEM")} Interval:</span>{" "}
                        {t.intervalMiles ? `${fmtDistance(t.intervalMiles, distanceUnit)} ${distLabel}` : "—"}
                        {t.intervalMiles && t.intervalMonths ? " / " : ""}
                        {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                      </div>
                      <div>
                        <span className="font-medium inline-flex items-center gap-1">
                          Last done
                          {t.last?.source === "carfax" && <img src="/badges/carfax.png" alt="CARFAX" className="h-3 inline" />}
                          {(t.last?.source === "protractor" || t.last?.source === "shop") && (
                            shopLogo ? (
                              <img src={shopLogo} alt="Shop" className="h-3.5 inline" />
                            ) : (
                              <img src="/badges/protractor.png" alt="Protractor" className="h-3.5 inline" />
                            )
                          )}
                          :
                        </span>{" "}
                        {t.last?.miles != null ? `${fmtDistance(t.last.miles, distanceUnit)} ${distLabel}` : "—"}
                        {t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}
                      </div>
                      <div>
                        <span className="font-medium">Next due:</span>{" "}
                        {t.dueAtMiles != null ? `${fmtDistance(t.dueAtMiles, distanceUnit)} ${distLabel}` : "—"}
                        {t.dueAtDate ? ` or ${t.dueAtDate.toLocaleDateString()}` : ""}
                      </div>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Additional Services */}
        {allComplimentary.length > 0 && (
          <section id={`complimentary${idSuffix}`} className="space-y-3">
            <h2 className="text-lg font-semibold text-blue-600 flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-blue-500" /> Additional services
              <span className="text-xs font-semibold rounded-full bg-blue-100 text-blue-700 px-2 py-0.5">{counts.complimentary}</span>
            </h2>
            <ul className="space-y-3">
              {allComplimentary.map((t) => (
                <li key={t.key} className="rounded-xl border border-blue-200 bg-blue-50/30 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <ServiceIcon serviceKey={t.serviceKey} title={t.title} size={22} className="shrink-0 text-neutral-500" />
                        <div className="font-medium">{t.title}</div>
                      </div>
                      {t.notes && t.notes.trim() && (
                        <div className="text-xs italic text-neutral-600 mt-0.5">{t.notes.trim()}</div>
                      )}
                      {t.category === "DVI Finding" && t.bestPracticeBlurb && t.bestPracticeBlurb.trim() && (
                        <div className="text-xs text-neutral-700 mt-0.5 leading-snug">{t.bestPracticeBlurb.trim()}</div>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-neutral-600">
                        {t.category && <span className="rounded-full bg-neutral-100 px-2 py-0.5">{t.category}</span>}
                        <span className="rounded-full bg-blue-500 text-white px-2 py-0.5 font-medium">Complimentary</span>
                        {t.recommendedDefault && (
                          <span
                            className="rounded-full bg-blue-600 text-white px-2 py-0.5"
                            title={t.recommendedReason || (t.lifetimeFluidDefault ? "OEM lists this as lifetime fluid; shop recommendation only." : "Shop-recommended service.")}
                          >
                            {t.lifetimeFluidDefault
                              ? <>OEM lifetime fluid · Shop recommendation at {(distanceUnit === "kilometers" ? Math.round(LIFETIME_FLUID_DEFAULT_MILES * 1.60934) : LIFETIME_FLUID_DEFAULT_MILES).toLocaleString()} {distLabel}</>
                              : <>Shop recommendation{t.intervalMiles ? ` · every ${t.intervalMiles.toLocaleString()} ${distLabel}` : ""}</>}
                          </span>
                        )}
                        {t.inspectOnly && (
                          <span
                            className="rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5"
                            title={t.inspectOnlyReason || "OEM only schedules an inspection (not a replacement) for this fluid."}
                          >
                            OEM: Inspect{t.intervalMiles ? ` every ${t.intervalMiles.toLocaleString()} ${distLabel}` : (t.intervalMonths ? ` every ${t.intervalMonths} mo` : "")}
                          </span>
                        )}
                        {t.reason && !t.last?.miles && !t.recommendedDefault && (
                          <span className="rounded-full bg-neutral-200 text-neutral-600 px-2 py-0.5 italic">{t.reason}</span>
                        )}
                        {(t.intervalMiles || t.intervalMonths) && (
                          <span className={`rounded-full border px-2 py-0.5 inline-flex items-center gap-1 ${t.usingShopInterval ? "bg-green-50 border-green-300" : ""}`}>
                            {t.usingShopInterval && shopLogo ? (
                              <img src={shopLogo} alt="Shop" className="h-3 inline" />
                            ) : null}
                            {t.usingShopInterval ? "Shop" : (t.source === "common" ? "Recommended" : "OEM")}: {t.intervalMiles ? `${fmtDistance(t.intervalMiles, distanceUnit)} ${distLabel}` : ""}
                            {t.intervalMiles && t.intervalMonths ? " / " : ""}
                            {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                          </span>
                        )}
                      </div>
                    </div>
                    {(() => {
                      const opts = getCannedJobOptionsForService(t.serviceKey);
                      return (
                        <AddToROWithHistory
                          vin={vin}
                          serviceTitle={t.title}
                          serviceKey={t.serviceKey}
                          vehicleYear={vehicleYear}
                          vehicleMake={vehicleMake}
                          vehicleModel={vehicleModel}
                          vehicleEngine={vehicleEngine}
                          workOrderGuid={latestWorkOrderId ?? undefined}
                          workOrderId={latestRoNumber ?? undefined}
                          repairOrderId={latestRepairOrderId ?? undefined}
                          cannedJobOptions={opts}
                          integration={activeIntegration ?? "protractor"}
                          showHistoryButton={hasJobLookupFeature}
                          protractorDeferredId={t.protractorDeferredId}
                          matchedDeferred={t.matchedDeferred}
                        />
                      );
                    })()}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Upcoming */}
        <section id={`upcoming${idSuffix}`} className="space-y-3">
          <h2 className="text-lg font-semibold text-emerald-700 flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-600" /> Upcoming
            <span className="text-xs font-semibold rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5">{counts.upcoming}</span>
          </h2>
          {buckets.upcoming.length === 0 ? (
            <div className="text-sm text-neutral-500">No upcoming items.</div>
          ) : (
            <ul className="space-y-3">
              {buckets.upcoming.map((t) => (
                <li key={t.key} className="rounded-xl border p-3">
                  <div className="flex items-center gap-2">
                    <ServiceIcon serviceKey={t.serviceKey} title={t.title} size={22} className="shrink-0 text-neutral-500" />
                    <div className="font-medium">{t.title}</div>
                  </div>
                  {t.notes && t.notes.trim() && (
                    <div className="text-xs italic text-neutral-600 mt-0.5">{t.notes.trim()}</div>
                  )}
                  {t.category === "DVI Finding" && t.bestPracticeBlurb && t.bestPracticeBlurb.trim() && (
                    <div className="text-xs text-neutral-700 mt-0.5 leading-snug">{t.bestPracticeBlurb.trim()}</div>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-neutral-600">
                    {t.category && <span className="rounded-full bg-neutral-100 px-2 py-0.5">{t.category}</span>}
                    <span className="rounded-full bg-emerald-600 text-white px-2 py-0.5 font-medium">Upcoming</span>
                    {t.recommendedDefault && (
                      <span
                        className="rounded-full bg-blue-600 text-white px-2 py-0.5"
                        title={t.recommendedReason || (t.lifetimeFluidDefault ? "OEM lists this as lifetime fluid; shop recommendation only." : "Shop-recommended service.")}
                      >
                        {t.lifetimeFluidDefault
                          ? <>OEM lifetime fluid · Shop recommendation at {(distanceUnit === "kilometers" ? Math.round(LIFETIME_FLUID_DEFAULT_MILES * 1.60934) : LIFETIME_FLUID_DEFAULT_MILES).toLocaleString()} {distLabel}</>
                          : <>Shop recommendation{t.intervalMiles ? ` · every ${t.intervalMiles.toLocaleString()} ${distLabel}` : ""}</>}
                      </span>
                    )}
                    {t.inspectOnly && (
                      <span
                        className="rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5"
                        title={t.inspectOnlyReason || "OEM only schedules an inspection (not a replacement) for this fluid."}
                      >
                        OEM: Inspect{t.intervalMiles ? ` every ${t.intervalMiles.toLocaleString()} ${distLabel}` : (t.intervalMonths ? ` every ${t.intervalMonths} mo` : "")}
                      </span>
                    )}
                    {(t.intervalMiles || t.intervalMonths) && (
                      <span className={`rounded-full border px-2 py-0.5 inline-flex items-center gap-1 ${t.usingShopInterval ? "bg-green-50 border-green-300" : ""}`}>
                        {t.usingShopInterval && shopLogo ? (
                          <img src={shopLogo} alt="Shop" className="h-3 inline" />
                        ) : null}
                        {t.usingShopInterval ? "Shop" : (t.source === "common" ? "Recommended" : "OEM")}: {t.intervalMiles ? `${fmtDistance(t.intervalMiles, distanceUnit)} ${distLabel}` : ""}
                        {t.intervalMiles && t.intervalMonths ? " / " : ""}
                        {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                      </span>
                    )}
                    {t.engineRiskFlag && (
                      <span
                        className="rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5 inline-flex items-center gap-1"
                        title={t.engineRiskReason ?? "Engine flagged for accelerated oil wear."}
                      >
                        ⚠ Engine flagged — long oil interval
                      </span>
                    )}
                    {t.recommendedDefault && t.lifetimeFluidDefault && (
                      <span
                        className="rounded-full bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5"
                        title={t.recommendedReason ?? undefined}
                      >
                        Shop recommendation
                      </span>
                    )}
                    {t.declined && (
                      <span className="rounded-full bg-orange-100 text-orange-700 border border-orange-300 px-2 py-0.5 font-medium">
                        Previously declined
                      </span>
                    )}
                    {(() => {
                      const opts = getCannedJobOptionsForService(t.serviceKey);
                      return (
                        <AddToROWithHistory
                          vin={vin}
                          serviceTitle={t.title}
                          serviceKey={t.serviceKey}
                          vehicleYear={vehicleYear}
                          vehicleMake={vehicleMake}
                          vehicleModel={vehicleModel}
                          vehicleEngine={vehicleEngine}
                          workOrderGuid={latestWorkOrderId ?? undefined}
                          workOrderId={latestRoNumber ?? undefined}
                          repairOrderId={latestRepairOrderId ?? undefined}
                          cannedJobOptions={opts}
                          integration={activeIntegration ?? "protractor"}
                          showHistoryButton={hasJobLookupFeature}
                          protractorDeferredId={t.protractorDeferredId}
                          matchedDeferred={t.matchedDeferred}
                        />
                      );
                    })()}
                  </div>

                  <IntervalProgressRow
                    task={t}
                    currentMiles={currentMiles}
                    distanceUnit={distanceUnit}
                    status="upcoming"
                  />

                  <div className="text-sm mt-2">
                    {t.dueAtMiles != null && (
                      <>
                        Next at ~<strong>{fmtDistance(t.dueAtMiles, distanceUnit)}</strong> {distLabel}
                      </>
                    )}
                    {t.dueAtMiles != null && (t.dueAtDate != null || (t.daysToGo != null && t.daysToGo > 0)) && <> • </>}
                    {t.dueAtDate != null ? (
                      <>
                        By ~<strong>{t.dueAtDate.toLocaleDateString()}</strong>
                      </>
                    ) : t.daysToGo != null && t.daysToGo > 0 ? (
                      <span className="text-indigo-500 italic">
                        Est. {new Date(Date.now() + t.daysToGo * 86400000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      </span>
                    ) : null}
                  </div>

                  {t.declined && (
                    <div className="text-xs text-orange-700 mt-1 bg-orange-50 rounded px-2 py-1">
                      Customer declined{(() => {
                        const d = t.declined?.declinedAt ? new Date(t.declined.declinedAt) : null;
                        return d && !isNaN(d.getTime()) ? ` on ${d.toLocaleDateString()}` : "";
                      })()}
                      {t.declined.roNumber ? ` (RO #${t.declined.roNumber})` : ""}
                      {t.declined.mileage && ` at ${fmtDistance(t.declined.mileage, distanceUnit)} ${distLabel}`}
                      {t.declined.reason && ` - ${t.declined.reason}`}
                    </div>
                  )}

                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs underline">Show details</summary>
                    <div className="mt-2 rounded-lg bg-neutral-50 p-2 text-xs text-neutral-700 space-y-1">
                      <div>
                        <span className="font-medium">{t.usingShopInterval ? "Shop" : (t.source === "common" ? "Recommended" : "OEM")} Interval:</span>{" "}
                        {t.intervalMiles ? `${fmtDistance(t.intervalMiles, distanceUnit)} ${distLabel}` : "—"}
                        {t.intervalMiles && t.intervalMonths ? " / " : ""}
                        {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                      </div>
                      {t.last?.miles != null && (
                        <div>
                          <span className="font-medium">Last done (CARFAX):</span>{" "}
                          {fmtDistance(t.last.miles, distanceUnit)} {distLabel}{t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}
                        </div>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>
              </>
            );
          };

          if (!planVariants || planVariants.length === 0) {
            return renderPlanSections(buckets, "");
          }
          const suffixFor = (v: { id: string; kind: string }) =>
            v.kind === "shop" ? "" : `-${v.id.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
          // BG LPP eligibility banner: provider tabs created from the
          // "bg-lpp" template show whether THIS vehicle can enter the
          // plan (entry mileage band + max vehicle age). Resolved from
          // the live shop provider config, so cached plan rows need no
          // shape change.
          const bannerFor = (v: { id: string; kind: string }) => {
            if (v.kind !== "provider") return null;
            const provider = chemicalProviders.find((p) => `provider:${p.id}` === v.id);
            if (provider?.templateId !== "bg-lpp") return null;
            const elig = evaluateBgLppEligibility(vehicle?.year ?? null, currentMiles);
            const styles =
              elig.status === "eligible"
                ? "bg-green-50 border-green-200 text-green-800"
                : elig.status === "ineligible"
                  ? "bg-red-50 border-red-200 text-red-800"
                  : "bg-gray-50 border-gray-200 text-gray-700";
            const badge =
              elig.status === "eligible"
                ? `Eligible — ${elig.planLabel}`
                : elig.status === "ineligible"
                  ? "Not eligible"
                  : "Eligibility unknown";
            return (
              <div className={`mb-4 px-4 py-3 border rounded-xl ${styles}`}>
                <p className="text-sm font-semibold">
                  BG Lifetime Protection Plan: {badge}
                </p>
                <p className="text-xs mt-0.5">{elig.detail}</p>
              </div>
            );
          };
          // Task #804: protection-plan enrollment banner (status +
          // enroll/un-enroll control) on every provider tab.
          const enrollmentBannerFor = (v: { id: string; kind: string }) => {
            if (v.kind !== "provider") return null;
            const info = protectionPlanByVariantId.get(v.id);
            if (!info) return null;
            const enrolled = info.status === "enrolled" || info.status === "at_risk";
            const styles =
              info.status === "at_risk"
                ? "bg-red-50 border-red-200"
                : info.status === "enrolled"
                  ? "bg-green-50 border-green-200"
                  : info.status === "eligible"
                    ? "bg-blue-50 border-blue-200"
                    : "bg-neutral-50 border-neutral-200";
            return (
              <div className={`mb-4 px-4 py-3 border rounded-xl ${styles}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-neutral-800">
                      {info.status === "at_risk" && (
                        <span className="text-red-700">
                          ⚠ Protection plan at risk of lapsing
                        </span>
                      )}
                      {info.status === "enrolled" && (
                        <span className="text-green-800">
                          Enrolled in {info.providerName} protection plan
                        </span>
                      )}
                      {info.status === "eligible" && (
                        <span className="text-blue-800">
                          Eligible for {info.providerName} protection plan
                        </span>
                      )}
                      {info.status === "none" && (
                        <span className="text-neutral-700">
                          Not enrolled in {info.providerName} protection plan
                        </span>
                      )}
                    </p>
                    <p className="text-xs mt-0.5 text-neutral-600">
                      {info.status === "at_risk" && (
                        <>
                          Enrolled{info.enrolledAt ? ` ${info.enrolledAt.toLocaleDateString()}` : ""} — required service{info.overdueRequired.length === 1 ? "" : "s"} overdue:{" "}
                          {info.overdueRequired.map((s) => s.title).join(", ")}. Staying on schedule keeps the plan active.
                        </>
                      )}
                      {info.status === "enrolled" && (
                        <>
                          Enrolled{info.enrolledAt ? ` on ${info.enrolledAt.toLocaleDateString()}` : ""}
                          {info.enrolledBy ? ` by ${info.enrolledBy}` : ""} — all required services on schedule.
                        </>
                      )}
                      {info.status === "eligible" && (
                        <>
                          {info.providerName}-branded service{info.eligibilityMatches.length === 1 ? "" : "s"} found in history:{" "}
                          {info.eligibilityMatches.slice(0, 3).join(", ")}
                          {info.eligibilityMatches.length > 3 ? ", …" : ""}. Consider enrolling this vehicle.
                        </>
                      )}
                      {info.status === "none" && (
                        <>No qualifying {info.providerName} services found in this vehicle&apos;s history yet.</>
                      )}
                    </p>
                  </div>
                  <ProtectionPlanControls
                    vin={vin}
                    providerId={info.providerId}
                    providerName={info.providerName}
                    enrolled={enrolled}
                  />
                </div>
              </div>
            );
          };
          const tabBadgeFor = (v: { id: string; kind: string }): TabBadge | null => {
            const info = protectionPlanByVariantId.get(v.id);
            if (!info) return null;
            if (info.status === "at_risk") return { text: "At risk", tone: "red" };
            if (info.status === "enrolled") return { text: "Enrolled", tone: "green" };
            if (info.status === "eligible") return { text: "Eligible", tone: "blue" };
            return null;
          };
          return (
            <PlanTabs
              tabs={planVariants.map(v => ({ id: v.id, label: v.label, badge: tabBadgeFor(v) }))}
              defaultTabId={enrolledVariantId ?? "shop"}
              panels={planVariants.map(v => (
                <>
                  {enrollmentBannerFor(v)}
                  {bannerFor(v)}
                  {renderPlanSections(v.buckets, suffixFor(v))}
                </>
              ))}
            />
          );
        })()}

        {/* Debug */}
        <details className="mt-6">
          <summary className="cursor-pointer">Debug (inputs)</summary>
          <pre className="mt-2 text-xs bg-gray-50 p-3 rounded overflow-auto max-h-72">
            {JSON.stringify(
              {
                currentMiles,
                mpdBlended,
                carfaxOk: (carfax as any).ok ?? false,
                dviOk: (dvi as any).ok ?? false,
                oemCount: oemItems.length,
              },
              null,
              2
            )}
          </pre>
        </details>
      </div>
      </>
    </PlanTrialGate>
  );
}
