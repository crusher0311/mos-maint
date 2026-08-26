import {
  REPORTING_DIMENSION_LIMIT,
  REPORTING_KPI_CATALOG,
  REPORTING_MAX_RANGE_DAYS,
  REPORTING_MAX_SHOPS,
  type MetricDefinition,
  type ReportingAvailability,
  type ReportingDimension,
  type ReportingKpiResponse,
  type ReportingMetricValues,
  type ReportingPeriodResponse,
} from "@/lib/reporting-kpi-contract";

export const REPORT_DEFINITION_VERSION = 1 as const;
export const REPORT_DEFINITION_MAX_ROWS = REPORTING_DIMENSION_LIMIT;
export const REPORT_DEFINITION_MAX_FILTER_VALUES = 100;
export const REPORT_DEFINITION_MAX_QUERY_COST = 2_000_000;

export const REPORT_METRICS = REPORTING_KPI_CATALOG.map((metric) => metric.key) as readonly ReportMetric[];
export const REPORT_DIMENSIONS = [
  "none",
  "date",
  "location",
  "advisor",
  "technician",
  "recommendationSource",
] as const;
export const REPORT_FILTER_OPERATORS = ["eq", "notEq", "in", "notIn"] as const;
export const REPORT_PRESENTATIONS = ["scorecard", "table", "timeSeries"] as const;

export type ReportMetric = (typeof REPORTING_KPI_CATALOG)[number]["key"];
export type ReportDimension = (typeof REPORT_DIMENSIONS)[number];
export type ReportFilterOperator = (typeof REPORT_FILTER_OPERATORS)[number];
export type ReportPresentationKind = (typeof REPORT_PRESENTATIONS)[number];
export type ReportExecutionStage = "business" | "technician" | "events";
export type ReportExecutionDimension =
  | "summary"
  | "date"
  | "location"
  | "advisor"
  | "technician"
  | "recommendationSource";

export interface ReportExecutionPlan {
  stages: ReportExecutionStage[];
  dimensions: ReportExecutionDimension[];
}

export interface ReportDateRange {
  start: string;
  end: string;
}

export interface ReportDefinitionV1 {
  version: typeof REPORT_DEFINITION_VERSION;
  id: string;
  name: string;
  dateRange: ReportDateRange;
  metrics: ReportMetric[];
  dimensions: ReportDimension[];
  filters?: Array<{
    dimension: Exclude<ReportDimension, "none" | "date">;
    operator: ReportFilterOperator;
    value: string | string[];
  }>;
  comparison?: {
    mode: "none" | "previousPeriod" | "custom";
    range?: ReportDateRange;
  };
  presentation: {
    kind: ReportPresentationKind;
    limit?: number;
    orderBy?: "dimension" | ReportMetric;
    direction?: "asc" | "desc";
  };
}

export interface CompiledReportDefinition {
  definition: ReportDefinitionV1;
  authorizedShopIds: number[];
  currentRange: { start: Date; end: Date; days: number };
  comparisonRange: { start: Date; end: Date; days: number } | null;
  projection: {
    dimension: ReportDimension;
    metrics: Array<MetricDefinition & { valueKeys: Array<keyof ReportingMetricValues> }>;
    maxRows: number;
  };
  execution: ReportExecutionPlan;
  bounds: {
    shops: number;
    days: number;
    periods: number;
    estimatedQueryCost: number;
    maxQueryCost: number;
  };
}

export interface DeclarativeReportRow {
  key: string;
  label: string;
  shopId?: number;
  current: Record<string, number | null>;
  comparison: Record<string, number | null> | null;
  delta: Record<string, number | null> | null;
  deltaPercent: Record<string, number | null> | null;
}

export interface DeclarativeReportResult {
  ok: true;
  version: typeof REPORT_DEFINITION_VERSION;
  definitionId: string;
  generatedAt: string;
  rows: DeclarativeReportRow[];
  metadata: {
    definitionName: string;
    dimension: ReportDimension;
    metrics: CompiledReportDefinition["projection"]["metrics"];
    selectedFilters: NonNullable<ReportDefinitionV1["filters"]>;
    comparison: ReportDefinitionV1["comparison"];
    presentation: ReportDefinitionV1["presentation"];
    bounds: CompiledReportDefinition["bounds"];
    coverage: ReportingAvailability;
    dataQuality: ReportingKpiResponse["dataQuality"];
    truncated: boolean;
    comparisonError?: ReportingPeriodResponse["comparisonError"];
    source: "reporting-kpi-service";
  };
}

export const REPORT_DIMENSION_TO_KPI_FIELD: Readonly<
  Partial<Record<ReportDimension, "timeSeries" | "byLocation" | "byAdvisor" | "byTechnician" | "byRecommendationSource">>
> = {
  date: "timeSeries",
  location: "byLocation",
  advisor: "byAdvisor",
  technician: "byTechnician",
  recommendationSource: "byRecommendationSource",
};

export const REPORT_METRIC_VALUE_KEYS: Readonly<Record<ReportMetric, Array<keyof ReportingMetricValues>>> = {
  repairOrderCount: ["repairOrderCount"],
  billedRevenue: ["billedRevenue"],
  averageRepairOrder: ["averageRepairOrder"],
  declinedDeferredDollars: ["declinedDeferredDollars"],
  opportunityConversionRate: ["opportunityConversionRate"],
  laborPartsMix: ["laborMixPercent", "partsMixPercent"],
  plansViewed: ["plansViewed"],
  recommendationsAdded: ["recommendationsAdded"],
  recommendationsSold: ["recommendationsSold"],
  attributedRevenue: ["attributedRevenue"],
};

// Export the KPI dimension type relationship so contract consumers cannot invent
// a second vocabulary for service-backed dimensions.
export type ServiceReportingDimension = ReportingDimension;

export const REPORT_DEFINITION_LIMITS = {
  maxRangeDays: REPORTING_MAX_RANGE_DAYS,
  maxShops: REPORTING_MAX_SHOPS,
  maxRows: REPORT_DEFINITION_MAX_ROWS,
  maxFilterValues: REPORT_DEFINITION_MAX_FILTER_VALUES,
  maxQueryCost: REPORT_DEFINITION_MAX_QUERY_COST,
} as const;