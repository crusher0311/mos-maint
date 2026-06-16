/**
 * Task #608 regression: DECLINED (unauthorized) jobs must NEVER become a
 * "last done" maintenance anchor.
 *
 * Confirmed bug: International Auto (shopId 100), RO #14489 Camry. A prior
 * Posted RO (#14286) had a DECLINED spark-plug job. The plan builder treated
 * that declined line as performed service, anchored the spark-plug interval to
 * it, and reset the clock — so spark plugs wrongly showed up-to-date.
 *
 * This smoke locks in two layers of the fix:
 *
 *   1. `isDeclinedJobIndexRow` correctly classifies declined rows across
 *      providers (Tekmetric `authorized:false`, Protractor `isDeferred:true`,
 *      Shop-Ware non-completed `status`), while legacy rows with no flag stay
 *      treated as performed (conservative — no silent history loss).
 *
 *   2. The job_index reader filter (mirroring app/api/plan-build/route.ts)
 *      drops declined rows, so triage anchors the spark-plug interval ONLY to
 *      a genuinely performed job. The declined spark-plug RO must not reset the
 *      clock; spark plugs stay overdue.
 *
 * Run: `npx tsx tests/plan-build-task-608.smoke.ts`
 */

import { isDeclinedJobIndexRow } from "../lib/job-index";
import { triage, type OEMItem, type ShopServiceHistory } from "../lib/plan-build/triage";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  \u2713 ${name}`);
  else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Plan-build task #608 declined-job anchor smoke checks");

// ---------------------------------------------------------------------------
// Layer 1: classifier
// ---------------------------------------------------------------------------
ok(
  "Tekmetric authorized:false is declined",
  isDeclinedJobIndexRow({ sourceSystem: "tekmetric", authorized: false }) === true,
);
ok(
  "Tekmetric authorized:true is performed",
  isDeclinedJobIndexRow({ sourceSystem: "tekmetric", authorized: true }) === false,
);
ok(
  "Legacy row with NO authorization flag stays performed (conservative)",
  isDeclinedJobIndexRow({ sourceSystem: "tekmetric", jobName: "Oil Change" }) === false,
);
ok(
  "Protractor isDeferred:true is declined",
  isDeclinedJobIndexRow({ provider: "protractor", isDeferred: true }) === true,
);
ok(
  "Shop-Ware open status is declined/unperformed",
  isDeclinedJobIndexRow({ provider: "shopware", status: "open" }) === true,
);
ok(
  "Shop-Ware completed status is performed",
  isDeclinedJobIndexRow({ provider: "shopware", status: "completed" }) === false,
);
ok("null row is not declined", isDeclinedJobIndexRow(null) === false);

// ---------------------------------------------------------------------------
// Layer 2: end-to-end anchor behavior through triage
// ---------------------------------------------------------------------------
// Simulated job_index rows for the offending Posted RO #14286 on the Camry:
// one AUTHORIZED oil change (performed) + a DECLINED spark-plug job. Both share
// the same RO mileage. Before the fix, the declined spark-plug row reset the
// 100k-mile spark-plug interval.
const ROW_MILEAGE = 95000;
const jobIndexRows = [
  {
    sourceSystem: "tekmetric",
    workOrderId: "14286",
    servicePackageId: "oil-1",
    jobName: "Full Synthetic Oil Change",
    authorized: true,
    mileage: ROW_MILEAGE,
    performedAt: new Date("2025-09-01T00:00:00Z"),
  },
  {
    sourceSystem: "tekmetric",
    workOrderId: "14286",
    servicePackageId: "plug-1",
    jobName: "Replace Spark Plugs",
    authorized: false, // customer DECLINED this — must not anchor
    mileage: ROW_MILEAGE,
    performedAt: new Date("2025-09-01T00:00:00Z"),
  },
];

// Build shop history exactly as app/api/plan-build/route.ts does: skip declined
// rows via isDeclinedJobIndexRow, then push the rest as performed service.
const shopServiceHistory: ShopServiceHistory[] = [];
for (const ji of jobIndexRows) {
  if (isDeclinedJobIndexRow(ji)) continue;
  shopServiceHistory.push({
    serviceName: ji.jobName,
    mileage: ji.mileage,
    date: ji.performedAt,
  });
}

ok(
  "declined spark-plug row filtered out of shop history",
  shopServiceHistory.length === 1 &&
    /oil/i.test(shopServiceHistory[0].serviceName),
  JSON.stringify(shopServiceHistory),
);

const today = new Date("2026-06-16T00:00:00Z");
const sparkPlugOem: OEMItem = {
  maintenance_id: 100,
  name: "Replace spark plugs",
  category: "Engine",
  miles: 100000,
  months: null as any,
  intervals: [{ units: "Miles", value: 100000 }],
  notes: null,
};
const oilOem: OEMItem = {
  maintenance_id: 101,
  name: "Engine oil & filter",
  category: "Engine",
  miles: 5000,
  months: null as any,
  intervals: [{ units: "Miles", value: 5000 }],
  notes: null,
};

// Current odometer well past 100k so spark plugs are overdue IF (and only if)
// nothing reset their clock. The declined RO at 95k must NOT count.
const buckets = triage({
  oemItems: [sparkPlugOem, oilOem],
  carfaxRecords: [],
  carfaxCategories: [],
  shopServiceHistory,
  currentMiles: 130000,
  today,
  dviFindings: [],
  vehicleYear: 2014,
  shopId: 100,
  carfaxStatus: "ok" as any,
});

const allRows = [
  ...(buckets.overdue || []),
  ...((buckets as any).due || []),
  ...((buckets as any).dueSoon || []),
  ...(buckets.upcoming || []),
  ...((buckets as any).later || []),
  ...((buckets as any).upToDate || []),
  ...((buckets as any).notDueYet || []),
];

const spark = allRows.find(
  (r: any) => r.serviceKey === "spark_plugs" || /spark/i.test(r.title),
);
ok("spark-plug row present in some bucket", !!spark, JSON.stringify(allRows.map((r: any) => r.serviceKey)));
if (spark) {
  // The headline assertion: the declined RO must NOT have anchored the
  // spark-plug interval. Either there is no `last` anchor at all, or it is
  // not the declined 95k row.
  ok(
    "declined spark-plug RO did NOT become the last-done anchor",
    !((spark as any).last && (spark as any).last.miles === ROW_MILEAGE),
    `last=${JSON.stringify((spark as any).last)}`,
  );
  // With no valid anchor and 130k current miles on a 100k interval, spark
  // plugs must be flagged due/overdue — never up-to-date.
  const inOverdue = (buckets.overdue || []).some(
    (r: any) => r.serviceKey === "spark_plugs" || /spark/i.test(r.title),
  );
  const inUpToDate = ((buckets as any).upToDate || []).some(
    (r: any) => r.serviceKey === "spark_plugs" || /spark/i.test(r.title),
  );
  ok("spark plugs flagged overdue (clock NOT reset)", inOverdue, JSON.stringify(buckets.overdue?.map((r: any) => r.serviceKey)));
  ok("spark plugs NOT shown up-to-date", !inUpToDate);
}

// The authorized oil change SHOULD still anchor normally — the fix must not
// drop genuinely performed history.
const oil = allRows.find(
  (r: any) => r.serviceKey === "oil_change" || /oil/i.test(r.title),
);
ok("authorized oil change present", !!oil, JSON.stringify(allRows.map((r: any) => r.serviceKey)));
if (oil) {
  ok(
    "authorized oil change anchored to performed RO mileage",
    (oil as any).last?.miles === ROW_MILEAGE,
    `last=${JSON.stringify((oil as any).last)}`,
  );
}

if (failed > 0) {
  console.error(`\n${failed} task #608 check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll task #608 checks passed");
