/**
 * Task #1146 — pure evaluation + summary logic for the shop-level
 * "Missed Opportunities" report over recently closed repair orders.
 *
 * Reuses the Task #1145 RO-line ↔ VHI matcher
 * (`lib/estimate-assist/vhi-audit-match.ts`), so the semantics stay in
 * lockstep with the Estimate Assist audit:
 *   - Declined jobs remain opportunities under their own outcome rather than
 *     being collapsed into either performed or absent work.
 *   - Inspection-only VHI items are never flagged as missed.
 *
 * This module is deliberately free of `server-only` / DB imports so it can
 * be unit-tested directly under tsx (see tests/missed-opportunities.smoke.ts).
 * The server/data side (querying normalized stores, cached-plan lookups,
 * report caching) lives in `lib/missed-opportunities-service.ts`.
 */

import {
  canonicalServiceKeysFromTitle,
  canonicalServiceKeyForItem,
  findMissingVhiItems,
  isInspectOnlyVhiItem,
  ticketTitleMatchesVhiItem,
  type MissingVhiItem,
  type VhiComparisonItem,
} from "@/lib/estimate-assist/vhi-audit-match";
import {
  classifyTicketJobStatus,
  normalizeTicketJobAmount,
  sumTicketJobAmounts,
  type MissedOpportunityTicketJob,
} from "@/lib/missed-opportunity-ticket-details";

export type { MissingVhiItem, VhiComparisonItem };
export {
  classifyTicketJobStatus,
  formatTicketJobAmount,
  normalizeTicketJobAmount,
  sumTicketJobAmounts,
  type MissedOpportunityTicketJob,
  type TicketJobDisplayGroup,
} from "@/lib/missed-opportunity-ticket-details";

// v6 records Tekmetric advisor/disposition/price evidence. Invalidate older
// saved reports so corrected reingestion is visible immediately.
export const MISSED_OPPORTUNITY_REPORT_VERSION = 6;

export type RecommendationSource = "vhi" | "dvi" | "both";
export type RecommendationOutcome =
  | "invoiced_performed"
  | "deferred_declined"
  | "not_quoted";

export interface MissedOpportunityRecommendation extends MissingVhiItem {
  source: RecommendationSource;
  dviSeverity: "red" | "yellow" | null;
  dviSource: VhiComparisonItem["dviSource"] | null;
  outcome: RecommendationOutcome;
  /** Exact recorded ticket-job dollars; null means the amount was unavailable. */
  recordedPrice: string | null;
}

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
  /**
   * Ordered ticket contents. Null means a legacy cached report did not
   * include ticket details; an empty array means a refreshed report found no
   * displayable jobs.
   */
  ticketJobs: MissedOpportunityTicketJob[] | null;
  /** True when the RO was actually compared against a VHI plan. */
  evaluated: boolean;
  /** Why the RO was not evaluated ("No VIN", "No cached VHI plan", ...). */
  skipReason: string | null;
  /** Due/overdue recommendations deferred or absent from the ticket. */
  missedItems: MissingVhiItem[];
  /** One outcome per canonical due recommendation. */
  recommendations: MissedOpportunityRecommendation[];
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
  /** Evaluated ROs with at least one deferred or not-quoted opportunity. */
  rosWithMissedItems: number;
  /** Percent of EVALUATED ROs with missed items (0-100, one decimal). */
  missedPct: number;
  /** Total missed items across all evaluated ROs. */
  totalMissedItems: number;
  /** Most frequently missed services, descending. */
  topMissedServices: TopMissedService[];
  totalRecommendations: number;
  recommendationsBySource: Record<RecommendationSource, RecommendationRollup>;
  recommendationsByOutcome: Record<RecommendationOutcome, RecommendationRollup>;
}

export interface RecommendationRollup {
  count: number;
  /** Exact sum of available recorded prices. */
  recordedDollarSubtotal: string;
  unavailableCount: number;
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

function planItemSourceFlags(item: VhiComparisonItem): {
  hasVhi: boolean;
  hasDvi: boolean;
} {
  return {
    hasVhi: item.source !== "dvi",
    // `bump` is also used for ordinary VHI urgency styling. Only explicit
    // provenance can establish that an inspection contributed this item.
    hasDvi: item.source === "dvi" || item.dviSource != null,
  };
}

function recommendationSource(hasVhi: boolean, hasDvi: boolean): RecommendationSource {
  return hasVhi && hasDvi ? "both" : hasDvi ? "dvi" : "vhi";
}

function outcomeRank(group: ReturnType<typeof classifyTicketJobStatus>): number {
  if (group === "approved_performed") return 2;
  if (group === "deferred_declined") return 1;
  return 0;
}

/**
 * Evaluate due plan recommendations against ticket jobs. Plan rows sharing a
 * canonical service collapse to one recommendation; DVI + VHI provenance is
 * retained as `both`. A performed match takes precedence over a deferred one.
 */
export function evaluateMissedOpportunityRecommendations(
  ticketJobs: ReadonlyArray<MissedOpportunityTicketJob>,
  planItems: ReadonlyArray<VhiComparisonItem>,
): MissedOpportunityRecommendation[] {
  const deduped = new Map<
    string,
    {
      item: VhiComparisonItem;
      hasVhi: boolean;
      hasDvi: boolean;
      dviSeverity: "red" | "yellow" | null;
      dviSource: VhiComparisonItem["dviSource"] | null;
    }
  >();
  for (const item of planItems || []) {
    if (!String(item?.title || "").trim() || isInspectOnlyVhiItem(item)) continue;
    const key = canonicalServiceKeyForItem(item);
    const flags = planItemSourceFlags(item);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, {
        item,
        ...flags,
        dviSeverity: flags.hasDvi ? item.bump ?? null : null,
        dviSource: flags.hasDvi ? item.dviSource ?? null : null,
      });
      continue;
    }
    existing.hasVhi ||= flags.hasVhi;
    existing.hasDvi ||= flags.hasDvi;
    if (
      flags.hasDvi &&
      (item.bump === "red" || (item.bump === "yellow" && !existing.dviSeverity))
    ) {
      existing.dviSeverity = item.bump;
    }
    if (flags.hasDvi) existing.dviSource ||= item.dviSource ?? null;
    // Prefer the VHI row's interval/due metadata when a separate DVI-only row
    // overlaps it. Keep the more urgent bucket when both are equivalent.
    if (
      existing.item.source === "dvi" && item.source !== "dvi" ||
      existing.item.status === "due_soon" && item.status === "overdue"
    ) {
      existing.item = item;
    }
  }

  const recommendations = Array.from(deduped.values());
  const matchedJobs = recommendations.map(() => [] as MissedOpportunityTicketJob[]);
  // Assign every ticket job to at most one recommendation so one package can
  // never duplicate recorded dollars across overlapping recommendation rows.
  for (const job of ticketJobs || []) {
    const candidates = recommendations
      .map(({ item }, index) => ({ item, index }))
      .filter(({ item }) => ticketTitleMatchesVhiItem(job.title, item));
    if (candidates.length === 0) continue;
    if (candidates.length === 1) {
      matchedJobs[candidates[0].index].push(job);
      continue;
    }
    const jobKeys = new Set(canonicalServiceKeysFromTitle(job.title));
    const scored = candidates.map((candidate) => {
      const itemKeys = new Set(canonicalServiceKeysFromTitle(candidate.item.title));
      if (
        candidate.item.serviceKey &&
        !candidate.item.serviceKey.startsWith("misc_")
      ) {
        itemKeys.add(candidate.item.serviceKey);
      }
      return {
        ...candidate,
        score: Array.from(jobKeys).some((key) => itemKeys.has(key)) ? 2 : 1,
      };
    });
    const best = Math.max(...scored.map(({ score }) => score));
    const winners = scored.filter(({ score }) => score === best);
    if (winners.length === 1) matchedJobs[winners[0].index].push(job);
  }

  return recommendations.map(
    ({ item, hasVhi, hasDvi, dviSeverity, dviSource }, index) => {
    const matches = matchedJobs[index];
    let matched: MissedOpportunityTicketJob | undefined;
    for (const job of matches) {
      const jobRank = outcomeRank(classifyTicketJobStatus(job.recordedStatus));
      const matchedRank = matched
        ? outcomeRank(classifyTicketJobStatus(matched.recordedStatus))
        : -1;
      if (
        !matched ||
        jobRank > matchedRank ||
        (jobRank === matchedRank &&
          normalizeTicketJobAmount(matched.totalPrice) == null &&
          normalizeTicketJobAmount(job.totalPrice) != null)
      ) {
        matched = job;
      }
    }
    const group = matched ? classifyTicketJobStatus(matched.recordedStatus) : "other";
    const outcome: RecommendationOutcome =
      group === "approved_performed"
        ? "invoiced_performed"
        : group === "deferred_declined"
          ? "deferred_declined"
          : "not_quoted";
    return {
      title: String(item.title).trim(),
      serviceKey: item.serviceKey || null,
      status: item.status,
      dueAtMiles: item.dueAtMiles ?? null,
      dueAtDate: item.dueAtDate ?? null,
      source: recommendationSource(hasVhi, hasDvi),
      dviSeverity,
      dviSource,
      outcome,
      recordedPrice: matched ? normalizeTicketJobAmount(matched.totalPrice) : null,
    };
  });
}

/** Legacy missedItems are the deferred and unquoted recommendation subset. */
export function missedItemsFromRecommendations(
  recommendations: ReadonlyArray<MissedOpportunityRecommendation>,
): MissingVhiItem[] {
  return (recommendations || [])
    .filter((item) => item.outcome !== "invoiced_performed")
    .map(({ title, serviceKey, status, dueAtMiles, dueAtDate }) => ({
      title,
      serviceKey,
      status,
      dueAtMiles,
      dueAtDate,
    }));
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
  const recommendations = (rows || []).flatMap((row) => row.recommendations || []);
  const emptyRollup = (): RecommendationRollup => ({
    count: 0,
    recordedDollarSubtotal: "0.00",
    unavailableCount: 0,
  });
  const recommendationsBySource: Record<RecommendationSource, RecommendationRollup> = {
    vhi: emptyRollup(),
    dvi: emptyRollup(),
    both: emptyRollup(),
  };
  const recommendationsByOutcome: Record<RecommendationOutcome, RecommendationRollup> = {
    invoiced_performed: emptyRollup(),
    deferred_declined: emptyRollup(),
    not_quoted: emptyRollup(),
  };
  const sourcePrices: Record<RecommendationSource, Array<{ totalPrice: string | null }>> = {
    vhi: [], dvi: [], both: [],
  };
  const outcomePrices: Record<RecommendationOutcome, Array<{ totalPrice: string | null }>> = {
    invoiced_performed: [], deferred_declined: [], not_quoted: [],
  };
  for (const recommendation of recommendations) {
    recommendationsBySource[recommendation.source].count += 1;
    recommendationsByOutcome[recommendation.outcome].count += 1;
    if (recommendation.recordedPrice == null) {
      recommendationsBySource[recommendation.source].unavailableCount += 1;
      recommendationsByOutcome[recommendation.outcome].unavailableCount += 1;
    }
    sourcePrices[recommendation.source].push({ totalPrice: recommendation.recordedPrice });
    outcomePrices[recommendation.outcome].push({ totalPrice: recommendation.recordedPrice });
  }
  for (const source of Object.keys(recommendationsBySource) as RecommendationSource[]) {
    recommendationsBySource[source].recordedDollarSubtotal =
      sumTicketJobAmounts(sourcePrices[source]).total;
  }
  for (const outcome of Object.keys(recommendationsByOutcome) as RecommendationOutcome[]) {
    recommendationsByOutcome[outcome].recordedDollarSubtotal =
      sumTicketJobAmounts(outcomePrices[outcome]).total;
  }

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
    totalRecommendations: recommendations.length,
    recommendationsBySource,
    recommendationsByOutcome,
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
  reportVersion: number;
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

/**
 * Make persisted reports safe for the current client. Legacy rows get a null
 * ticketJobs marker so the UI can explain that a refresh is needed.
 */
export function normalizeMissedOpportunityReportCache(
  value: unknown,
): MissedOpportunityReport {
  const report = value as MissedOpportunityReport;
  return {
    ...report,
    reportVersion:
      typeof report?.reportVersion === "number" ? report.reportVersion : 1,
    rows: Array.isArray(report?.rows)
      ? report.rows.map((row) => ({
          ...row,
          ticketJobs: Array.isArray((row as any).ticketJobs)
            ? (row as any).ticketJobs
            : null,
          recommendations: Array.isArray((row as any).recommendations)
            ? (row as any).recommendations
            : [],
        }))
      : [],
    notEvaluated: Array.isArray(report?.notEvaluated) ? report.notEvaluated : [],
  };
}

export function hasCurrentMissedOpportunityReportShape(value: unknown): boolean {
  const report = value as Partial<MissedOpportunityReport> | null;
  return (
    report?.reportVersion === MISSED_OPPORTUNITY_REPORT_VERSION &&
    Array.isArray(report.rows) &&
    report.rows.every(
      (row) =>
        Array.isArray((row as MissedOpportunityRo).ticketJobs) &&
        Array.isArray((row as MissedOpportunityRo).recommendations),
    ) &&
    typeof report.summary?.totalRecommendations === "number"
  );
}
