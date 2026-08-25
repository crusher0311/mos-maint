export const REPORTING_KPI_VERSION = 1 as const;
export const REPORTING_MAX_RANGE_DAYS = 366;
export const REPORTING_MAX_SHOPS = 500;
export const REPORTING_DIMENSION_LIMIT = 500;
export const UNKNOWN_DIMENSION_KEY = "__unknown__";

export type ReportingScopeKind = "shop" | "enterprise" | "platform";
export type ReportingDimension = "location" | "advisor" | "technician";

export interface MetricDefinition {
  key: string;
  label: string;
  definition: string;
  denominator: string | null;
  timestampBasis: string;
  moneyUnit: "USD" | "count" | "percent";
  availability: string;
}

export const REPORTING_KPI_CATALOG: readonly MetricDefinition[] = [
  { key: "repairOrderCount", label: "Repair orders", definition: "Distinct non-deleted work orders closed in the selected range.", denominator: null, timestampBasis: "normalized_work_orders.closed_date (completed_date fallback)", moneyUnit: "count", availability: "Requires normalized closed work orders." },
  { key: "billedRevenue", label: "Billed revenue", definition: "Provider-normalized work-order grand total less recorded refunds; voided work orders are excluded.", denominator: null, timestampBasis: "work-order close date", moneyUnit: "USD", availability: "Requires normalized work-order totals; refund adjustment requires normalized payments." },
  { key: "averageRepairOrder", label: "Average repair order", definition: "Billed revenue divided by repair-order count.", denominator: "repairOrderCount", timestampBasis: "work-order close date", moneyUnit: "USD", availability: "Available when repair-order count and billed revenue are available." },
  { key: "declinedDeferredDollars", label: "Declined/deferred dollars", definition: "Provider-normalized total of service jobs recorded as declined or deferred on in-range work orders.", denominator: null, timestampBasis: "parent work-order close date", moneyUnit: "USD", availability: "Requires normalized service-job status and total." },
  { key: "opportunityConversionRate", label: "Sold opportunity conversion", definition: "Completed/authorized recommendation jobs divided by completed/authorized plus declined/deferred recommendation jobs.", denominator: "soldOpportunityCount + missedOpportunityCount", timestampBasis: "parent work-order close date", moneyUnit: "percent", availability: "Requires normalized service jobs carrying a recommendation_id; distinct from the existing Missed Opportunities report." },
  { key: "laborPartsMix", label: "Recorded labor/parts mix", definition: "Recorded labor and parts totals as shares of their combined amount.", denominator: "laborRevenue + partsRevenue", timestampBasis: "work-order close date", moneyUnit: "percent", availability: "Only records with provider-supplied labor/parts totals contribute." },
  { key: "plansViewed", label: "Plans viewed", definition: "Sum of recorded view_count for plan-view records whose last-view timestamp is in range.", denominator: null, timestampBasis: "viewed_vins.last_viewed_at", moneyUnit: "count", availability: "Historical repeat views are only attributable to the last-view date in the current store." },
  { key: "recommendationsAdded", label: "Recommendations added", definition: "Count of recommendation_added events.", denominator: null, timestampBasis: "recommendation_events.received_at", moneyUnit: "count", availability: "Requires recommendation event telemetry." },
  { key: "recommendationsSold", label: "Recommendations sold", definition: "Count of recommendation_sold events.", denominator: null, timestampBasis: "recommendation_events.received_at", moneyUnit: "count", availability: "Requires recommendation sale attribution." },
  { key: "attributedRevenue", label: "MOS-attributed revenue", definition: "Sum of recommendation_sold event totalPrice; kept separate from billed revenue.", denominator: null, timestampBasis: "recommendation_events.received_at", moneyUnit: "USD", availability: "Requires sold events with a recorded totalPrice." },
] as const;

export interface ReportingMetricValues {
  repairOrderCount: number;
  billedRevenue: number | null;
  averageRepairOrder: number | null;
  declinedDeferredDollars: number | null;
  soldOpportunityCount: number | null;
  missedOpportunityCount: number | null;
  opportunityConversionRate: number | null;
  laborRevenue: number | null;
  partsRevenue: number | null;
  laborMixPercent: number | null;
  partsMixPercent: number | null;
  plansViewed: number | null;
  recommendationsAdded: number | null;
  recommendationsSold: number | null;
  attributedRevenue: number | null;
  recommendationConversionRate: number | null;
}

export interface ReportingAvailability {
  business: boolean;
  payments: boolean;
  staff: boolean;
  laborParts: boolean;
  planViews: boolean;
  recommendationEvents: boolean;
}

export interface ReportingGroup {
  key: string;
  label: string;
  shopId?: number;
  metrics: ReportingMetricValues;
  availability: ReportingAvailability;
}

export interface ReportingKpiResponse {
  ok: true;
  version: typeof REPORTING_KPI_VERSION;
  generatedAt: string;
  scope: { kind: ReportingScopeKind; shopIds: number[]; enterpriseId?: string };
  range: { start: string; end: string; days: number; timestampBasis: string };
  catalog: readonly MetricDefinition[];
  summary: ReportingMetricValues;
  availability: ReportingAvailability;
  timeSeries: ReportingGroup[];
  byLocation: ReportingGroup[];
  byAdvisor: ReportingGroup[];
  byTechnician: ReportingGroup[];
  byRecommendationSource: ReportingGroup[];
  dataQuality: {
    unknownAdvisorRepairOrders: number;
    unknownTechnicianJobs: number;
    dimensionsTruncated: boolean;
    notes: string[];
  };
}

export function providerMoneyToDollars(
  value: unknown,
  provider: unknown,
  entity: "work_order" | "service_job" | "payment" = "work_order",
): number | null {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return entity === "work_order" && String(provider || "").toLowerCase() === "tekmetric"
    ? amount / 100
    : amount;
}

export function restrictToAssignedShops(
  requested: readonly number[],
  assigned: readonly number[],
  platformAdmin = false,
): number[] {
  const assignedSet = new Set(assigned);
  return [...new Set(requested)].filter((id) => platformAdmin || assignedSet.has(id));
}

export function safeRate(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function finalizeMetrics(
  input: Partial<ReportingMetricValues>,
): ReportingMetricValues {
  const roCount = Number(input.repairOrderCount || 0);
  const billed = input.billedRevenue ?? null;
  const labor = input.laborRevenue ?? null;
  const parts = input.partsRevenue ?? null;
  const sold = input.soldOpportunityCount ?? null;
  const missed = input.missedOpportunityCount ?? null;
  const added = input.recommendationsAdded ?? null;
  const recSold = input.recommendationsSold ?? null;
  const mixDenominator = labor != null && parts != null ? labor + parts : null;
  return {
    repairOrderCount: roCount,
    billedRevenue: billed,
    averageRepairOrder: billed != null && roCount > 0 ? billed / roCount : null,
    declinedDeferredDollars: input.declinedDeferredDollars ?? null,
    soldOpportunityCount: sold,
    missedOpportunityCount: missed,
    opportunityConversionRate:
      sold != null && missed != null ? safeRate(sold, sold + missed) : null,
    laborRevenue: labor,
    partsRevenue: parts,
    laborMixPercent: labor != null ? safeRate(labor, mixDenominator) : null,
    partsMixPercent: parts != null ? safeRate(parts, mixDenominator) : null,
    plansViewed: input.plansViewed ?? null,
    recommendationsAdded: added,
    recommendationsSold: recSold,
    attributedRevenue: input.attributedRevenue ?? null,
    recommendationConversionRate:
      added != null && recSold != null ? safeRate(recSold, added) : null,
  };
}
