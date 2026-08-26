import assert from "node:assert/strict";
import {
  compileReportDefinition,
  executeCompiledReport,
  ReportDefinitionError,
  upgradeReportDefinition,
} from "../lib/report-definition-compiler";
import { finalizeMetrics, type ReportingKpiResponse } from "../lib/reporting-kpi-contract";

const scope = {
  kind: "enterprise" as const,
  enterpriseId: "e1",
  shopIds: [1, 2],
  shops: [
    { shopId: 1, name: "One", locationIdentifier: null },
    { shopId: 2, name: "Two", locationIdentifier: null },
  ],
};

const definition = {
  version: 1,
  id: "monthly.locations",
  name: "Monthly locations",
  dateRange: { start: "2026-08-01", end: "2026-08-31" },
  metrics: ["billedRevenue", "laborPartsMix"],
  dimensions: ["location"],
  filters: [{ dimension: "location", operator: "in", value: ["1"] }],
  comparison: { mode: "previousPeriod" },
  presentation: { kind: "table", limit: 10, orderBy: "billedRevenue", direction: "desc" },
};

const plan = compileReportDefinition(definition, scope);
assert.equal(plan.currentRange.days, 31);
assert.equal(plan.comparisonRange?.days, 31);
assert.equal(plan.bounds.periods, 2);
assert.equal(plan.projection.metrics[1].key, "laborPartsMix");
assert.deepEqual(plan.projection.metrics[1].valueKeys, ["laborMixPercent", "partsMixPercent"]);

assert.throws(
  () => compileReportDefinition({ ...definition, metrics: ["notSqlPlease"] }, scope),
  (error: unknown) => error instanceof ReportDefinitionError && error.field === "metrics[0]",
);
assert.throws(
  () => compileReportDefinition({ ...definition, dimensions: ["location", "advisor"] }, scope),
  /between 1 and 1/,
);
assert.throws(
  () => compileReportDefinition({ ...definition, presentation: { kind: "rawSql" } }, scope),
  /not allowed/,
);
assert.throws(
  () => compileReportDefinition({ ...definition, futureField: true }, scope),
  /unsupported field/,
);
assert.throws(
  () => compileReportDefinition({ ...definition, version: 99 }, scope),
  /Unsupported report definition version/,
);
assert.throws(
  () => compileReportDefinition({ ...definition, dateRange: { start: "2020-01-01", end: "2026-01-01" } }, scope),
  /between 1 and 366/,
);
assert.throws(
  () => compileReportDefinition(definition, { shopIds: Array.from({ length: 501 }, (_, i) => i + 1) }),
  /1-500 unique shop IDs/,
);
assert.throws(
  () => compileReportDefinition({ ...definition, presentation: { kind: "table", limit: 501 } }, scope),
  /between 1 and 500/,
);
assert.throws(
  () => compileReportDefinition({
    ...definition,
    dateRange: { start: "2025-01-01", end: "2026-01-01" },
    comparison: { mode: "custom", range: { start: "2024-01-01", end: "2024-12-31" } },
    filters: Array.from({ length: 4 }, (_, index) => ({
      dimension: "location", operator: "notEq", value: String(index + 1),
    })),
  }, {
    shopIds: Array.from({ length: 500 }, (_, index) => index + 1),
  }),
  /estimated query cost .* exceeds/,
);

const upgraded = upgradeReportDefinition({
  version: 0,
  id: "legacy",
  name: "Legacy",
  start: "2026-08-01",
  end: "2026-08-31",
  metric: "repairOrderCount",
  dimension: "none",
});
assert.equal((upgraded as any).version, 1);
assert.deepEqual((upgraded as any).metrics, ["repairOrderCount"]);

const response = (prior = false): ReportingKpiResponse => ({
  ok: true,
  version: 1,
  generatedAt: "2026-09-01T00:00:00.000Z",
  scope: { kind: "enterprise", shopIds: [1, 2], enterpriseId: "e1" },
  range: { start: "", end: "", days: 31, timestampBasis: "closed" },
  catalog: [],
  summary: finalizeMetrics({ repairOrderCount: 3, billedRevenue: prior ? 150 : 300 }),
  availability: { business: true, payments: true, staff: true, laborParts: true, planViews: false, recommendationEvents: false },
  timeSeries: [],
  byLocation: [
    {
      key: "1", label: "One", shopId: 1,
      metrics: finalizeMetrics({ repairOrderCount: 2, billedRevenue: prior ? 100 : 250, laborRevenue: 150, partsRevenue: 100 }),
      availability: { business: true, payments: true, staff: true, laborParts: true, planViews: false, recommendationEvents: false },
    },
    {
      key: "2", label: "Two", shopId: 2,
      metrics: finalizeMetrics({ repairOrderCount: 1, billedRevenue: 50 }),
      availability: { business: true, payments: true, staff: true, laborParts: false, planViews: false, recommendationEvents: false },
    },
  ],
  byAdvisor: [],
  byTechnician: [],
  byRecommendationSource: [],
  dataQuality: { unknownAdvisorRepairOrders: 0, unknownTechnicianJobs: 0, dimensionsTruncated: false, notes: [] },
});

async function smoke() {
  let calls = 0;
  const result = await executeCompiledReport(plan, scope, {
    getPeriods: async () => {
      calls++;
      return { current: response(), comparison: response(true) };
    },
  });
  assert.equal(calls, 1, "compiler delegates one bounded period request to the KPI service");
  assert.equal(result.rows.length, 1, "selected dimension filter is projected");
  assert.equal(result.rows[0].current.billedRevenue, 250);
  assert.equal(result.rows[0].current.laborMixPercent, 60);
  assert.equal(result.rows[0].current.partsMixPercent, 40);
  assert.equal(result.rows[0].comparison?.billedRevenue, 100);
  assert.equal(result.rows[0].delta!.billedRevenue, 150);
  assert.equal(result.rows[0].deltaPercent!.billedRevenue, 150);
  assert.equal(result.metadata.source, "reporting-kpi-service");
  assert.deepEqual(result.metadata.selectedFilters, definition.filters);
  console.log("report definition compiler smoke: ALL PASS");
}

smoke().catch((error) => {
  console.error(error);
  process.exit(1);
});