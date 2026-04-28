/**
 * Pure plan-build triage logic, lifted out of `app/api/plan-build/route.ts`
 * so it can be exercised end-to-end from regression smoke tests without
 * pulling in the route's Mongo / DataOne / DVI integration dependencies.
 *
 * The route itself just feeds these helpers the data it has already
 * gathered (DataOne OEM items, Carfax, shop history, DVI findings, …) and
 * then converts the resulting buckets into the cache shape via
 * `convertToCache`.
 *
 * Keep this file pure: no I/O, no `process.env`, no Next.js types — just
 * deterministic transforms over the inputs the route hands in.
 */

import {
  SERVICE_KEY_DISPLAY_NAMES,
  toKeyFromName,
  toKeyFromFreeText,
  parseServiceAction,
  isLifetimeFluidItem,
  LIFETIME_FLUID_DEFAULT_MILES,
  type ServiceAction,
} from "@/lib/service-keys";
import type { ProtractorDeferredWork } from "@/lib/integrations/protractor";
import type { TriagedItemCache } from "@/lib/plan-cache";

export const DEFAULT_SOON_MILES = 1000;
export const DEFAULT_SOON_DAYS = 30;

export function parseCarfaxDate(d?: string | null): Date | null {
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

export function addMonths(d: Date, months: number) {
  const dt = new Date(d);
  dt.setMonth(dt.getMonth() + months);
  return dt;
}

/**
 * Returns the best available odometer reading for the last time a service
 * was performed. Order of preference:
 *   1. The recorded `last.miles` if present and non-zero.
 *   2. An estimate derived from `last.date` + the vehicle's average miles/day.
 *   3. null (no signal — caller should treat as "never done").
 *
 * Why this exists: shop history rows from Tekmetric/Protractor frequently
 * carry a date but no odometer. Without this fallback the planner would
 * compute the next due as `intervalMiles` (the very first interval) and
 * report a freshly-completed service as "31,859 mi over".
 */
export function computeAnchorMiles(
  last: { miles?: number | null; date?: Date | null } | null | undefined,
  currentMiles: number | null | undefined,
  milesPerDay: number | null | undefined,
  today: Date,
): number | null {
  if (last?.miles != null && last.miles > 0) return last.miles;
  if (
    last?.date &&
    currentMiles != null &&
    milesPerDay != null &&
    milesPerDay > 0
  ) {
    const daysSince = Math.max(
      0,
      Math.floor((today.getTime() - last.date.getTime()) / 86400000),
    );
    return Math.max(0, currentMiles - daysSince * milesPerDay);
  }
  return null;
}

type CarfaxRecordWithParsed = {
  date: Date | null;
  miles: number | null;
  description?: string;
};

export function fillCarfaxMileageGaps(
  records: Array<{ date?: string; odometer?: number; description?: string }>,
  opts: { today: Date; currentMiles: number | null; defaultRate: number | null }
): CarfaxRecordWithParsed[] {
  const parsed: CarfaxRecordWithParsed[] = records.map(r => ({
    date: parseCarfaxDate(r.date ?? null),
    miles: typeof r.odometer === "number" && r.odometer > 0 ? r.odometer : null,
    description: r.description,
  }));

  parsed.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.getTime() - b.date.getTime();
  });

  const knownPoints: Array<{ date: Date; miles: number; index: number }> = [];
  for (let i = 0; i < parsed.length; i++) {
    const rec = parsed[i];
    if (rec.date && rec.miles != null) {
      knownPoints.push({ date: rec.date, miles: rec.miles, index: i });
    }
  }

  if (opts.currentMiles != null) {
    knownPoints.push({ date: opts.today, miles: opts.currentMiles, index: -1 });
    knownPoints.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  for (let i = 0; i < parsed.length; i++) {
    const rec = parsed[i];
    if (rec.miles != null || !rec.date) continue;

    const recTime = rec.date.getTime();
    let beforeIdx = -1;
    let afterIdx = -1;

    for (let j = 0; j < knownPoints.length; j++) {
      const kp = knownPoints[j];
      if (kp.date.getTime() <= recTime) {
        beforeIdx = j;
      } else if (afterIdx === -1) {
        afterIdx = j;
        break;
      }
    }

    const before = beforeIdx >= 0 ? knownPoints[beforeIdx] : null;
    const after = afterIdx >= 0 ? knownPoints[afterIdx] : null;

    if (before && after) {
      const totalDays = (after.date.getTime() - before.date.getTime()) / (1000 * 60 * 60 * 24);
      const daysSinceBefore = (recTime - before.date.getTime()) / (1000 * 60 * 60 * 24);
      if (totalDays > 0) {
        const ratio = daysSinceBefore / totalDays;
        const estimated = Math.round(before.miles + ratio * (after.miles - before.miles));
        rec.miles = Math.max(before.miles, Math.min(after.miles, estimated));
      } else {
        rec.miles = before.miles;
      }
    } else if (before) {
      if (beforeIdx > 0) {
        const prevPoint = knownPoints[beforeIdx - 1];
        const days = (before.date.getTime() - prevPoint.date.getTime()) / (1000 * 60 * 60 * 24);
        if (days > 0) {
          const rate = (before.miles - prevPoint.miles) / days;
          const daysSince = (recTime - before.date.getTime()) / (1000 * 60 * 60 * 24);
          rec.miles = Math.round(before.miles + rate * daysSince);
        }
      } else if (opts.defaultRate != null) {
        const daysSince = (recTime - before.date.getTime()) / (1000 * 60 * 60 * 24);
        rec.miles = Math.round(before.miles + opts.defaultRate * daysSince);
      }
    } else if (after) {
      if (afterIdx < knownPoints.length - 1) {
        const nextPoint = knownPoints[afterIdx + 1];
        const days = (nextPoint.date.getTime() - after.date.getTime()) / (1000 * 60 * 60 * 24);
        if (days > 0) {
          const rate = (nextPoint.miles - after.miles) / days;
          const daysBefore = (after.date.getTime() - recTime) / (1000 * 60 * 60 * 24);
          rec.miles = Math.round(after.miles - rate * daysBefore);
        }
      } else if (opts.defaultRate != null) {
        const daysBefore = (after.date.getTime() - recTime) / (1000 * 60 * 60 * 24);
        rec.miles = Math.round(after.miles - opts.defaultRate * daysBefore);
      }
    }

    if (rec.miles != null && rec.miles < 0) rec.miles = null;
  }

  return parsed;
}

const MILEAGE_TOLERANCE = 10;
const DATE_TOLERANCE_DAYS = 3;

export function isMatchingHistory(
  shopRecord: { miles?: number | null; date?: Date | null },
  carfaxRecord: { miles?: number | null; date?: Date | null }
): boolean {
  if (shopRecord.miles == null || carfaxRecord.miles == null) return false;
  if (shopRecord.date == null || carfaxRecord.date == null) return false;
  const milesDiff = Math.abs(shopRecord.miles - carfaxRecord.miles);
  const daysDiff = Math.abs(shopRecord.date.getTime() - carfaxRecord.date.getTime()) / (1000 * 60 * 60 * 24);
  return milesDiff <= MILEAGE_TOLERANCE && daysDiff <= DATE_TOLERANCE_DAYS;
}

export interface OEMItem {
  maintenance_id?: string | number;
  name?: string;
  category?: string;
  miles?: number | null;
  months?: number | null;
  notes?: string | null;
  intervals?: Array<{ units?: string | null; value?: number | null }>;
}

/**
 * Maps a raw maintenance row (either DataOne's `MaintenanceItem` shape with
 * `maintenance_*` fields, or an already-flattened `{ name, category, ... }`
 * shape) into the `OEMItem` shape that `triage()` consumes.
 *
 * Centralizing this here keeps `app/api/plan-build/route.ts` and the smoke
 * tests in tests/plan-build-task-165.smoke.ts in lockstep — a silent change
 * to the mapping (e.g. dropping `maintenance_notes`) will trip the test.
 */
export function toOEMItem(item: any): OEMItem {
  return {
    maintenance_id: item?.maintenance_id,
    name: item?.maintenance_name ?? item?.name,
    category: item?.maintenance_category ?? item?.category,
    miles: item?.miles ?? null,
    months: item?.months ?? null,
    notes: item?.maintenance_notes ?? item?.notes ?? null,
    intervals: Array.isArray(item?.intervals)
      ? item.intervals.map((iv: any) => ({ units: iv?.units ?? null, value: iv?.value ?? null }))
      : [],
  };
}

export type LastDone = { miles?: number | null; date?: Date | null; source?: "carfax" | "protractor" | "shop" };

export type MatchedDeferred = { id: string; title: string };

export type DeclinedServiceEntry = {
  serviceKey: string;
  serviceName: string;
  mileage?: number | null;
  reason?: string | null;
  declinedAt: string;
};

export type ShopIntervalOverride = {
  useShop: boolean;
  excluded?: boolean;
  miles: number | null;
  months: number | null;
};

export type ShopServiceHistory = {
  serviceName: string;
  mileage: number | null;
  date: Date | null;
};

export interface TriagedItem {
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
  source?: "oem" | "dvi" | "protractor" | "common";
  dviSource?: "autoflow" | "autovitals" | "tekmetric";
  reason?: string;
  declined?: DeclinedServiceEntry | null;
  usingShopInterval?: boolean;
  protractorDeferredId?: string;
  matchedDeferred?: MatchedDeferred;
  /** Verb extracted from the source row ("inspect", "replace", ...). */
  action?: ServiceAction | null;
  /** Free-text note carried from DataOne (e.g. "If equipped with dipstick"). */
  notes?: string | null;
  /** True when interval was synthesized from the lifetime-fluid default. */
  recommendedDefault?: boolean;
  /** Human-readable rationale shown when recommendedDefault is true. */
  recommendedReason?: string | null;
}

export interface Buckets {
  overdue: TriagedItem[];
  dueSoon: TriagedItem[];
  upcoming: TriagedItem[];
}

export function triage({
  oemItems,
  carfaxRecords,
  shopServiceHistory = [],
  currentMiles,
  today = new Date(),
  dviFindings,
  protractorDeferredWork = [],
  declinedServices = [],
  soonMiles = DEFAULT_SOON_MILES,
  soonDays = DEFAULT_SOON_DAYS,
  milesPerDay = null,
  shopIntervals = {},
  intervalApplyMode = "always",
  vehicleYear = null,
  vehicleTransType = null,
}: {
  oemItems: OEMItem[];
  carfaxRecords: Array<{ date?: string; odometer?: number; description?: string }>;
  shopServiceHistory?: ShopServiceHistory[];
  currentMiles: number | null;
  today?: Date;
  dviFindings: Array<{ name?: string; status?: string | number; source?: string }>;
  protractorDeferredWork?: ProtractorDeferredWork[];
  declinedServices?: DeclinedServiceEntry[];
  soonMiles?: number;
  soonDays?: number;
  milesPerDay?: number | null;
  shopIntervals?: Record<string, ShopIntervalOverride>;
  intervalApplyMode?: string;
  vehicleYear?: number | null;
  vehicleTransType?: string | null;
}): Buckets {
  const earliestDate = vehicleYear
    ? new Date(vehicleYear, 0, 1)
    : new Date(today.getTime() - 20 * 365 * 24 * 60 * 60 * 1000);

  const enrichedRecords = fillCarfaxMileageGaps(carfaxRecords || [], {
    today,
    currentMiles,
    defaultRate: milesPerDay,
  });

  const shopHistoryByKey = new Map<string, { miles: number | null; date: Date | null }[]>();
  for (const sh of shopServiceHistory || []) {
    const keys = toKeyFromFreeText(sh.serviceName || "");
    for (const k of keys) {
      if (!shopHistoryByKey.has(k)) shopHistoryByKey.set(k, []);
      shopHistoryByKey.get(k)!.push({ miles: sh.mileage, date: sh.date });
    }
  }

  const lastMap = new Map<string, LastDone>();

  for (const sh of shopServiceHistory || []) {
    const keys = toKeyFromFreeText(sh.serviceName || "");
    for (const k of keys) {
      const prev = lastMap.get(k);
      const cand: LastDone = { miles: sh.mileage, date: sh.date, source: "shop" };
      const prevScore = prev?.date ? prev.date.getTime() : -Infinity;
      const candScore = sh.date ? sh.date.getTime() : -Infinity;
      if (!prev || candScore > prevScore) lastMap.set(k, cand);
    }
  }

  for (const r of enrichedRecords) {
    const date = r.date;
    const miles = r.miles;
    const desc = String(r.description || "").trim();
    const keys = toKeyFromFreeText(desc);
    for (const k of keys) {
      const prev = lastMap.get(k);
      const shopRecords = shopHistoryByKey.get(k) || [];
      const matchesShop = shopRecords.some(sr => isMatchingHistory(sr, { miles, date }));
      if (matchesShop) continue;
      const cand: LastDone = { miles, date, source: "carfax" };
      const prevScore = prev?.date ? prev.date.getTime() : -Infinity;
      const candScore = date ? date.getTime() : -Infinity;
      if (!prev || candScore > prevScore) lastMap.set(k, cand);
    }
  }

  const dviMap = new Map<string, { status: "red" | "yellow"; name: string; dviSource?: "autoflow" | "autovitals" | "tekmetric" }>();
  const unmappedDviFindings: Array<{ status: "red" | "yellow"; name: string; dviSource: "autoflow" | "autovitals" | "tekmetric" }> = [];
  for (const it of dviFindings || []) {
    const rawName = String(it.name || "");
    if (!rawName) continue;
    const key = toKeyFromName(rawName);
    const s = String(it.status ?? "");
    const dviSource = (it.source === "autovitals" ? "autovitals" : it.source === "tekmetric" ? "tekmetric" : "autoflow") as "autoflow" | "autovitals" | "tekmetric";
    const mappedStatus = s === "0" ? "red" : s === "1" ? "yellow" : null;
    if (!mappedStatus) continue;
    if (key) {
      if (mappedStatus === "red") dviMap.set(key, { status: "red", name: rawName, dviSource });
      else if (dviMap.get(key)?.status !== "red") dviMap.set(key, { status: "yellow", name: rawName, dviSource });
    } else {
      unmappedDviFindings.push({ status: mappedStatus, name: rawName, dviSource });
    }
  }

  const declinedMap = new Map<string, DeclinedServiceEntry>();
  for (const d of declinedServices || []) {
    if (d.serviceKey) declinedMap.set(d.serviceKey, d);
  }

  const triaged: TriagedItem[] = [];
  const usedDviKeys = new Set<string>();
  // Tracks plain serviceKeys consumed by *any* source (OEM, DVI, …). Used
  // for cross-source suppression (e.g. don't re-add a generic "battery"
  // common item if the OEM list already covers it).
  const usedServiceKeys = new Set<string>();
  // Tracks `${serviceKey}::${action}` so an OEM "Inspect …" row and the
  // matching "Replace …" row can coexist, while still de-duplicating two
  // rows with the same verb on the same service key.
  const usedOemServiceActionKeys = new Set<string>();

  const deferredByServiceKey = new Map<string, MatchedDeferred>();
  const seenDeferredTitles = new Set<string>();
  const deferredServiceKeysUsedByOem = new Set<string>();

  for (const dw of protractorDeferredWork || []) {
    const title = dw.Title || dw.ServicePackageHeader?.Title || dw.Code || dw.Description || dw.ServicePackageHeader?.Description || "Deferred Service";
    const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seenDeferredTitles.has(normalizedTitle)) continue;
    seenDeferredTitles.add(normalizedTitle);
    const serviceKey = toKeyFromName(title);
    if (serviceKey && !deferredByServiceKey.has(serviceKey)) {
      deferredByServiceKey.set(serviceKey, { id: dw.ID, title });
    }
  }

  const resolvedTransType = vehicleTransType?.toLowerCase().trim() || null;
  const isAutomatic = resolvedTransType ? (resolvedTransType.includes("auto") || resolvedTransType.includes("cvt")) : null;
  const isManual = resolvedTransType ? resolvedTransType.includes("manual") : null;

  for (const o of oemItems) {
    const mappedKey = toKeyFromName(o.name || "");
    const serviceKey = mappedKey || `misc_${o.maintenance_id}`;
    const action = parseServiceAction(o.name || "");

    if (isAutomatic !== null) {
      if (serviceKey === "trans_manual" && isAutomatic) continue;
      if (serviceKey === "trans_auto" && isManual) continue;
    }

    const matchedDeferred = deferredByServiceKey.get(serviceKey);
    if (matchedDeferred) deferredServiceKeysUsedByOem.add(serviceKey);
    // We can have both an "Inspect …" row AND a "Replace …" row that map to
    // the same service key (e.g. trans_auto). Allow them to coexist instead
    // of dropping the second one — they are presented to the customer as
    // distinct line items. Use a separate action-qualified set for this
    // intra-OEM dedupe so the cross-source `usedServiceKeys` set still
    // suppresses generic common-maintenance items further down.
    const dedupeKey = `${serviceKey}::${action ?? "any"}`;
    if (usedOemServiceActionKeys.has(dedupeKey) && !serviceKey.startsWith("misc_")) continue;
    usedOemServiceActionKeys.add(dedupeKey);
    usedServiceKeys.add(serviceKey);

    const uniqueKey = `${serviceKey}_${action ?? "any"}_${o.maintenance_id}`;
    const last = lastMap.get(serviceKey) ?? null;

    const shopOverride = shopIntervals[serviceKey];
    if (shopOverride?.excluded) {
      continue;
    }
    const lastPerformedAtShop = last?.source === 'shop';
    const usingShopInterval = shopOverride?.useShop === true && (intervalApplyMode === 'always' || lastPerformedAtShop);
    let intervalMiles = usingShopInterval && shopOverride.miles != null ? shopOverride.miles : (o.miles ?? null);
    let intervalMonths = usingShopInterval && shopOverride.months != null ? shopOverride.months : (o.months ?? null);

    // Lifetime-fluid handling: when the OE source has no actionable
    // interval but lists this fluid as "lifetime" / "fill for life" /
    // "no scheduled service" (or just omits the interval entirely on a
    // fluid we know about), surface a recommended-default interval
    // (LIFETIME_FLUID_DEFAULT_MILES) so it shows up on the plan as a
    // shop recommendation rather than disappearing silently. Only do this
    // for "Replace"/"Flush" rows — we do not want to fabricate a service
    // out of an "Inspect transmission fluid" row.
    let recommendedDefault = false;
    let recommendedReason: string | null = null;
    const isReplacementRow = action === null || action === "replace" || action === "flush" || action === "service" || action === "drain";
    if (
      !usingShopInterval &&
      isReplacementRow &&
      mappedKey &&
      isLifetimeFluidItem({
        serviceKey: mappedKey,
        name: o.name,
        notes: o.notes,
        miles: o.miles ?? null,
        months: o.months ?? null,
        intervals: o.intervals ?? [],
      })
    ) {
      intervalMiles = LIFETIME_FLUID_DEFAULT_MILES;
      intervalMonths = null;
      recommendedDefault = true;
      recommendedReason = `OEM lists this fluid as lifetime / fill for life. Recommended at ${LIFETIME_FLUID_DEFAULT_MILES.toLocaleString()} mi.`;
    }

    if (dviMap.has(serviceKey)) usedDviKeys.add(serviceKey);

    let dueAtMiles: number | null = null;
    let dueAtDate: Date | null = null;
    let neverDone = false;

    if (intervalMiles && intervalMiles > 0) {
      // When shop history captured the date but not the odometer (common with
      // Tekmetric/Protractor entries that lack milesIn), fall back to a
      // mileage estimate derived from the recorded date and the vehicle's
      // average miles/day. Otherwise we'd treat the service as "never done"
      // for the mileage axis and falsely report it as overdue.
      const anchorMiles = computeAnchorMiles(last, currentMiles, milesPerDay, today);
      if (anchorMiles != null) {
        dueAtMiles = anchorMiles + intervalMiles;
      } else if (currentMiles != null) {
        dueAtMiles = intervalMiles;
        neverDone = true;
      }
    }

    if (intervalMonths && intervalMonths > 0) {
      if (last?.date) dueAtDate = addMonths(last.date, intervalMonths);
      else if (!neverDone) dueAtDate = addMonths(today, intervalMonths);
    }

    const milesToGo = currentMiles != null && dueAtMiles != null ? dueAtMiles - currentMiles : null;

    if (milesToGo != null && milesPerDay != null && milesPerDay > 0) {
      const daysUntilDue = Math.round(milesToGo / milesPerDay);
      const mileageBasedDate = new Date(today.getTime() + daysUntilDue * 24 * 60 * 60 * 1000);
      if (dueAtDate == null || mileageBasedDate < dueAtDate) {
        dueAtDate = mileageBasedDate;
      }
    }

    if (dueAtDate && dueAtDate < earliestDate) dueAtDate = null;

    const daysToGo = dueAtDate != null ? Math.ceil((dueAtDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : null;

    const dviInfo = dviMap.get(serviceKey);
    const declinedInfo = declinedMap.get(serviceKey) || null;
    // Always prefer the original DataOne row as the title so the verb
    // (Inspect / Replace / Flush / Rotate / ...) is preserved end-to-end.
    // Fall back to the canonical display name only when the source row had
    // no usable name at all (e.g. miscellaneous items).
    const displayTitle = o.name || SERVICE_KEY_DISPLAY_NAMES[serviceKey] || "Maintenance Item";

    let combinedReason: string | undefined;
    if (recommendedDefault) {
      combinedReason = recommendedReason ?? undefined;
    } else if (neverDone) {
      combinedReason = "No record of this service being performed.";
    }

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
      reason: combinedReason,
      dviSource: dviInfo?.dviSource,
      declined: declinedInfo,
      usingShopInterval,
      matchedDeferred,
      action: action ?? null,
      notes: o.notes ?? null,
      recommendedDefault: recommendedDefault || undefined,
      recommendedReason: recommendedReason ?? undefined,
    });
  }

  for (const [dviKey, dviInfo] of dviMap) {
    if (usedDviKeys.has(dviKey)) continue;
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
    });
  }

  const COMMON_MAINTENANCE: Array<{
    serviceKey: string;
    title: string;
    category: string;
    miles: number | null;
    months: number | null;
  }> = [
    { serviceKey: "wheel_alignment", title: "Wheel Alignment", category: "Tires and Wheels", miles: 12000, months: 12 },
    { serviceKey: "power_steering", title: "Power Steering Fluid", category: "Drivetrain", miles: 50000, months: null },
    { serviceKey: "front_shocks", title: "Front Shocks / Struts", category: "Suspension", miles: 75000, months: null },
    { serviceKey: "rear_shocks", title: "Rear Shocks / Struts", category: "Suspension", miles: 75000, months: null },
    { serviceKey: "wiper_blades", title: "Wiper Blades", category: "General", miles: null, months: 12 },
    { serviceKey: "battery", title: "Battery", category: "Electrical", miles: null, months: 48 },
    { serviceKey: "fuel_system", title: "Fuel System Cleaning", category: "Engine", miles: 60000, months: null },
    { serviceKey: "coolant_hoses", title: "Coolant Hoses", category: "Coolant System", miles: 60000, months: null },
  ];

  for (const cm of COMMON_MAINTENANCE) {
    if (usedServiceKeys.has(cm.serviceKey)) continue;

    const shopOverride = shopIntervals[cm.serviceKey];
    if (shopOverride?.excluded) continue;

    usedServiceKeys.add(cm.serviceKey);
    const last = lastMap.get(cm.serviceKey) ?? null;
    const lastPerformedAtShop = last?.source === 'shop';
    const usingShopInterval = shopOverride?.useShop === true && (intervalApplyMode === 'always' || lastPerformedAtShop);
    const intervalMiles = usingShopInterval && shopOverride.miles != null ? shopOverride.miles : cm.miles;
    const intervalMonths = usingShopInterval && shopOverride.months != null ? shopOverride.months : cm.months;

    let dueAtMiles: number | null = null;
    let dueAtDate: Date | null = null;
    let neverDone = false;

    if (intervalMiles && intervalMiles > 0) {
      const anchorMiles = computeAnchorMiles(last, currentMiles, milesPerDay, today);
      if (anchorMiles != null) {
        dueAtMiles = anchorMiles + intervalMiles;
      } else if (currentMiles != null) {
        dueAtMiles = intervalMiles;
        neverDone = true;
      }
    }

    if (intervalMonths && intervalMonths > 0) {
      if (last?.date) dueAtDate = addMonths(last.date, intervalMonths);
      else if (!neverDone) dueAtDate = addMonths(today, intervalMonths);
    }

    const milesToGo = currentMiles != null && dueAtMiles != null ? dueAtMiles - currentMiles : null;

    if (milesToGo != null && milesPerDay != null && milesPerDay > 0) {
      const daysUntilDue = Math.round(milesToGo / milesPerDay);
      const mileageBasedDate = new Date(today.getTime() + daysUntilDue * 24 * 60 * 60 * 1000);
      if (dueAtDate == null || mileageBasedDate < dueAtDate) {
        dueAtDate = mileageBasedDate;
      }
    }

    if (dueAtDate && dueAtDate < earliestDate) dueAtDate = null;

    if (dueAtMiles == null && dueAtDate == null) continue;

    const daysToGo = dueAtDate != null ? Math.ceil((dueAtDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : null;

    const declinedInfo = declinedMap.get(cm.serviceKey) || null;
    const matchedDeferred = deferredByServiceKey.get(cm.serviceKey) || null;
    if (matchedDeferred) deferredServiceKeysUsedByOem.add(cm.serviceKey);

    triaged.push({
      key: `common_${cm.serviceKey}`,
      serviceKey: cm.serviceKey,
      title: cm.title,
      category: cm.category,
      intervalMiles,
      intervalMonths,
      last,
      dueAtMiles,
      dueAtDate,
      milesToGo,
      daysToGo,
      bump: null,
      source: "common",
      reason: neverDone ? "No record of this service being performed." : undefined,
      usingShopInterval,
      declined: declinedInfo,
      matchedDeferred: matchedDeferred || undefined,
    });
  }

  for (const dw of protractorDeferredWork || []) {
    const title = dw.Title || dw.ServicePackageHeader?.Title || dw.Code || dw.Description || dw.ServicePackageHeader?.Description || "Deferred Service";
    const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!seenDeferredTitles.has(normalizedTitle)) continue;
    seenDeferredTitles.delete(normalizedTitle);

    const protractorServiceKey = toKeyFromName(title) || `protractor_${dw.ID}`;
    if (deferredServiceKeysUsedByOem.has(protractorServiceKey)) continue;

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
      bump: "red",
      source: "protractor",
      reason: dw.Reason || undefined,
      protractorDeferredId: dw.ID || dw.ServiceItemID,
    });
  }

  const overdue: TriagedItem[] = [];
  const dueSoon: TriagedItem[] = [];
  const upcoming: TriagedItem[] = [];

  for (const t of triaged) {
    const mOver = t.milesToGo != null && t.milesToGo <= 0;
    const dOver = t.daysToGo != null && t.daysToGo <= 0;
    const mSoon = t.milesToGo != null && t.milesToGo > 0 && t.milesToGo <= soonMiles;
    const dSoon = t.daysToGo != null && t.daysToGo > 0 && t.daysToGo <= soonDays;

    if (t.bump === "red") { overdue.push(t); continue; }
    if (t.bump === "yellow") {
      if (!(mOver || dOver)) dueSoon.push(t);
      else overdue.push(t);
      continue;
    }

    if (mOver || dOver) overdue.push(t);
    else if (mSoon || dSoon) dueSoon.push(t);
    else upcoming.push(t);
  }

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

  return { overdue, dueSoon, upcoming };
}

export function convertToCache(item: TriagedItem): TriagedItemCache {
  return {
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
    } : undefined,
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
    declined: item.declined,
    action: item.action ?? null,
    notes: item.notes ?? null,
    recommendedDefault: item.recommendedDefault ?? false,
    recommendedReason: item.recommendedReason ?? null,
  };
}
