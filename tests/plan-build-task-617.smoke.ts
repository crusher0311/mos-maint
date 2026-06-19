/**
 * Task #617 regression: a PERFORMED automatic transmission fluid service must
 * anchor the OEM "Replace automatic transmission / transaxle fluid." interval
 * instead of showing "No record of this service being performed".
 *
 * Confirmed bug: V&F Auto (shopId 116), 2013 Kia Sportage VIN
 * KNDPCCA28D7449009. The shop performed "Automatic Transmission Fluid Service"
 * on 6/13/2023 @ 150,923 mi (present in job_index, correct VIN, not declined).
 * That title maps cleanly to `trans_auto` via toKeyFromFreeText. BUT the
 * DataOne OEM item is named "Replace automatic transmission / transaxle
 * fluid." — and toKeyFromName returned `null` for it (the "/ transaxle" insert
 * splits the "transmission ... fluid" substring, and "transaxle" was handled
 * nowhere). The OEM row therefore became `misc_287`, the trans_auto anchor
 * never attached, and the plan reported the paid-for service as never done +
 * overdue.
 *
 * This smoke locks in:
 *   1. toKeyFromName recognizes the DataOne transaxle phrasing as trans_auto,
 *      and routes a MANUAL transaxle to trans_manual (no auto/manual mixups).
 *   2. A bare transaxle unit R&R (no fluid/flush/service verb) still maps to
 *      null so a transaxle replacement is not treated as a fluid anchor.
 *   3. End-to-end: the performed service anchors the OEM trans interval — the
 *      item carries a `last` and is NOT reported as overdue/never-done.
 *
 * Run: `npx tsx tests/plan-build-task-617.smoke.ts`
 */

import { toKeyFromName, toKeyFromFreeText } from "../lib/service-keys";
import { triage, type OEMItem, type ShopServiceHistory } from "../lib/plan-build/triage";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  \u2713 ${name}`);
  else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Plan-build task #617 transaxle-fluid anchor smoke checks");

// ---------------------------------------------------------------------------
// Layer 1: key mapping
// ---------------------------------------------------------------------------
ok(
  "DataOne OEM 'Replace automatic transmission / transaxle fluid.' -> trans_auto",
  toKeyFromName("Replace automatic transmission / transaxle fluid.") === "trans_auto",
  String(toKeyFromName("Replace automatic transmission / transaxle fluid.")),
);
ok(
  "performed RO title 'Automatic Transmission Fluid Service' -> trans_auto",
  toKeyFromFreeText("Automatic Transmission Fluid Service").includes("trans_auto"),
);
ok(
  "manual transaxle fluid -> trans_manual (auto/manual not mixed up)",
  toKeyFromName("Replace manual transaxle fluid") === "trans_manual",
  String(toKeyFromName("Replace manual transaxle fluid")),
);
ok(
  "bare transaxle unit R&R stays null (not a fluid anchor)",
  toKeyFromName("Replace transaxle") === null,
  String(toKeyFromName("Replace transaxle")),
);
ok(
  "'Replace automatic transaxle' (no fluid verb) stays null - unit R&R, not fluid",
  toKeyFromName("Replace automatic transaxle") === null,
  String(toKeyFromName("Replace automatic transaxle")),
);
ok(
  "freeText 'Replace manual transaxle' (no fluid verb) yields no trans key",
  !toKeyFromFreeText("Replace manual transaxle").some((k) => k.startsWith("trans_")),
  JSON.stringify(toKeyFromFreeText("Replace manual transaxle")),
);
ok(
  "freeText transaxle phrasing also resolves to trans_auto",
  toKeyFromFreeText("Automatic Transaxle Fluid Exchange").includes("trans_auto"),
);

// ---------------------------------------------------------------------------
// Layer 2: end-to-end anchor behavior through triage
// ---------------------------------------------------------------------------
// Mirrors the Kia Sportage: trans fluid performed at 150,923 mi on 6/13/2023,
// 60k-mile OEM interval, current odometer 165,270 (only ~14k since service, so
// the item must NOT be overdue and must carry a `last`).
const shopServiceHistory: ShopServiceHistory[] = [
  {
    serviceName: "Automatic Transmission Fluid Service",
    mileage: 150923,
    date: new Date("2023-06-13T00:00:00Z"),
  },
];

const transOem: OEMItem = {
  maintenance_id: 287,
  name: "Replace automatic transmission / transaxle fluid.",
  category: "Transmission",
  miles: 60000,
  months: null as any,
  intervals: [{ units: "Miles", value: 60000 }],
  notes: null,
} as any;

const buckets = triage({
  oemItems: [transOem],
  carfaxRecords: [],
  carfaxCategories: [],
  shopServiceHistory,
  currentMiles: 165270,
  today: new Date("2025-07-02T00:00:00Z"),
  dviFindings: [],
  vehicleYear: 2013,
});

const allRows = [
  ...(buckets.overdue || []),
  ...((buckets as any).dueSoon || []),
  ...(buckets.upcoming || []),
];

const transRow = allRows.find((r: any) => r.serviceKey === "trans_auto");
ok(
  "OEM trans item resolved to trans_auto serviceKey (not misc_*)",
  !!transRow,
  `serviceKeys: ${allRows.map((r: any) => r.serviceKey).join(", ")}`,
);
ok(
  "performed service anchored the trans interval (last is set, not 'no record')",
  !!transRow && !!transRow.last && transRow.last.miles === 150923,
  JSON.stringify(transRow?.last),
);
ok(
  "trans item is NOT overdue (only ~14k mi since a 60k-mi service)",
  !(buckets.overdue || []).some((r: any) => r.serviceKey === "trans_auto"),
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll task #617 checks passed");
process.exit(0);
