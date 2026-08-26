/**
 * Unit tests for the Missed Opportunities report logic (Task #1146,
 * `lib/missed-opportunities.ts`).
 *
 * Run: `npx tsx tests/missed-opportunities.smoke.ts`
 *
 * Covers:
 *  - Quoted vs declined vs missing: any line title on the ticket (declined
 *    included) suppresses the missed flag; absent items are flagged.
 *  - Inspection-only VHI items are never counted as missed.
 *  - planItemsFromBuckets: overdue/dueSoon flattening + status stamping,
 *    upcoming excluded, null-safe.
 *  - No-VIN / no-plan handling shape (not-evaluated rows excluded from stats).
 *  - Summary-stat math regression: counts, missedPct over EVALUATED rows
 *    only, top-missed grouping by serviceKey with title fallback, ordering.
 *  - normalizeWindowDays clamping.
 */
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildCloseDateSincePredicate } from "../lib/missed-opportunities-query";
import {
  planItemsFromBuckets,
  evaluateRoLines,
  summarizeMissedOpportunities,
  normalizeWindowDays,
  classifyTicketJobStatus,
  normalizeTicketJobAmount,
  formatTicketJobAmount,
  sumTicketJobAmounts,
  normalizeMissedOpportunityReportCache,
  hasCurrentMissedOpportunityReportShape,
  MISSED_OPPORTUNITY_REPORT_VERSION,
  evaluateMissedOpportunityRecommendations,
  missedItemsFromRecommendations,
  type MissedOpportunityRo,
  type MissedOpportunityReport,
  type VhiComparisonItem,
} from "../lib/missed-opportunities";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("planItemsFromBuckets:");
{
  const items = planItemsFromBuckets({
    overdue: [{
      title: "Engine Oil & Filter Replace",
      serviceKey: "engine_oil",
      source: "dvi",
      dviSource: "tekmetric",
      bump: "red",
    }],
    dueSoon: [{
      title: "Cabin Air Filter Replace",
      serviceKey: "cabin_air_filter",
      source: "dvi",
      dviSource: "autoflow",
      bump: "yellow",
    }],
  });
  ok("flattens both buckets", items.length === 2);
  ok("stamps overdue status", items[0].status === "overdue");
  ok("stamps due_soon status", items[1].status === "due_soon");
  ok(
    "preserves red DVI provenance",
    items[0].source === "dvi" && items[0].dviSource === "tekmetric" && items[0].bump === "red",
  );
  ok(
    "preserves yellow DVI provenance",
    items[1].source === "dvi" && items[1].dviSource === "autoflow" && items[1].bump === "yellow",
  );
  ok("null-safe", planItemsFromBuckets(null).length === 0);
  ok(
    "missing arrays tolerated",
    planItemsFromBuckets({ overdue: null, dueSoon: undefined }).length === 0,
  );
}

console.log("Recommendation outcomes, matching, and dedupe:");
{
  const planItems: VhiComparisonItem[] = [
    {
      title: "Brake Fluid Exchange",
      serviceKey: "brake_fluid",
      status: "overdue",
    },
    {
      title: "Brake Fluid Flush",
      serviceKey: "brake_fluid",
      status: "overdue",
      source: "dvi",
      dviSource: "tekmetric",
      bump: "red",
    },
    {
      title: "Cabin Air Filter Replace",
      serviceKey: "cabin_air_filter",
      status: "due_soon",
      source: "dvi",
      bump: "yellow",
    },
    {
      title: "Coolant Exchange",
      serviceKey: "coolant",
      status: "overdue",
    },
    {
      title: "Transmission Fluid Exchange",
      serviceKey: "transmission_fluid",
      status: "overdue",
    },
  ];
  const recommendations = evaluateMissedOpportunityRecommendations(
    [
      {
        title: "Brake Fluid Flush",
        recordedStatus: "declined",
        displayGroup: "deferred_declined",
        totalPrice: "89.95",
      },
      {
        title: "Brake Fluid Service",
        recordedStatus: "completed",
        displayGroup: "approved_performed",
        totalPrice: "109.95",
      },
      {
        title: "Cabin Filter",
        recordedStatus: "deferred",
        displayGroup: "deferred_declined",
        totalPrice: "0",
      },
      {
        title: "Coolant Flush",
        recordedStatus: "declined",
        displayGroup: "deferred_declined",
        totalPrice: null,
      },
    ],
    planItems,
  );
  ok("DVI + VHI canonical service counts once", recommendations.length === 4);
  const brake = recommendations.find((r) => r.serviceKey === "brake_fluid");
  ok("deduped provenance is both", brake?.source === "both");
  ok("performed takes precedence over deferred", brake?.outcome === "invoiced_performed");
  ok("winning matched price is attached", brake?.recordedPrice === "109.95");
  const cabin = recommendations.find((r) => r.serviceKey === "cabin_air_filter");
  ok("DVI-only source retained", cabin?.source === "dvi");
  ok("deferred recommendation classified", cabin?.outcome === "deferred_declined");
  ok("explicit zero price preserved", cabin?.recordedPrice === "0.00");
  const coolant = recommendations.find((r) => r.serviceKey === "coolant");
  ok("missing recorded price remains null", coolant?.recordedPrice === null);
  const transmission = recommendations.find((r) => r.serviceKey === "transmission_fluid");
  ok("unmatched recommendation is not quoted", transmission?.outcome === "not_quoted");
  ok("unmatched recommendation has no price", transmission?.recordedPrice === null);
  const overlay = evaluateMissedOpportunityRecommendations([], [{
    title: "Engine Air Filter Replace",
    serviceKey: "engine_air_filter",
    status: "due_soon",
    source: "oem",
    dviSource: "autoflow",
    bump: "yellow",
  }])[0];
  ok("single VHI row with a DVI marker is both", overlay?.source === "both");
  ok("DVI severity survives recommendation modeling", overlay?.dviSeverity === "yellow");
  const urgencyOnly = evaluateMissedOpportunityRecommendations([], [{
    title: "Rear Differential Fluid",
    serviceKey: "differential_rear",
    status: "overdue",
    source: "oem",
    bump: "red",
  }])[0];
  ok("ordinary red VHI urgency is not labeled DVI", urgencyOnly?.source === "vhi");
  ok("ordinary VHI urgency has no DVI severity", urgencyOnly?.dviSeverity === null);
  ok("ordinary VHI urgency has no DVI provider", urgencyOnly?.dviSource === null);
  for (const [label, overlayItems] of [
    [
      "VHI first",
      [
        {
          title: "Rear Differential Fluid",
          serviceKey: "differential_rear",
          status: "overdue",
          source: "oem",
          bump: "red",
        },
        {
          title: "Rear Differential Fluid Service",
          serviceKey: "differential_rear",
          status: "overdue",
          source: "dvi",
        },
      ],
    ],
    [
      "DVI first",
      [
        {
          title: "Rear Differential Fluid Service",
          serviceKey: "differential_rear",
          status: "overdue",
          source: "dvi",
        },
        {
          title: "Rear Differential Fluid",
          serviceKey: "differential_rear",
          status: "overdue",
          source: "oem",
          bump: "red",
        },
      ],
    ],
  ] as const) {
    const merged = evaluateMissedOpportunityRecommendations(
      [],
      overlayItems as unknown as VhiComparisonItem[],
    )[0];
    ok(`${label}: explicit DVI + VHI merges to both`, merged?.source === "both");
    ok(`${label}: VHI urgency does not become DVI severity`, merged?.dviSeverity === null);
    ok(`${label}: missing DVI provider remains null`, merged?.dviSource === null);
  }
  const inspectedLeak = evaluateMissedOpportunityRecommendations(
    [{
      title: "Power Steering Fluid Leak Inspection",
      recordedStatus: "completed",
      displayGroup: "approved_performed",
      totalPrice: "49.95",
    }],
    [{
      title: "Power Steering Fluid",
      serviceKey: "power_steering_fluid",
      status: "overdue",
    }],
  )[0];
  ok("fluid leak inspection is not counted as fluid service", inspectedLeak?.outcome === "not_quoted");
  ok("inspection price is not attributed to service", inspectedLeak?.recordedPrice === null);
  const missed = missedItemsFromRecommendations(recommendations);
  ok("legacy missed excludes performed", !missed.some((m) => m.serviceKey === "brake_fluid"));
  ok("legacy missed includes deferred and unquoted", missed.length === 3);

  const summary = summarizeMissedOpportunities([
    row({ recommendations, missedItems: missed }),
  ]);
  const sourceCount = Object.values(summary.recommendationsBySource)
    .reduce((total, rollup) => total + rollup.count, 0);
  const outcomeCount = Object.values(summary.recommendationsByOutcome)
    .reduce((total, rollup) => total + rollup.count, 0);
  ok("source rollups reconcile", sourceCount === summary.totalRecommendations);
  ok("outcome rollups reconcile", outcomeCount === summary.totalRecommendations);
  ok("source subtotal is exact", summary.recommendationsBySource.both.recordedDollarSubtotal === "109.95");
  ok("outcome subtotal includes explicit zero", summary.recommendationsByOutcome.deferred_declined.recordedDollarSubtotal === "0.00");
  ok("unavailable prices counted", summary.recommendationsByOutcome.deferred_declined.unavailableCount === 1);
  ok("unmatched unavailable counted", summary.recommendationsByOutcome.not_quoted.unavailableCount === 1);
}

console.log("Quoted vs declined vs missing:");
{
  const planItems: VhiComparisonItem[] = [
    { title: "Engine Oil & Filter Replace", serviceKey: "engine_oil", status: "overdue" },
    { title: "Brake Fluid Exchange", serviceKey: "brake_fluid", status: "overdue" },
    { title: "Cabin Air Filter Replace", serviceKey: "cabin_air_filter", status: "due_soon" },
  ];
  // Oil change quoted; brake fluid DECLINED but still a line on the ticket;
  // cabin filter absent entirely.
  const missed = evaluateRoLines(
    ["Full Synthetic Oil Change", "Brake Fluid Flush (declined)"],
    planItems,
  );
  ok("quoted item not missed", !missed.some((m) => m.serviceKey === "engine_oil"));
  ok("declined line counts as quoted", !missed.some((m) => m.serviceKey === "brake_fluid"));
  ok("absent item flagged missed", missed.some((m) => m.serviceKey === "cabin_air_filter"));
  ok("exactly one missed", missed.length === 1);
  ok("missed carries status", missed[0].status === "due_soon");
}

console.log("Ticket-job classification and amounts:");
{
  ok("authorized is approved/performed", classifyTicketJobStatus("authorized") === "approved_performed");
  ok("completed is approved/performed", classifyTicketJobStatus("Completed") === "approved_performed");
  ok("provider spacing is normalized", classifyTicketJobStatus("in progress") === "approved_performed");
  ok("declined is deferred/declined", classifyTicketJobStatus("declined") === "deferred_declined");
  ok("deferred is deferred/declined", classifyTicketJobStatus("DEFERRED") === "deferred_declined");
  ok("ambiguous status remains other", classifyTicketJobStatus("pending") === "other");
  ok("missing status remains other", classifyTicketJobStatus(null) === "other");

  ok("decimal string preserved", normalizeTicketJobAmount("1234.5") === "1234.50");
  ok("zero preserved", normalizeTicketJobAmount("0.00") === "0.00");
  ok("negative zero normalized", normalizeTicketJobAmount("-0") === "0.00");
  ok("invalid amount unavailable", normalizeTicketJobAmount("not recorded") === null);
  ok("over-precise amount not rounded", normalizeTicketJobAmount("12.345") === null);
  ok(
    "large decimal formats without floating-point coercion",
    formatTicketJobAmount("90071992547409.99") === "$90,071,992,547,409.99",
  );
  ok("zero formats as currency", formatTicketJobAmount("0.00") === "$0.00");
  const subtotal = sumTicketJobAmounts([
    { totalPrice: "0.10" },
    { totalPrice: "0.20" },
    { totalPrice: "1000.00" },
  ]);
  ok("subtotal is decimal exact", subtotal.total === "1000.30", subtotal.total);
  ok("known subtotal is complete", subtotal.hasUnavailable === false);
  const partialSubtotal = sumTicketJobAmounts([
    { totalPrice: "12.34" },
    { totalPrice: null },
  ]);
  ok("unavailable price excluded from subtotal", partialSubtotal.total === "12.34");
  ok("subtotal reports unavailable member", partialSubtotal.hasUnavailable === true);
  const serialized = JSON.parse(JSON.stringify({ totalPrice: normalizeTicketJobAmount("1234567890.12") }));
  ok("JSON serialization retains decimal string", serialized.totalPrice === "1234567890.12");
}

console.log("Inspection exclusion:");
{
  const planItems: VhiComparisonItem[] = [
    { title: "Inspect Brake Lines", serviceKey: null, status: "overdue" },
    { title: "Coolant Exchange", serviceKey: "coolant", status: "overdue", inspectOnly: true },
    { title: "Transmission Fluid Exchange", serviceKey: "transmission_fluid", status: "overdue" },
  ];
  const missed = evaluateRoLines(["Rotate Tires"], planItems);
  ok("inspect-verb item excluded", !missed.some((m) => m.title === "Inspect Brake Lines"));
  ok("inspectOnly flag excluded", !missed.some((m) => m.serviceKey === "coolant"));
  ok("real replace item still flagged", missed.some((m) => m.serviceKey === "transmission_fluid"));
}

function row(partial: Partial<MissedOpportunityRo>): MissedOpportunityRo {
  return {
    workOrderId: partial.workOrderId || Math.random().toString(36).slice(2),
    workOrderNumber: partial.workOrderNumber || "1001",
    closedDate: partial.closedDate ?? "2026-08-01T00:00:00.000Z",
    vin: partial.vin ?? "1HGCM82633A004352",
    vehicle: partial.vehicle ?? "2019 Honda Accord",
    advisorName: partial.advisorName ?? null,
    lineTitleCount: partial.lineTitleCount ?? 3,
    ticketJobs: partial.ticketJobs ?? [],
    evaluated: partial.evaluated ?? true,
    skipReason: partial.skipReason ?? null,
    missedItems: partial.missedItems ?? [],
    recommendations: partial.recommendations ?? [],
  };
}

console.log("Cached report compatibility:");
{
  const baseReport: Omit<MissedOpportunityReport, "reportVersion"> = {
    shopId: 42,
    windowDays: 30,
    generatedAt: "2026-08-25T12:00:00.000Z",
    summary: summarizeMissedOpportunities([row({})]),
    rows: [row({})],
    notEvaluated: [],
    truncated: false,
  };
  const legacy: any = {
    ...baseReport,
    rows: baseReport.rows.map(({ ticketJobs: _ticketJobs, ...rest }) => rest),
  };
  const compatible = normalizeMissedOpportunityReportCache(legacy);
  ok("legacy report is not current", !hasCurrentMissedOpportunityReportShape(legacy));
  ok("legacy report version is explicit", compatible.reportVersion === 1);
  ok("legacy row gets unavailable marker", compatible.rows[0]?.ticketJobs === null);

  const current: MissedOpportunityReport = {
    ...baseReport,
    reportVersion: MISSED_OPPORTUNITY_REPORT_VERSION,
  };
  ok("current report shape accepted", hasCurrentMissedOpportunityReportShape(current));
  const oldRowShape = {
    ...current,
    rows: current.rows.map(({ recommendations: _recommendations, ...rest }) => rest),
  };
  ok(
    "current version without recommendations is invalidated",
    !hasCurrentMissedOpportunityReportShape(oldRowShape),
  );
  const oldSummaryShape = {
    ...current,
    summary: { ...current.summary, totalRecommendations: undefined },
  };
  ok(
    "current version without recommendation summary is invalidated",
    !hasCurrentMissedOpportunityReportShape(oldSummaryShape),
  );
  const normalizedCurrent = normalizeMissedOpportunityReportCache(current);
  ok("current ticket jobs retained", Array.isArray(normalizedCurrent.rows[0]?.ticketJobs));
}

console.log("Summary-stat math:");
{
  const mk = (key: string | null, title: string) => ({
    title,
    serviceKey: key,
    status: "overdue" as const,
    dueAtMiles: null,
    dueAtDate: null,
  });
  const rows: MissedOpportunityRo[] = [
    row({ missedItems: [mk("engine_oil", "Oil Change"), mk("coolant", "Coolant Exchange")] }),
    row({ missedItems: [mk("engine_oil", "Engine Oil & Filter Replace")] }),
    row({ missedItems: [] }), // evaluated, clean
    row({ evaluated: false, vin: null, skipReason: "No VIN on the repair order" }),
    row({ evaluated: false, skipReason: "No cached VHI plan for this vehicle" }),
  ];
  const s = summarizeMissedOpportunities(rows);
  ok("totalClosedRos counts all rows", s.totalClosedRos === 5);
  ok("evaluatedRos excludes skips", s.evaluatedRos === 3);
  ok("notEvaluatedRos", s.notEvaluatedRos === 2);
  ok("rosWithMissedItems", s.rosWithMissedItems === 2);
  ok("missedPct over evaluated only", s.missedPct === 66.7, `got ${s.missedPct}`);
  ok("totalMissedItems", s.totalMissedItems === 3);
  ok(
    "top missed groups by serviceKey across differing titles",
    s.topMissedServices[0]?.serviceKey === "engine_oil" && s.topMissedServices[0]?.count === 2,
  );
  ok("second-place count", s.topMissedServices[1]?.count === 1);

  // Null-key items group by lowercased title.
  const s2 = summarizeMissedOpportunities([
    row({ missedItems: [mk(null, "Wiper Blades"), mk(null, "wiper blades")] }),
  ]);
  ok("null-key groups by title", s2.topMissedServices.length === 1 && s2.topMissedServices[0].count === 2);

  // Empty input.
  const s3 = summarizeMissedOpportunities([]);
  ok("empty input → zeroed summary", s3.totalClosedRos === 0 && s3.missedPct === 0);
}

console.log("Window normalization:");
{
  ok("7 allowed", normalizeWindowDays("7") === 7);
  ok("30 allowed", normalizeWindowDays(30) === 30);
  ok("90 allowed", normalizeWindowDays("90") === 90);
  ok("unknown → 30", normalizeWindowDays("14") === 30);
  ok("garbage → 30", normalizeWindowDays("abc") === 30);
  ok("null → 30", normalizeWindowDays(null) === 30);
}

console.log("Window-filter parameter binding (Task #1180 regression):");
{
  // The closed-at expression is a raw sql`` coalesce, so drizzle has no
  // column encoder for the comparison's right-hand side. If a raw JS Date
  // is ever bound as the param again, postgres-js throws
  // ERR_INVALID_ARG_TYPE and every report compute 500s. Guard: the built
  // query must bind ONLY string params (ISO date), never a Date instance.
  const closeDate = sql<Date | null>`coalesce("closed_date", "completed_date")`;
  const since = new Date("2026-08-01T00:00:00.000Z");
  const predicate = buildCloseDateSincePredicate(closeDate, since);
  const q = new PgDialect().sqlToQuery(predicate);
  ok("exactly one bound param", q.params.length === 1, `got ${q.params.length}`);
  ok(
    "param is an ISO string, not a Date",
    typeof q.params[0] === "string" && q.params[0] === since.toISOString(),
    `got ${typeof q.params[0]}: ${String(q.params[0])}`,
  );
  ok(
    "no Date instance among params",
    !q.params.some((p) => p instanceof Date),
  );
  ok(
    "SQL casts the param to timestamptz",
    /::timestamptz/.test(q.sql),
    q.sql,
  );
  ok(
    "SQL compares coalesce >= param",
    /coalesce\("closed_date", "completed_date"\) >= \$1/.test(q.sql),
    q.sql,
  );
}

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll missed-opportunities tests passed.");
