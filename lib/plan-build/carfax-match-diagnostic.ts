/**
 * Task #655: pure, dependency-light helper that explains, per CARFAX entry,
 * how the VHI matcher classified it — which canonical service keys it
 * resolved to (`toKeyFromFreeText`), which interval clocks it implicitly
 * resets (`findImpliesResetMatches`), whether it was deduped against the
 * shop's own service history, and whether it anchored anything at all.
 *
 * This powers two things:
 *   1. The operator-facing per-vehicle diagnostic surfaced under
 *      `/platform-admin` so support can see exactly why a CARFAX service is
 *      (or isn't) being credited as "done".
 *   2. The unmatched-description logging in the plan-build route, which
 *      feeds `recordUnmatchedCarfaxDescription` so wording gaps are visible
 *      without staring at a single vehicle.
 *
 * Kept pure (no I/O, no env) and intentionally mirrors the matching +
 * dedup logic that `triage()` itself applies to CARFAX records and the
 * `serviceCategories` rollup, so the diagnostic stays faithful to what the
 * planner actually does.
 */

import { toKeyFromFreeText, findImpliesResetMatches } from "@/lib/service-keys";
import {
  isMatchingHistory,
  parseCarfaxDate,
  type ShopServiceHistory,
} from "@/lib/plan-build/triage";
import { normalizeCarfaxDescription } from "@/lib/carfax-match-log";

export interface CarfaxMatchDiagnosticEntry {
  /** Where the entry came from: a per-record line or the category rollup. */
  source: "record" | "category";
  /** Original description text (record description / category serviceName). */
  description: string;
  /** Parsed date as ISO (yyyy-mm-dd) when available, else null. */
  date: string | null;
  /** Odometer reading when present, else null. */
  miles: number | null;
  /** Canonical service keys this entry resolved to (may be empty). */
  matchedKeys: string[];
  /** Child keys whose interval clock this entry implicitly resets. */
  impliedChildKeys: string[];
  /**
   * True when at least one matched key also has a shop-history record at the
   * same miles/date (within tolerance), so triage would credit the shop's
   * own record rather than the CARFAX one. Not a problem — just context.
   */
  dedupedAgainstShop: boolean;
  /**
   * Categories outside the [vehicleYear .. today] window are ignored by
   * triage. Surfaced so an operator understands why an in-window-looking
   * record didn't anchor. Always false for per-record entries (triage does
   * not range-filter those).
   */
  outOfDateRange: boolean;
  /** True when the entry resolved to no key and no implied reset. */
  unmatched: boolean;
  /** True when at least one matched key came from an operator override. */
  matchedViaOverride: boolean;
}

export interface CarfaxMatchDiagnostics {
  entries: CarfaxMatchDiagnosticEntry[];
  summary: {
    totalRecords: number;
    totalCategories: number;
    matched: number;
    impliedOnly: number;
    unmatched: number;
  };
}

function toIso(d: Date | null): string | null {
  if (!d) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function buildCarfaxMatchDiagnostics(args: {
  carfaxRecords?: Array<{
    date?: string | null;
    odometer?: number | null;
    description?: string | null;
  }>;
  carfaxCategories?: Array<{
    serviceName: string;
    date?: string | null;
    odometer?: number | null;
  }>;
  shopServiceHistory?: ShopServiceHistory[];
  vehicleYear?: number | null;
  today?: Date;
  /** Operator overrides (normalizedDescription → [serviceKey]); see triage. */
  carfaxKeyOverrides?: Map<string, string[]> | null;
}): CarfaxMatchDiagnostics {
  const {
    carfaxRecords = [],
    carfaxCategories = [],
    shopServiceHistory = [],
    vehicleYear = null,
    today = new Date(),
    carfaxKeyOverrides = null,
  } = args;

  // Mirror triage's category date window.
  const earliestDate = vehicleYear
    ? new Date(vehicleYear, 0, 1)
    : new Date(today.getTime() - 20 * 365 * 24 * 60 * 60 * 1000);

  // Index shop history by canonical key, mirroring triage.
  const shopHistoryByKey = new Map<string, Array<{ miles: number | null; date: Date | null }>>();
  for (const sh of shopServiceHistory || []) {
    const keys = toKeyFromFreeText(sh.serviceName || "");
    for (const k of keys) {
      if (!shopHistoryByKey.has(k)) shopHistoryByKey.set(k, []);
      shopHistoryByKey.get(k)!.push({ miles: sh.mileage, date: sh.date });
    }
  }

  const entries: CarfaxMatchDiagnosticEntry[] = [];

  const classify = (
    source: "record" | "category",
    description: string,
    date: Date | null,
    miles: number | null,
    outOfDateRange: boolean,
  ): void => {
    const dictKeys = toKeyFromFreeText(description);
    const overrideKeys =
      carfaxKeyOverrides?.get(normalizeCarfaxDescription(description)) || [];
    const matchedKeys = Array.from(new Set([...dictKeys, ...overrideKeys]));
    const matchedViaOverride = overrideKeys.some((k) => !dictKeys.includes(k));
    const impliedChildKeys = Array.from(
      new Set(findImpliesResetMatches(description).map((m) => m.childKey)),
    );
    const dedupedAgainstShop = matchedKeys.some((k) =>
      (shopHistoryByKey.get(k) || []).some((sr) => isMatchingHistory(sr, { miles, date })),
    );
    entries.push({
      source,
      description,
      date: toIso(date),
      miles,
      matchedKeys,
      impliedChildKeys,
      dedupedAgainstShop,
      outOfDateRange,
      unmatched: matchedKeys.length === 0 && impliedChildKeys.length === 0,
      matchedViaOverride,
    });
  };

  for (const r of carfaxRecords || []) {
    const description = String(r?.description ?? "").trim();
    if (!description) continue;
    const date = parseCarfaxDate(r?.date ?? null);
    const miles = typeof r?.odometer === "number" && r.odometer > 0 ? r.odometer : null;
    classify("record", description, date, miles, false);
  }

  for (const c of carfaxCategories || []) {
    const description = String(c?.serviceName ?? "").trim();
    if (!description) continue;
    const date = parseCarfaxDate(c?.date ?? null);
    const miles = typeof c?.odometer === "number" && c.odometer > 0 ? c.odometer : null;
    const outOfDateRange = !!date && (date < earliestDate || date > today);
    classify("category", description, date, miles, outOfDateRange);
  }

  const summary = {
    totalRecords: entries.filter((e) => e.source === "record").length,
    totalCategories: entries.filter((e) => e.source === "category").length,
    matched: entries.filter((e) => e.matchedKeys.length > 0).length,
    impliedOnly: entries.filter(
      (e) => e.matchedKeys.length === 0 && e.impliedChildKeys.length > 0,
    ).length,
    unmatched: entries.filter((e) => e.unmatched).length,
  };

  return { entries, summary };
}
