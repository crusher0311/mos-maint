import {
  REPORT_DEFINITION_MAX_FILTER_VALUES,
  REPORT_DEFINITION_MAX_QUERY_COST,
  REPORT_DEFINITION_MAX_ROWS,
  REPORT_DEFINITION_VERSION,
  REPORT_DIMENSIONS,
  REPORT_DIMENSION_TO_KPI_FIELD,
  REPORT_FILTER_OPERATORS,
  REPORT_METRICS,
  REPORT_METRIC_VALUE_KEYS,
  REPORT_PRESENTATIONS,
  type CompiledReportDefinition,
  type DeclarativeReportResult,
  type DeclarativeReportRow,
  type ReportDefinitionV1,
  type ReportDimension,
  type ReportFilterOperator,
  type ReportExecutionPlan,
  type ReportMetric,
} from "@/lib/report-definition-contract";
import {
  REPORTING_KPI_CATALOG,
  REPORTING_MAX_SHOPS,
  REPORTING_QUERY_DEADLINE_MS,
  type ReportingGroup,
  type ReportingKpiResponse,
  type ReportingMetricValues,
  type ReportingPeriodResponse,
} from "@/lib/reporting-kpi-contract";
import {
  getReportingPeriods,
  normalizeReportingRange,
} from "@/lib/reporting-kpi-service";
import type { ResolvedReportingScope } from "@/lib/reporting-scope";

export class ReportDefinitionError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "ReportDefinitionError";
  }
}

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReportDefinitionError(`${field} must be an object`, field);
  }
  return value as Record<string, unknown>;
};
const strictKeys = (value: Record<string, unknown>, allowed: readonly string[], field: string) => {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new ReportDefinitionError(`${field} contains unsupported field "${unexpected[0]}"`, field);
};
const nonEmptyString = (value: unknown, field: string, max: number) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ReportDefinitionError(`${field} must be a non-empty string of at most ${max} characters`, field);
  }
  return value.trim();
};
const enumValue = <T extends string>(value: unknown, allowed: readonly T[], field: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ReportDefinitionError(`${field} is not allowed`, field);
  }
  return value as T;
};
const uniqueEnumArray = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  max: number,
): T[] => {
  if (!Array.isArray(value) || !value.length || value.length > max) {
    throw new ReportDefinitionError(`${field} must contain between 1 and ${max} entries`, field);
  }
  const parsed = value.map((entry, index) => enumValue(entry, allowed, `${field}[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw new ReportDefinitionError(`${field} must not contain duplicates`, field);
  return parsed;
};

function dateRange(value: unknown, field: string) {
  const input = record(value, field);
  strictKeys(input, ["start", "end"], field);
  const start = nonEmptyString(input.start, `${field}.start`, 10);
  const end = nonEmptyString(input.end, `${field}.end`, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new ReportDefinitionError(`${field} dates must use YYYY-MM-DD`, field);
  }
  try {
    return { raw: { start, end }, normalized: normalizeReportingRange(start, end) };
  } catch (error) {
    throw new ReportDefinitionError(error instanceof Error ? error.message : "Invalid date range", field);
  }
}

/**
 * Upgrade the sole supported legacy shape. Unknown and future versions fail
 * closed rather than being interpreted as the current schema.
 */
export function upgradeReportDefinition(input: unknown): unknown {
  const source = record(input, "definition");
  if (source.version === REPORT_DEFINITION_VERSION) return source;
  if (source.version !== 0) {
    throw new ReportDefinitionError(`Unsupported report definition version "${String(source.version)}"`, "version");
  }
  strictKeys(source, [
    "version", "id", "name", "start", "end", "metric", "dimension",
    "filters", "comparison", "presentation",
  ], "definition");
  return {
    version: REPORT_DEFINITION_VERSION,
    id: source.id,
    name: source.name,
    dateRange: { start: source.start, end: source.end },
    metrics: [source.metric],
    dimensions: [source.dimension ?? "none"],
    filters: source.filters,
    comparison: source.comparison,
    presentation: source.presentation ?? { kind: source.dimension === "date" ? "timeSeries" : "table" },
  };
}

export function compileReportDefinition(
  input: unknown,
  scope: Pick<ResolvedReportingScope, "shopIds">,
): CompiledReportDefinition {
  const source = record(upgradeReportDefinition(input), "definition");
  strictKeys(source, [
    "version", "id", "name", "dateRange", "metrics", "dimensions",
    "filters", "comparison", "presentation",
  ], "definition");
  if (source.version !== REPORT_DEFINITION_VERSION) throw new ReportDefinitionError("Invalid definition version", "version");
  const id = nonEmptyString(source.id, "id", 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new ReportDefinitionError("id contains unsupported characters", "id");
  const name = nonEmptyString(source.name, "name", 200);
  const current = dateRange(source.dateRange, "dateRange");
  const metrics = uniqueEnumArray(source.metrics, REPORT_METRICS, "metrics", REPORT_METRICS.length);
  const dimensions = uniqueEnumArray(source.dimensions, REPORT_DIMENSIONS, "dimensions", 1);
  const dimension = dimensions[0];

  const filters = source.filters === undefined ? [] : (() => {
    if (!Array.isArray(source.filters) || source.filters.length > 10) {
      throw new ReportDefinitionError("filters must contain at most 10 entries", "filters");
    }
    return source.filters.map((raw, index) => {
      const filter = record(raw, `filters[${index}]`);
      strictKeys(filter, ["dimension", "operator", "value"], `filters[${index}]`);
      const filterDimension = enumValue(
        filter.dimension,
        REPORT_DIMENSIONS.filter((entry) => entry !== "none" && entry !== "date"),
        `filters[${index}].dimension`,
      ) as Exclude<ReportDimension, "none" | "date">;
      if (filterDimension !== dimension) {
        throw new ReportDefinitionError("filters may only target the selected dimension", `filters[${index}].dimension`);
      }
      const operator = enumValue(filter.operator, REPORT_FILTER_OPERATORS, `filters[${index}].operator`);
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      if (!values.length || values.length > REPORT_DEFINITION_MAX_FILTER_VALUES ||
          values.some((item) => typeof item !== "string" || !item.length || item.length > 200)) {
        throw new ReportDefinitionError(
          `filter values must contain 1-${REPORT_DEFINITION_MAX_FILTER_VALUES} non-empty strings`,
          `filters[${index}].value`,
        );
      }
      if ((operator === "eq" || operator === "notEq") && values.length !== 1) {
        throw new ReportDefinitionError(`${operator} accepts exactly one value`, `filters[${index}].value`);
      }
      return { dimension: filterDimension, operator, value: Array.isArray(filter.value) ? values : values[0] };
    });
  })();

  const comparisonInput = source.comparison === undefined ? { mode: "none" } : record(source.comparison, "comparison");
  strictKeys(comparisonInput, ["mode", "range"], "comparison");
  const comparisonMode = enumValue(comparisonInput.mode, ["none", "previousPeriod", "custom"] as const, "comparison.mode");
  if (comparisonMode !== "custom" && own(comparisonInput, "range")) {
    throw new ReportDefinitionError("comparison.range is only allowed for custom comparison", "comparison.range");
  }
  let comparisonRange: ReturnType<typeof normalizeReportingRange> | null = null;
  let comparison: ReportDefinitionV1["comparison"] = { mode: comparisonMode };
  if (comparisonMode === "custom") {
    if (!own(comparisonInput, "range")) throw new ReportDefinitionError("custom comparison requires a range", "comparison.range");
    const parsed = dateRange(comparisonInput.range, "comparison.range");
    comparisonRange = parsed.normalized;
    comparison = { mode: "custom", range: parsed.raw };
  } else if (comparisonMode === "previousPeriod") {
    const end = new Date(current.normalized.start.getTime() - 1);
    const start = new Date(end.getTime() - (current.normalized.days - 1) * 86400000);
    comparisonRange = normalizeReportingRange(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
  }

  const presentationInput = record(source.presentation, "presentation");
  strictKeys(presentationInput, ["kind", "limit", "orderBy", "direction"], "presentation");
  const kind = enumValue(presentationInput.kind, REPORT_PRESENTATIONS, "presentation.kind");
  if (kind === "scorecard" && dimension !== "none") throw new ReportDefinitionError("scorecard requires the none dimension", "presentation.kind");
  if (kind === "timeSeries" && dimension !== "date") throw new ReportDefinitionError("timeSeries requires the date dimension", "presentation.kind");
  const limit = presentationInput.limit === undefined ? REPORT_DEFINITION_MAX_ROWS : Number(presentationInput.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > REPORT_DEFINITION_MAX_ROWS) {
    throw new ReportDefinitionError(`presentation.limit must be between 1 and ${REPORT_DEFINITION_MAX_ROWS}`, "presentation.limit");
  }
  const orderAllowed = ["dimension", ...metrics] as const;
  const orderBy = presentationInput.orderBy === undefined ? "dimension" : enumValue(presentationInput.orderBy, orderAllowed, "presentation.orderBy");
  const direction = presentationInput.direction === undefined
    ? "asc"
    : enumValue(presentationInput.direction, ["asc", "desc"] as const, "presentation.direction");

  if (!scope.shopIds.length || scope.shopIds.length > REPORTING_MAX_SHOPS ||
      scope.shopIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(scope.shopIds).size !== scope.shopIds.length) {
    throw new ReportDefinitionError(`scope must contain 1-${REPORTING_MAX_SHOPS} unique shop IDs`, "scope.shopIds");
  }
  const periods = comparisonRange ? 2 : 1;
  const estimatedQueryCost = scope.shopIds.length * (current.normalized.days + (comparisonRange?.days || 0)) *
    (1 + (dimension === "none" ? 0 : 1) + filters.length);
  if (estimatedQueryCost > REPORT_DEFINITION_MAX_QUERY_COST) {
    throw new ReportDefinitionError(
      `estimated query cost ${estimatedQueryCost} exceeds ${REPORT_DEFINITION_MAX_QUERY_COST}`,
      "queryCost",
    );
  }
  const catalog = new Map(REPORTING_KPI_CATALOG.map((metric) => [metric.key, metric]));
  const businessMetrics = new Set<ReportMetric>([
    "repairOrderCount", "billedRevenue", "averageRepairOrder", "declinedDeferredDollars",
    "opportunityConversionRate", "laborPartsMix",
  ]);
  const hasBusinessMetric = metrics.some((metric) => businessMetrics.has(metric));
  const hasEventMetric = metrics.some((metric) => !businessMetrics.has(metric));
  const execution: ReportExecutionPlan = (() => {
    switch (dimension) {
      case "technician":
        return { stages: ["technician"], dimensions: ["technician"] };
      case "recommendationSource":
        return { stages: ["events"], dimensions: ["recommendationSource"] };
      case "advisor":
        return { stages: ["business"], dimensions: ["advisor"] };
      default: {
        const stages: ReportExecutionPlan["stages"] = [];
        if (hasBusinessMetric) stages.push("business");
        if (hasEventMetric) stages.push("events");
        return {
          stages,
          dimensions: [dimension === "none" ? "summary" : dimension],
        };
      }
    }
  })();
  return {
    definition: {
      version: REPORT_DEFINITION_VERSION,
      id,
      name,
      dateRange: current.raw,
      metrics,
      dimensions,
      ...(filters.length ? { filters } : {}),
      comparison,
      presentation: { kind, limit, orderBy, direction },
    },
    authorizedShopIds: [...scope.shopIds],
    currentRange: current.normalized,
    comparisonRange,
    projection: {
      dimension,
      metrics: metrics.map((metric) => ({ ...catalog.get(metric)!, valueKeys: [...REPORT_METRIC_VALUE_KEYS[metric]] })),
      maxRows: limit,
    },
    execution,
    bounds: {
      shops: scope.shopIds.length,
      days: current.normalized.days,
      periods,
      estimatedQueryCost,
      maxQueryCost: REPORT_DEFINITION_MAX_QUERY_COST,
    },
  };
}

const projectValues = (values: ReportingMetricValues, metrics: ReportMetric[]) =>
  Object.fromEntries(metrics.flatMap((metric) =>
    REPORT_METRIC_VALUE_KEYS[metric].map((key) => [key, values[key]]),
  ));

function groups(response: ReportingKpiResponse, dimension: ReportDimension): ReportingGroup[] {
  if (dimension === "none") {
    return [{ key: "summary", label: "Summary", metrics: response.summary, availability: response.availability }];
  }
  return response[REPORT_DIMENSION_TO_KPI_FIELD[dimension]!];
}

function selected(row: ReportingGroup, operator: ReportFilterOperator, raw: string | string[]) {
  const values = new Set(Array.isArray(raw) ? raw : [raw]);
  const matches = values.has(row.key);
  return operator === "eq" || operator === "in" ? matches : !matches;
}

const change = (current: number | null, prior: number | null) =>
  current == null || prior == null ? null : current - prior;
const changePercent = (current: number | null, prior: number | null) =>
  current == null || prior == null || prior === 0 ? null : Math.round(((current - prior) / Math.abs(prior)) * 1000) / 10;

export async function executeCompiledReport(
  plan: CompiledReportDefinition,
  scope: ResolvedReportingScope,
  options?: {
    getPeriods?: typeof getReportingPeriods;
    serviceOptions?: Parameters<typeof getReportingPeriods>[3];
    maxDeadlineMs?: number;
  },
): Promise<DeclarativeReportResult> {
  if (scope.shopIds.length !== plan.authorizedShopIds.length ||
      scope.shopIds.some((id, index) => id !== plan.authorizedShopIds[index])) {
    throw new ReportDefinitionError("compiled report scope does not match execution scope", "scope.shopIds");
  }
  const periods: ReportingPeriodResponse = await (options?.getPeriods ?? getReportingPeriods)(
    scope,
    plan.currentRange,
    plan.comparisonRange,
    {
      ...options?.serviceOptions,
      executionPlan: plan.execution,
      deadlineMs: Math.max(1, Math.min(
        options?.serviceOptions?.deadlineMs ?? REPORTING_QUERY_DEADLINE_MS,
        options?.maxDeadlineMs ?? REPORTING_QUERY_DEADLINE_MS,
      )),
    },
  );
  const metricKeys = plan.definition.metrics;
  const prior = new Map(groups(periods.comparison || periods.current, plan.projection.dimension).map((row) => [row.key, row]));
  let rows: DeclarativeReportRow[] = groups(periods.current, plan.projection.dimension)
    .filter((row) => (plan.definition.filters || []).every((filter) => selected(row, filter.operator, filter.value)))
    .map((row) => {
      const current = projectValues(row.metrics, metricKeys);
      const comparisonGroup = periods.comparison ? prior.get(row.key) : undefined;
      const comparison = comparisonGroup ? projectValues(comparisonGroup.metrics, metricKeys) : null;
      return {
        key: row.key,
        label: row.label,
        ...(row.shopId !== undefined ? { shopId: row.shopId } : {}),
        current,
        comparison,
        delta: comparison ? Object.fromEntries(Object.keys(current).map((key) => [key, change(current[key], comparison[key])])) : null,
        deltaPercent: comparison ? Object.fromEntries(Object.keys(current).map((key) => [key, changePercent(current[key], comparison[key])])) : null,
      };
    });
  const { orderBy = "dimension", direction = "asc" } = plan.definition.presentation;
  const sortKey = orderBy === "dimension" ? null : REPORT_METRIC_VALUE_KEYS[orderBy][0];
  rows.sort((a, b) => {
    const result = sortKey
      ? (a.current[sortKey] == null ? 1 : b.current[sortKey] == null ? -1 : a.current[sortKey]! - b.current[sortKey]!)
      : a.label.localeCompare(b.label);
    return direction === "desc" ? -result : result;
  });
  const truncated = rows.length > plan.projection.maxRows || periods.current.dataQuality.dimensionsTruncated;
  rows = rows.slice(0, plan.projection.maxRows);
  return {
    ok: true,
    version: REPORT_DEFINITION_VERSION,
    definitionId: plan.definition.id,
    generatedAt: periods.current.generatedAt,
    rows,
    metadata: {
      definitionName: plan.definition.name,
      dimension: plan.projection.dimension,
      metrics: plan.projection.metrics,
      selectedFilters: plan.definition.filters || [],
      comparison: plan.definition.comparison,
      presentation: plan.definition.presentation,
      bounds: plan.bounds,
      coverage: periods.current.availability,
      dataQuality: periods.current.dataQuality,
      truncated,
      ...(periods.comparisonError ? { comparisonError: periods.comparisonError } : {}),
      source: "reporting-kpi-service",
    },
  };
}

export async function executeReportDefinition(
  definition: unknown,
  scope: ResolvedReportingScope,
  options?: Parameters<typeof executeCompiledReport>[2],
) {
  return executeCompiledReport(compileReportDefinition(definition, scope), scope, options);
}