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
    overdue: [{ title: "Engine Oil & Filter Replace", serviceKey: "engine_oil" }],
    dueSoon: [{ title: "Cabin Air Filter Replace", serviceKey: "cabin_air_filter" }],
  });
  ok("flattens both buckets", items.length === 2);
  ok("stamps overdue status", items[0].status === "overdue");
  ok("stamps due_soon status", items[1].status === "due_soon");
  ok("null-safe", planItemsFromBuckets(null).length === 0);
  ok(
    "missing arrays tolerated",
    planItemsFromBuckets({ overdue: null, dueSoon: undefined }).length === 0,
  );
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
