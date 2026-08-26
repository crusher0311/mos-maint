import assert from "node:assert/strict";
import {
  UNKNOWN_DIMENSION_KEY,
  finalizeMetrics,
  providerMoneyToDollars,
  restrictToAssignedShops,
  safeRate,
} from "../lib/reporting-kpi-contract";
import {
  getReportingPeriods,
  getReportingKpis,
  normalizeReportingRange,
  ReportingQueryError,
} from "../lib/reporting-kpi-service";
import { readFileSync } from "node:fs";

assert.equal(providerMoneyToDollars(12345, "tekmetric"), 123.45);
assert.equal(providerMoneyToDollars(123.45, "tekmetric", "service_job"), 123.45);
assert.equal(providerMoneyToDollars(50, "tekmetric", "payment"), 50);
assert.equal(providerMoneyToDollars("123.45", "protractor"), 123.45);
assert.equal(providerMoneyToDollars(null, "shopware"), null);

const mixed = finalizeMetrics({
  repairOrderCount: 2,
  billedRevenue: 450,
  declinedDeferredDollars: 150,
  soldOpportunityCount: 3,
  missedOpportunityCount: 1,
  laborRevenue: 300,
  partsRevenue: 100,
  recommendationsAdded: 5,
  recommendationsSold: 2,
  attributedRevenue: 225,
});
assert.equal(mixed.averageRepairOrder, 225);
assert.equal(mixed.opportunityConversionRate, 75);
assert.equal(mixed.laborMixPercent, 75);
assert.equal(mixed.partsMixPercent, 25);
assert.equal(mixed.recommendationConversionRate, 40);
assert.equal(safeRate(0, 0), null, "zero denominator must be unavailable, not a manufactured zero");

const sparse = finalizeMetrics({ repairOrderCount: 4 });
assert.equal(sparse.billedRevenue, null);
assert.equal(sparse.averageRepairOrder, null);
assert.equal(sparse.laborMixPercent, null);
assert.equal(UNKNOWN_DIMENSION_KEY, "__unknown__");

assert.deepEqual(restrictToAssignedShops([1, 2, 3], [1, 3]), [1, 3]);
assert.deepEqual(restrictToAssignedShops([99], [1, 3]), [], "arbitrary shop must be rejected");
assert.deepEqual(restrictToAssignedShops([99], [], true), [99], "platform scope is explicit");

const refunded = finalizeMetrics({ repairOrderCount: 1, billedRevenue: 100 - 25 });
assert.equal(refunded.billedRevenue, 75);
assert.equal(refunded.averageRepairOrder, 75);

const locations = [
  finalizeMetrics({ repairOrderCount: 2, billedRevenue: 200 }),
  finalizeMetrics({ repairOrderCount: 1, billedRevenue: 100 }),
];
const rolled = finalizeMetrics({
  repairOrderCount: locations.reduce((n, x) => n + x.repairOrderCount, 0),
  billedRevenue: locations.reduce((n, x) => n + (x.billedRevenue || 0), 0),
});
assert.equal(rolled.repairOrderCount, 3);
assert.equal(rolled.averageRepairOrder, 100);

assert.equal(normalizeReportingRange("2026-08-01", "2026-08-31").days, 31);
assert.throws(() => normalizeReportingRange("2025-01-01", "2026-08-31"), /between 1 and 366/);

async function testServicePipeline() {
  const queries: string[] = [];
  let call = 0;
  const commonCoverage = {
    business_available: true,
    payments_available: true,
    staff_available: true,
    mix_available: true,
  };
  const query = async (text: string) => {
    queries.push(text);
    call += 1;
    if (call === 1) {
      return [
        {
          dimension_type: "summary", dimension_key: "summary",
          ro_count: 2, billed_revenue: 300, declined_dollars: 50,
          sold_opps: 1, missed_opps: 1, labor_revenue: 180, parts_revenue: 120,
          ...commonCoverage,
        },
        {
          dimension_type: "location", dimension_key: "1", shop_id: 1,
          ro_count: 2, billed_revenue: 300, ...commonCoverage,
        },
        {
          dimension_type: "location", dimension_key: "2", shop_id: 2,
          ro_count: 0, billed_revenue: null,
          business_available: false, payments_available: false,
          staff_available: false, mix_available: false,
        },
        {
          dimension_type: "coverage", dimension_key: "3", shop_id: 3,
          ro_count: 0, billed_revenue: null,
          business_available: true, payments_available: true,
          staff_available: true, mix_available: false,
        },
      ];
    }
    if (call === 2) {
      return [
        { dimension_key: "1:t1", dimension_label: "Tech One", shop_id: 1, ro_count: 1, billed_revenue: 75, ...commonCoverage },
        { dimension_key: "1:t2", dimension_label: "Tech Two", shop_id: 1, ro_count: 1, billed_revenue: 225, ...commonCoverage },
      ];
    }
    const sources = Array.from({ length: 501 }, (_, i) => ({
      dimension_type: "source", dimension_key: `source-${i}`, dimension_label: `Source ${i}`,
      rec_events: 1, rec_added: 1, rec_sold: 0, attributed_revenue: 0,
      plan_views_available: true, rec_events_available: true,
    }));
    return [
      {
        dimension_type: "summary", dimension_key: "summary", rec_events: 2,
        rec_added: 2, rec_sold: 1, attributed_revenue: 100, plans_viewed: 0,
        plan_views_available: true, rec_events_available: true,
      },
      {
        dimension_type: "location", dimension_key: "1", shop_id: 1,
        rec_events: 0, rec_added: 0, rec_sold: 0, attributed_revenue: 0, plans_viewed: 0,
        plan_views_available: true, rec_events_available: true,
      },
      {
        dimension_type: "location", dimension_key: "2", shop_id: 2,
        rec_events: 0, rec_added: 0, rec_sold: 0, attributed_revenue: 0, plans_viewed: null,
        plan_views_available: false, rec_events_available: false,
      },
      {
        dimension_type: "date", dimension_key: "2026-08-15", dimension_label: "2026-08-15",
        rec_events: 1, rec_added: 1, rec_sold: 1, attributed_revenue: 42,
        plan_views_available: true, rec_events_available: true,
      },
      ...sources,
    ];
  };

  const report = await getReportingKpis(
    {
      kind: "enterprise",
      enterpriseId: "enterprise-1",
      shops: [
        { shopId: 1, name: "One", locationIdentifier: null },
        { shopId: 2, name: "Two", locationIdentifier: null },
        { shopId: 3, name: "Three", locationIdentifier: null },
      ],
      shopIds: [1, 2, 3],
    },
    normalizeReportingRange("2026-08-01", "2026-08-31"),
    { query },
  );

  assert.equal(queries.length, 3, "bounded service should use three consolidated queries");
  assert.match(queries[0], /soft_delete.*isDeleted/s, "deleted refunds must be excluded");
  assert.match(queries[0], /period_work_orders AS MATERIALIZED/, "the selected reporting window must be materialized first");
  assert.match(
    queries[0],
    /normalized_payments p\s+JOIN period_work_orders wo ON wo\.id=p\.work_order_id AND wo\.shop_id=p\.shop_id/s,
    "payments must be restricted to in-range work orders before aggregation",
  );
  assert.match(
    queries[0],
    /normalized_service_jobs sj\s+JOIN period_work_orders wo ON wo\.id=sj\.work_order_id AND wo\.shop_id=sj\.shop_id/s,
    "service jobs must be restricted to in-range work orders before aggregation",
  );
  assert.doesNotMatch(
    queries[0],
    /FROM normalized_payments\s+WHERE shop_id = ANY/s,
    "long-history payment tables must never be aggregated by shop alone",
  );
  assert.match(
    queries[0],
    /GROUP BY p\.shop_id, p\.work_order_id[\s\S]*GROUP BY sj\.shop_id, sj\.work_order_id[\s\S]*r\.shop_id=wo\.shop_id[\s\S]*j\.shop_id=wo\.shop_id/,
    "identical provider work-order IDs must remain isolated between shops",
  );
  assert.match(queries[0], /p\.status IN \('refunded'/, "joined payment fields must be unambiguous");
  assert.match(queries[0], /sj\.status IN \('declined'/, "joined service-job fields must be unambiguous");
  assert.match(queries[0], /GROUPING SETS.*advisor_key/s, "advisor names must not split stable IDs");
  assert.doesNotMatch(queries[1], /GROUP BY shop_id, technician_id, technician_name/);
  assert.match(queries[1], /array_agg.*technician_name.*basis_date DESC/s);
  assert.equal(
    (queries[1].match(/PARTITION BY f\.shop_id, f\.id/g) || []).length,
    3,
    "technician revenue allocation must isolate duplicate work-order IDs between shops",
  );
  assert.match(queries[2], /totalPrice.*~ '\^-\?\[0-9\]/s, "malformed revenue must be guarded");
  assert.equal(report.byLocation[0].metrics.plansViewed, 0, "available zero must remain zero");
  assert.equal(report.byLocation[1].metrics.plansViewed, null, "unavailable must remain null");
  assert.equal(report.byLocation[0].availability.business, true);
  assert.equal(report.byLocation[1].availability.business, false);
  assert.equal(report.byLocation[2].availability.business, true, "coverage survives an empty date window");
  assert.equal(
    report.byTechnician.reduce((sum, row) => sum + (row.metrics.billedRevenue || 0), 0),
    report.summary.billedRevenue,
    "technician allocation must reconcile to net billed revenue",
  );
  assert.equal(report.byRecommendationSource.length, 500);
  assert.equal(report.timeSeries[0].key, "2026-08-15", "telemetry-only dates remain visible in the MOS trend");
  assert.equal(report.timeSeries[0].metrics.attributedRevenue, 42);
  assert.equal(report.dataQuality.dimensionsTruncated, true);
}

async function testBoundedExecution() {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const emptyQuery = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return [];
  };
  const largeScope = {
    kind: "enterprise" as const,
    enterpriseId: "large-enterprise",
    shopIds: Array.from({ length: 500 }, (_, index) => index + 1),
    shops: Array.from({ length: 500 }, (_, index) => ({
      shopId: index + 1, name: `Shop ${index + 1}`, locationIdentifier: null,
    })),
  };
  const periods = await getReportingPeriods(
    largeScope,
    normalizeReportingRange("2026-08-01", "2026-08-30"),
    normalizeReportingRange("2026-07-02", "2026-07-31"),
    { query: emptyQuery, deadlineMs: 1_000 },
  );
  assert.equal(calls, 6, "current and prior should each use three stages");
  assert.equal(maxActive, 1, "report stages and periods must not compete for the two-connection pool");
  assert.equal(periods.current.byLocation.length, 500, "large authorized scopes remain complete");
  assert.ok(periods.comparison);

  let periodCall = 0;
  const partial = await getReportingPeriods(
    largeScope,
    normalizeReportingRange("2026-08-01", "2026-08-30"),
    normalizeReportingRange("2026-07-02", "2026-07-31"),
    {
      deadlineMs: 1_000,
      query: async () => {
        periodCall++;
        if (periodCall > 3) throw new Error("database unavailable");
        return [];
      },
    },
  );
  assert.ok(partial.current, "current period must survive comparison failure");
  assert.equal(partial.comparison, null);
  assert.equal(partial.comparisonError?.kind, "database");

  let optionalCall = 0;
  const degraded = await getReportingKpis(
    largeScope,
    normalizeReportingRange("2026-08-01", "2026-08-30"),
    {
      query: async () => {
        optionalCall++;
        if (optionalCall === 2) throw new Error("technician query unavailable");
        if (optionalCall === 3) throw new Error("events query unavailable");
        return [{
          dimension_type: "summary",
          dimension_key: "summary",
          ro_count: 1,
          billed_revenue: 125,
          business_available: true,
        }];
      },
    },
  );
  assert.equal(degraded.summary.billedRevenue, 125, "optional dimension failures must preserve current business results");
  assert.deepEqual(degraded.byTechnician, []);
  assert.equal(degraded.summary.attributedRevenue, null);

  let cancelled = false;
  const never = new Promise<any>(() => {}) as Promise<any> & { cancel?: () => void };
  never.cancel = () => { cancelled = true; };
  await assert.rejects(
    getReportingKpis(largeScope, normalizeReportingRange("2026-08-01", "2026-08-30"), {
      deadlineAt: Date.now() + 5,
      query: () => never,
    }),
    (error: unknown) => error instanceof ReportingQueryError && error.kind === "deadline",
  );
  assert.equal(cancelled, true, "deadline must cancel the active postgres-style pending query");

  const stageTimeouts: number[] = [];
  await getReportingKpis(largeScope, normalizeReportingRange("2026-08-01", "2026-08-30"), {
    deadlineAt: Date.now() + 1_000,
    beforeStage: async (remaining) => { stageTimeouts.push(remaining); },
    query: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    },
  });
  assert.equal(stageTimeouts.length, 3);
  assert.ok(stageTimeouts[1] < stageTimeouts[0] && stageTimeouts[2] < stageTimeouts[1], "each SQL stage gets only the shrinking remaining request budget");

  await assert.rejects(
    getReportingKpis(largeScope, normalizeReportingRange("2026-08-01", "2026-08-30"), {
      deadlineAt: Date.now() + 5,
      beforeStage: () => new Promise<void>(() => {}),
      query: async () => [],
    }),
    (error: unknown) => error instanceof ReportingQueryError && error.kind === "deadline" && error.stage === "business",
    "pool/statement setup work must not escape the absolute report deadline",
  );

  let lateQueries = 0;
  const acquisitionStarted = Date.now();
  await assert.rejects(
    getReportingKpis(largeScope, normalizeReportingRange("2026-08-01", "2026-08-30"), {
      deadlineAt: Date.now() + 5,
      transaction: async (work) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return work({
          query: async () => { lateQueries++; return []; },
          setStatementTimeout: async () => undefined,
        });
      },
    }),
    (error: unknown) => error instanceof ReportingQueryError && error.kind === "deadline" && error.stage === "database_queue",
  );
  assert.ok(Date.now() - acquisitionStarted < 20, "pool acquisition wait is bounded by the report deadline");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(lateQueries, 0, "a transaction acquired after deadline must not execute report SQL");
}

function testReportingIndexShapes() {
  const migration = readFileSync("drizzle/0034_reporting_query_indexes.sql", "utf8");
  assert.equal((migration.match(/CREATE INDEX CONCURRENTLY/g) || []).length, 4, "production reporting indexes must never block writes");
  assert.match(migration, /normalized_payments \(shop_id, work_order_id\)/);
  assert.match(migration, /normalized_service_jobs \(shop_id, work_order_id\)/);
  assert.match(migration, /recommendation_events \(shop_id, received_at\)/);
  assert.match(migration, /viewed_vins \(shop_id, last_viewed_at\)/);
  const closeDate = readFileSync("drizzle/0032_task1183_nwo_close_date_idx.sql", "utf8");
  assert.match(closeDate, /normalized_work_orders \(shop_id, \(COALESCE\(closed_date, completed_date\)\)\)/);
  const runner = readFileSync("scripts/apply-normalized-migration.ts", "utf8");
  assert.match(runner, /concurrentIndexMigrationFiles[\s\S]*0034_reporting_query_indexes\.sql/);
  assert.match(runner, /for \(const statement of statements\)[\s\S]*sql\.unsafe\(statement\)/);
  const verifier = readFileSync("scripts/verify-reporting-query-readiness.ts", "utf8");
  assert.match(verifier, /default_transaction_read_only = on/);
  assert.match(verifier, /work_order_range/);
  assert.match(verifier, /payment_parent_join/);
  assert.match(verifier, /RECOMMENDED_INDEXES/);
  assert.match(verifier, /OPTIONAL_MISSING/);
  assert.match(verifier, /REPORTING_DATABASE_SCHEMA \|\| "public"/);
  assert.match(verifier, /indisvalid/);
  assert.match(verifier, /indisready/);
  assert.ok(verifier.includes('.replaceAll(`${schema}.`, "")'));
  assert.match(verifier, /expectedShapes\.some\(\(shape\) => row\.normalizedDefinition\.includes\(shape\)\)/);
  assert.doesNotMatch(verifier, /CREATE\s+(?:UNIQUE\s+)?INDEX/i, "readiness verification must never apply production indexes");
}

Promise.resolve()
  .then(testServicePipeline)
  .then(testBoundedExecution)
  .then(testReportingIndexShapes)
  .then(() => console.log("reporting KPI foundation smoke: ALL PASS"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
