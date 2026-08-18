/**
 * Unit tests for the RO-line ↔ VHI matcher used by the Estimate Assist audit
 * (`lib/estimate-assist/vhi-audit-match.ts`, Task #1145).
 *
 * Run: `npx tsx tests/estimate-audit-vhi-match.smoke.ts`
 *
 * Covers:
 *  - Canonical service-key match (differently-worded titles for same service)
 *  - Normalized-token fallback (both containment directions)
 *  - Declined jobs on the ticket count as quoted (lines passed in are enough)
 *  - Inspection-only items (inspectOnly flag OR inspect-verb title) never flagged
 *  - misc_ serviceKeys don't cross-match
 *  - Missing items carry status/dueAtMiles/dueAtDate
 *  - Finding conversion: severity mapping, category, ids, score integration
 */
import {
  findMissingVhiItems,
  buildMissingVhiFindings,
  isInspectOnlyVhiItem,
  VHI_FINDING_CATEGORY,
  type VhiComparisonItem,
} from "../lib/estimate-assist/vhi-audit-match";
import { dedupeAndSortFindings, summarizeFindings } from "../lib/estimate-assist/audit-engine";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("Service-key matching:");
{
  const items: VhiComparisonItem[] = [
    { title: "Engine Oil & Filter Replace", serviceKey: "engine_oil", status: "overdue" },
    { title: "Cabin Air Filter Replace", serviceKey: "cabin_air_filter", status: "due_soon" },
  ];
  // Differently-worded oil change on the ticket should match by service key.
  const missing = findMissingVhiItems(["Full Synthetic Oil Change"], items);
  ok("oil item matched via canonical key", !missing.some(m => m.title.includes("Oil")));
  ok("cabin filter flagged as missing", missing.some(m => m.title.includes("Cabin")));
}

console.log("Token fallback matching:");
{
  const items: VhiComparisonItem[] = [
    { title: "Serpentine Belt", serviceKey: "misc_serp", status: "overdue" },
  ];
  const hit = findMissingVhiItems(["Replace Serpentine Belt and Tensioner"], items);
  ok("token-subset (item ⊆ line) counts as quoted", hit.length === 0);
  const miss = findMissingVhiItems(["Wheel Alignment"], items);
  ok("unrelated line does not match", miss.length === 1);
}

console.log("Declined jobs count as quoted:");
{
  const items: VhiComparisonItem[] = [
    { title: "Brake Fluid Exchange", serviceKey: "brake_fluid", status: "overdue" },
  ];
  // A declined job is still a line on the ticket — caller includes its title.
  const missing = findMissingVhiItems(["Brake Fluid Flush (declined)"], items);
  ok("declined-but-present job suppresses the flag", missing.length === 0);
}

console.log("Inspection-only exclusion:");
{
  const flagged: VhiComparisonItem = { title: "Transfer Case Fluid", serviceKey: "transfer_case", status: "overdue", inspectOnly: true };
  const verb: VhiComparisonItem = { title: "Inspect Brake Lines", serviceKey: "misc_brake_lines", status: "overdue" };
  const action: VhiComparisonItem = { title: "Coolant", serviceKey: "coolant", status: "overdue", action: "inspect" };
  ok("inspectOnly flag excluded", isInspectOnlyVhiItem(flagged));
  ok("inspect verb in title excluded", isInspectOnlyVhiItem(verb));
  ok("action=inspect excluded", isInspectOnlyVhiItem(action));
  const missing = findMissingVhiItems([], [flagged, verb, action, { title: "Spark Plugs Replace", serviceKey: "spark_plugs", status: "overdue" }]);
  ok("only the replace item flagged", missing.length === 1 && missing[0].title.includes("Spark"));
}

console.log("Missing-item payload:");
{
  const items: VhiComparisonItem[] = [
    { title: "Transmission Fluid Exchange", serviceKey: "transmission_fluid", status: "due_soon", dueAtMiles: 90000, dueAtDate: "2026-09-01T00:00:00.000Z" },
  ];
  const missing = findMissingVhiItems(["Oil Change"], items);
  ok("carries status", missing[0]?.status === "due_soon");
  ok("carries dueAtMiles", missing[0]?.dueAtMiles === 90000);
  ok("carries dueAtDate", missing[0]?.dueAtDate === "2026-09-01T00:00:00.000Z");
  ok("carries serviceKey", missing[0]?.serviceKey === "transmission_fluid");
}

console.log("Empty inputs:");
{
  ok("no plan items → no flags", findMissingVhiItems(["Oil Change"], []).length === 0);
  ok("blank titles ignored", findMissingVhiItems(["", null as any], [{ title: "Spark Plugs Replace", serviceKey: "spark_plugs", status: "overdue" }]).length === 1);
  ok("blank plan title ignored", findMissingVhiItems([], [{ title: "", status: "overdue" }]).length === 0);
}

console.log("Finding conversion:");
{
  const findings = buildMissingVhiFindings(
    [
      { title: "Spark Plugs Replace", serviceKey: "spark_plugs", status: "overdue", dueAtMiles: 60000, dueAtDate: null },
      { title: "Coolant Exchange", serviceKey: "coolant", status: "due_soon", dueAtMiles: null, dueAtDate: null },
    ],
    3,
  );
  ok("overdue → warning", findings[0].severity === "warning");
  ok("due soon → info", findings[1].severity === "info");
  ok("shared category", findings.every(f => f.category === VHI_FINDING_CATEGORY));
  ok("ids continue from startId", findings[0].id === "f-4" && findings[1].id === "f-5");
  ok("suggestedJobTitle set for Add/Build buttons", findings[0].suggestedJobTitle === "Spark Plugs Replace");
  ok("due mileage in description", findings[0].description.includes("60,000 mi"));

  // Existing dedupe + score pipeline folds them in unchanged.
  const deduped = dedupeAndSortFindings([...findings, ...findings]);
  ok("dedupe collapses repeats", deduped.length === 2);
  const summary = summarizeFindings(deduped);
  ok("score math folds in (100 - 5 - 1)", summary.score === 94, `got ${summary.score}`);
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll estimate-audit-vhi-match tests passed");
