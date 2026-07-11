/**
 * Standalone declined-entry resolution guard — regression smoke.
 *
 * A Tekmetric declined job that matches NO triaged OEM item (e.g. control
 * arms — a repair, not a scheduled interval) becomes its own "Customer
 * Declined" overdue row. This test locks the performed-after-decline guard
 * for those standalone rows: shop history or CARFAX showing the work was
 * ACTUALLY PERFORMED after the decline date resolves the flag, while
 * inspect-only phrases and work performed BEFORE the decline do not.
 *
 * Pure triage() — no DB, no network. Run: npx tsx tests/plan-build-declined-standalone.smoke.ts
 */
import { triage } from "../lib/plan-build/triage";

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

const DECLINED_AT = "2025-10-24T17:49:46.000Z";
const base = {
  oemItems: [],
  dviFindings: [],
  currentMiles: 91294,
  today: new Date("2026-07-11"),
  tekmetricDeclinedJobs: [
    {
      id: "j1",
      title: "Remove & Replace Suspension Control Arm",
      date: DECLINED_AT,
      originalWorkOrderNumber: 25141,
    },
    {
      id: "j2",
      title: "WHEEL ALIGNMENT",
      date: DECLINED_AT,
      originalWorkOrderNumber: 25141,
    },
  ],
} as const;

function declinedTitles(b: ReturnType<typeof triage>): string[] {
  return [...b.overdue, ...b.dueSoon, ...b.upcoming]
    .filter((t) => t.declined)
    .map((t) => t.title)
    .sort();
}

console.log("Standalone declined-entry guard checks");

// 1. No history at all → both standalone flags stay.
{
  const got = declinedTitles(triage({ ...base, carfaxRecords: [] } as any));
  check("no history: both flags stay", got.length === 2);
  check(
    "no history: control-arm row keyed control_arm",
    [...triage({ ...base, carfaxRecords: [] } as any).overdue].some(
      (t) => t.declined && t.serviceKey === "control_arm"
    )
  );
}

// 2. CARFAX shows the work performed AFTER the decline → that flag drops,
//    the other stays.
{
  const got = declinedTitles(
    triage({
      ...base,
      carfaxRecords: [
        {
          date: "12/01/2025",
          odometer: 89000,
          description: "Vehicle serviced; Lower control arm(s) replaced",
        },
      ],
    } as any)
  );
  check("CARFAX replaced after decline: control-arm flag dropped", !got.some((t) => /control arm/i.test(t)));
  check("CARFAX replaced after decline: alignment flag stays", got.some((t) => /alignment/i.test(t)));
}

// 3. Inspect-only CARFAX phrase → must NOT clear (verb guard).
{
  const got = declinedTitles(
    triage({
      ...base,
      carfaxRecords: [
        { date: "12/01/2025", odometer: 89000, description: "Control arm checked" },
      ],
    } as any)
  );
  check("CARFAX inspect-only: flag NOT cleared", got.some((t) => /control arm/i.test(t)));
}

// 4. Work performed BEFORE the decline → must NOT clear.
{
  const got = declinedTitles(
    triage({
      ...base,
      carfaxRecords: [
        { date: "01/15/2025", odometer: 80000, description: "Control arm(s) replaced" },
      ],
    } as any)
  );
  check("CARFAX replaced before decline: flag NOT cleared", got.some((t) => /control arm/i.test(t)));
}

// 5. Shop history after the decline → clears too (not just CARFAX).
{
  const got = declinedTitles(
    triage({
      ...base,
      carfaxRecords: [],
      shopServiceHistory: [
        {
          serviceName: "Replaced lower control arm",
          mileage: 90000,
          date: new Date("2025-12-15"),
        },
      ],
    } as any)
  );
  check("shop history after decline: control-arm flag dropped", !got.some((t) => /control arm/i.test(t)));
  check("shop history after decline: alignment flag stays", got.some((t) => /alignment/i.test(t)));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll standalone declined-guard checks passed.");
