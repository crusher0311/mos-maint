/**
 * Task #1146 — pure evaluation + summary logic for the shop-level
 * "Missed Opportunities" report over recently closed repair orders.
 *
 * Reuses the Task #1145 RO-line ↔ VHI matcher
 * (`lib/estimate-assist/vhi-audit-match.ts`), so the semantics stay in
 * lockstep with the Estimate Assist audit:
 *   - Declined jobs count as quoted — callers pass EVERY service-job title
 *     on the ticket, declined ones included.
 *   - Inspection-only VHI items are never flagged as missed.
 *
 * This module is deliberately free of `server-only` / DB imports so it can
 * be unit-tested directly under tsx (see tests/missed-opportunities.smoke.ts).
 * The server/data side (querying normalized stores, cached-plan lookups,
 * report caching) lives in `lib/missed-opportunities-service.ts`.
 */

import {
  findMissingVhiItems,
  type MissingVhiItem,
  type VhiComparisonItem,
} from "@/lib/estimate-assist/vhi-audit-match";

export type { MissingVhiItem, VhiComparisonItem };

/** One closed RO's evaluation result. */
export interface MissedOpportunityRo {
  /** Normalized work-order id (PG uuid). */
  workOrderId: string;
  /** Display RO number. */
  workOrderNumber: string;
  /** ISO date the RO closed (closedDate, else completedDate). */
  closedDate: string | null;
  vin: string | null;
  /** "2019 Toyota Camry" style label, when the vehicle is known. */
  vehicle: string | null;
  /** Service advisor / writer name when the SMS carries one. */
  advisorName: string | null;
  /** Job titles that were on the ticket (quoted OR declined). */
  lineTitleCount: number;
  /** True when the RO was actually compared against a VHI plan. */
  evaluated: boolean;
  /** Why the RO was not evaluated ("No VIN", "No cached VHI plan", ...). */
  skipReason: string | null;
  /** Due/overdue VHI items absent from the ticket (evaluated ROs only). */
  missedItems: MissingVhiItem[];
}

export interface TopMissedService {
  title: string;
  serviceKey: string | null;
  count: number;
}

export interface MissedOpportunitySummary {
  /** Closed ROs found in the window (before any skips). */
  totalClosedRos: number;
  /** ROs actually compared against a cached VHI plan. */
  evaluatedRos: number;
  /** ROs skipped (no VIN, no plan data, no line items). */
  notEvaluatedRos: number;
  /** Evaluated ROs with at least one missed item. */
  rosWithMissedItems: number;
  /** Percent of EVALUATED ROs with missed items (0-100, one decimal). */
  missedPct: number;
  /** Total missed items across all evaluated ROs. */
  totalMissedItems: number;
  /** Most frequently missed services, descending. */
  topMissedServices: TopMissedService[];
}

/**
 * Flatten a cached plan's overdue + dueSoon buckets into the matcher's
 * comparison shape. `upcoming` is deliberately excluded — only items that
 * were actually due/due-soon count as missed opportunities.
 */
export function planItemsFromBuckets(
  buckets:
    | {
        overdue?: ReadonlyArray<unknown> | null;
        dueSoon?: ReadonlyArray<unknown> | null;
      }
    | null
    | undefined,
): VhiComparisonItem[] {
  if (!buckets) return [];
  const out: VhiComparisonItem[] = [];
  for (const it of buckets.overdue || []) {
    out.push({ ...(it as any), status: "overdue" as const });
  }
  for (const it of buckets.dueSoon || []) {
    out.push({ ...(it as any), status: "due_soon" as const });
  }
  return out;
}

/**
 * Evaluate one closed RO's line titles against the vehicle's VHI plan
 * items. Thin delegation to the shared matcher so this report can never
 * drift from the Estimate Assist audit's quoted/declined/inspection rules.
 */
export function evaluateRoLines(
  roLineTitles: Array<string | null | undefined>,
  planItems: VhiComparisonItem[],
): MissingVhiItem[] {
  return findMissingVhiItems(roLineTitles, planItems);
}

/** Round to one decimal, guarding divide-by-zero. */
function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Summary-stat math over the per-RO rows. Missed percentage is computed
 * over EVALUATED ROs only — skipped ROs (no VIN / no plan) are reported
 * separately so they can't dilute the rate.
 */
export function summarizeMissedOpportunities(
  rows: MissedOpportunityRo[],
  topN = 10,
): MissedOpportunitySummary {
  let evaluated = 0;
  let withMissed = 0;
  let totalMissed = 0;
  const tally = new Map<string, TopMissedService>();

  for (const row of rows || []) {
    if (!row.evaluated) continue;
    evaluated += 1;
    if (row.missedItems.length > 0) withMissed += 1;
    for (const item of row.missedItems) {
      totalMissed += 1;
      // Group by canonical service key when present, else by title so
      // differently-keyed one-offs still aggregate sensibly.
      const groupKey = item.serviceKey || item.title.toLowerCase();
      const existing = tally.get(groupKey);
      if (existing) existing.count += 1;
      else tally.set(groupKey, { title: item.title, serviceKey: item.serviceKey, count: 1 });
    }
  }

  const topMissedServices = Array.from(tally.values())
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, topN);

  return {
    totalClosedRos: rows?.length || 0,
    evaluatedRos: evaluated,
    notEvaluatedRos: (rows?.length || 0) - evaluated,
    rosWithMissedItems: withMissed,
    missedPct: pct(withMissed, evaluated),
    totalMissedItems: totalMissed,
    topMissedServices,
  };
}

/** Allowed report windows (days). */
export const MISSED_OPP_WINDOWS = [7, 30, 90] as const;
export type MissedOppWindow = (typeof MISSED_OPP_WINDOWS)[number];

export function normalizeWindowDays(raw: unknown): MissedOppWindow {
  const n = Number(raw);
  return (MISSED_OPP_WINDOWS as readonly number[]).includes(n)
    ? (n as MissedOppWindow)
    : 30;
}

/** The whole cached/served report payload. */
export interface MissedOpportunityReport {
  shopId: number;
  windowDays: MissedOppWindow;
  generatedAt: string; // ISO
  summary: MissedOpportunitySummary;
  /** ROs with at least one missed item, newest close first. */
  rows: MissedOpportunityRo[];
  /** Skipped ROs ("not evaluated"), newest close first. */
  notEvaluated: Array<
    Pick<
      MissedOpportunityRo,
      "workOrderId" | "workOrderNumber" | "closedDate" | "vin" | "vehicle" | "skipReason"
    >
  >;
  /** True when the window held more closed ROs than the evaluation cap. */
  truncated: boolean;
}
