// Smoke test: declined-work line re-hydration from the raw Tekmetric RO cache.
//
// Regression for the "Add All Declined" bug where job_index rows indexed
// before the May-2026 job-detail fix carried $0 parts and no labor line, so
// the extension pushed a control-arm job onto the RO with zero labor hours
// and $0 parts (real case: shop 73, VIN 3VW267AJ6GM297139, WO 25141).
//
// Run: npx tsx tests/declined-work-line-enrichment.smoke.ts
import {
  linesAreThin,
  buildLinesFromRawJob,
  type DeclinedWorkLine,
} from "../lib/declined-work-lines";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// linesAreThin
// ---------------------------------------------------------------------------
console.log("linesAreThin:");

check("empty lines are thin", linesAreThin([]));

// Real degraded row shape (WO 25141 control arm): parts present but $0, no labor.
const degraded: DeclinedWorkLine[] = [
  { description: "Control Arm - Lower", lineType: "part", quantity: 1, unitPrice: 0, partNumber: "CA12678", manufacturer: "" },
  { description: "Ball Joint - Lower", lineType: "part", quantity: 1, unitPrice: 0, partNumber: "10480662", manufacturer: "" },
];
check("zero-priced parts with no labor are thin", linesAreThin(degraded));

check(
  "labor present but a $0 part is still thin",
  linesAreThin([
    { description: "R&R", lineType: "labor", quantity: 1, unitPrice: 170.1, partNumber: "", manufacturer: "", hours: 3 },
    { description: "Part", lineType: "part", quantity: 1, unitPrice: 0, partNumber: "", manufacturer: "" },
  ]),
);

const healthy: DeclinedWorkLine[] = [
  { description: "R&R Control Arm", lineType: "labor", quantity: 1, unitPrice: 170.1, partNumber: "", manufacturer: "", hours: 3 },
  { description: "Control Arm - Lower", lineType: "part", quantity: 1, unitPrice: 228.02, partNumber: "CA12678", manufacturer: "" },
];
check("labor + priced parts are NOT thin", !linesAreThin(healthy));

check(
  "labor-only job (e.g. alignment) is NOT thin",
  !linesAreThin([
    { description: "Wheel alignment", lineType: "labor", quantity: 1, unitPrice: 107.92, partNumber: "", manufacturer: "", hours: 1 },
  ]),
);

// ---------------------------------------------------------------------------
// buildLinesFromRawJob — real cached job payload (shop 73, WO 25141)
// ---------------------------------------------------------------------------
console.log("buildLinesFromRawJob:");

const rawControlArm = {
  name: "Remove & Replace Suspension Control Arm",
  authorized: false,
  laborTotal: 51030,
  partsTotal: 70487,
  subtotal: 121517,
  laborHours: 3,
  labor: [
    { id: 732246259, name: "Remove & Replace Lower Suspension Control Arm (Both Sides)", rate: 17010, hours: 3, complete: false, technicianId: null },
  ],
  parts: [
    { name: "Control Arm - Lower", partNumber: "CA12678", retail: 22802, cost: 9349, quantity: 1 },
    { name: "Control Arm - Lower", partNumber: "CA12679", retail: 22885, cost: 9383, quantity: 1 },
    { name: "Ball Joint - Lower", partNumber: "10480662", retail: 12400, cost: 4464, quantity: 1 },
    { name: "Ball Joint - Lower", partNumber: "10480663", retail: 12400, cost: 4464, quantity: 1 },
  ],
};

const rebuilt = buildLinesFromRawJob(rawControlArm);
const laborLines = rebuilt.filter((l) => l.lineType === "labor");
const partLines = rebuilt.filter((l) => l.lineType === "part");

check("rebuilds exactly 1 labor line", laborLines.length === 1, `got ${laborLines.length}`);
check("labor carries 3.0 hours", laborLines[0]?.hours === 3, `got ${laborLines[0]?.hours}`);
check("labor rate is $170.10", laborLines[0]?.unitPrice === 170.1, `got ${laborLines[0]?.unitPrice}`);
check("rebuilds all 4 parts", partLines.length === 4, `got ${partLines.length}`);
check(
  "first part retail is $228.02",
  partLines[0]?.unitPrice === 228.02,
  `got ${partLines[0]?.unitPrice}`,
);
check(
  "first part real cost is $93.49",
  partLines[0]?.cost === 93.49,
  `got ${partLines[0]?.cost}`,
);
check(
  "part numbers survive",
  partLines.map((p) => p.partNumber).join(",") === "CA12678,CA12679,10480662,10480663",
);
check("rebuilt lines are not thin", !linesAreThin(rebuilt));

// Labor-only job (WO 23810 alignment shape).
const rawAlignment = {
  name: "WHEEL ALIGNMENT ",
  laborTotal: 10792,
  partsTotal: 0,
  laborHours: 1,
  labor: [{ id: 580273843, name: "Perform wheel alignment", rate: 10792, hours: 1 }],
  parts: [],
};
const rebuiltAlign = buildLinesFromRawJob(rawAlignment);
check("labor-only job rebuilds 1 line", rebuiltAlign.length === 1);
check("alignment hours = 1", rebuiltAlign[0]?.hours === 1);
check("alignment rate = $107.92", rebuiltAlign[0]?.unitPrice === 107.92);

// Totals-only job (no labor array): synthesize a labor line from laborTotal.
const rawTotalsOnly = { name: "Diag", laborTotal: 15000, laborHours: 1.5, parts: [] };
const rebuiltTotals = buildLinesFromRawJob(rawTotalsOnly);
check("totals-only job synthesizes labor", rebuiltTotals.length === 1 && rebuiltTotals[0].lineType === "labor");
check("synthesized labor keeps hours", rebuiltTotals[0]?.hours === 1.5);

// Zero-priced parts with a real parts total: spread the total across parts.
const rawZeroParts = {
  name: "Brakes",
  laborTotal: 0,
  partsTotal: 20000,
  labor: [{ name: "R&R pads", rate: 17010, hours: 1 }],
  parts: [
    { name: "Pads", retail: 0, cost: 0, quantity: 1 },
    { name: "Rotors", retail: 0, cost: 0, quantity: 1 },
  ],
};
const rebuiltZero = buildLinesFromRawJob(rawZeroParts);
const zeroParts = rebuiltZero.filter((l) => l.lineType === "part");
check("zero-priced parts get the spread total", zeroParts.every((p) => p.unitPrice === 100));

// Genuinely empty job: nothing fabricated.
check("empty raw job produces no lines", buildLinesFromRawJob({ name: "X", parts: [] }).length === 0);

// ---------------------------------------------------------------------------
console.log("");
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("All declined-work line enrichment checks passed.");
process.exit(0);
