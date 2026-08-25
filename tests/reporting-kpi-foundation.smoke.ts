import assert from "node:assert/strict";
import {
  UNKNOWN_DIMENSION_KEY,
  finalizeMetrics,
  providerMoneyToDollars,
  restrictToAssignedShops,
  safeRate,
} from "../lib/reporting-kpi-contract";
import {
  getReportingKpis,
  normalizeReportingRange,
} from "../lib/reporting-kpi-service";

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
  assert.match(queries[0], /MATERIALIZED/, "business facts must be shared per query");
  assert.match(queries[0], /GROUPING SETS.*advisor_key/s, "advisor names must not split stable IDs");
  assert.doesNotMatch(queries[1], /GROUP BY shop_id, technician_id, technician_name/);
  assert.match(queries[1], /array_agg.*technician_name.*basis_date DESC/s);
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
  assert.equal(report.dataQuality.dimensionsTruncated, true);
}

testServicePipeline()
  .then(() => console.log("reporting KPI foundation smoke: ALL PASS"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
