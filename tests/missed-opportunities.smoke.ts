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
import {
  planItemsFromBuckets,
  evaluateRoLines,
  summarizeMissedOpportunities,
  normalizeWindowDays,
  type MissedOpportunityRo,
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
    evaluated: partial.evaluated ?? true,
    skipReason: partial.skipReason ?? null,
    missedItems: partial.missedItems ?? [],
  };
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

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll missed-opportunities tests passed.");
