/**
 * Regression: a CARFAX "checked / inspected" item must NOT anchor a
 * replacement service's "last done" clock.
 *
 * Confirmed bug: Harrell's (shopId 50, Protractor), 2013 INFINITI G37 VIN
 * JN1CV6AP0DM718694. CARFAX for 8/17/2024 @ 64,175 mi read
 * "Vehicle serviced; Drive belts checked; Oil and filter changed; Tire
 * condition and pressure checked; Tire(s) balanced; Tires rotated". CARFAX
 * joins those bullet lines into ONE description with "; ", so the whole blob
 * was run through toKeyFromFreeText and every matched key was anchored as
 * "last done" with no verb check. Result: "Drive belts checked" (an
 * inspection) reset the serpentine-belt REPLACEMENT interval, so the panel
 * showed "Last done 64,175 mi on 8/17/2024" and pushed the next due date out
 * two years — even though the belts were only inspected.
 *
 * This smoke locks in:
 *   1. Phrase verb detection — trailing "checked/inspected" reads as
 *      inspect-only; a performed verb ("changed/rotated/serviced/aligned")
 *      does not; noun collisions ("alignment checked") stay inspect-only.
 *   2. Description splitting on "; " / newlines / bullets.
 *   3. End-to-end through triage: the inspected belt is NOT anchored (no
 *      `last`), while the genuinely-performed oil change in the SAME record
 *      IS anchored.
 *
 * Run: `npx tsx tests/plan-build-carfax-inspect-anchor.smoke.ts`
 */

import {
  isInspectOnlyHistoryPhrase,
  splitServicePhrases,
  toKeyFromFreeText,
} from "../lib/service-keys";
import { triage, type OEMItem } from "../lib/plan-build/triage";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  \u2713 ${name}`);
  else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("CARFAX inspect-vs-replace anchor smoke checks");

// ---------------------------------------------------------------------------
// Layer 1: phrase verb detection
// ---------------------------------------------------------------------------
const inspectOnly: string[] = [
  "Drive belts checked",
  "Tire condition and pressure checked",
  "Alignment checked", // noun "alignment" must not read as verb "aligned"
  "Brakes inspected",
  "Battery tested",
  "Coolant level checked",
];
for (const p of inspectOnly) {
  ok(`inspect-only: "${p}"`, isInspectOnlyHistoryPhrase(p) === true);
}

const performed: string[] = [
  "Oil and filter changed",
  "Drive belt replaced",
  "Tires rotated",
  "Tire(s) balanced",
  "Vehicle serviced",
  "Wheels aligned",
  "Wheel alignment performed",
  "Brakes serviced",
  "Transmission fluid flushed",
];
for (const p of performed) {
  ok(`performed (not inspect-only): "${p}"`, isInspectOnlyHistoryPhrase(p) === false);
}

// ---------------------------------------------------------------------------
// Layer 2: description splitting
// ---------------------------------------------------------------------------
const blob =
  "Vehicle serviced; Drive belts checked; Oil and filter changed; Tire condition and pressure checked; Tire(s) balanced; Tires rotated";
ok(
  "splits the joined CARFAX blob into 6 phrases",
  splitServicePhrases(blob).length === 6,
  JSON.stringify(splitServicePhrases(blob)),
);
ok(
  "'Drive belts checked' phrase still resolves to serpentine_belt via dictionary",
  toKeyFromFreeText("Drive belts checked").includes("serpentine_belt"),
);

// ---------------------------------------------------------------------------
// Layer 3: end-to-end anchor behavior through triage
// ---------------------------------------------------------------------------
// Mirrors the G37: single CARFAX record mixing an inspected belt with a
// performed oil change. The belt must NOT be anchored; the oil must be.
const beltOem: OEMItem = {
  maintenance_id: 900,
  name: "Replace drive belt(s).",
  category: "Engine",
  miles: 30000,
  months: null as any,
  intervals: [{ units: "Miles", value: 30000 }],
  notes: null,
} as any;

const oilOem: OEMItem = {
  maintenance_id: 901,
  name: "Replace engine oil and filter.",
  category: "Engine",
  miles: 5000,
  months: null as any,
  intervals: [{ units: "Miles", value: 5000 }],
  notes: null,
} as any;

const buckets = triage({
  oemItems: [beltOem, oilOem],
  carfaxRecords: [
    {
      date: "2024-08-17",
      odometer: 64175,
      description: blob,
    },
  ],
  carfaxCategories: [],
  shopServiceHistory: [],
  currentMiles: 87576,
  today: new Date("2026-07-01T00:00:00Z"),
  dviFindings: [],
  vehicleYear: 2013,
} as any);

const allRows = [
  ...(buckets.overdue || []),
  ...((buckets as any).dueSoon || []),
  ...(buckets.upcoming || []),
];

const beltRow = allRows.find((r: any) => r.serviceKey === "serpentine_belt");
const oilRow = allRows.find((r: any) => r.serviceKey === "oil");

ok(
  "belt OEM item is present in the plan",
  !!beltRow,
  `serviceKeys: ${allRows.map((r: any) => r.serviceKey).join(", ")}`,
);
ok(
  "inspected belt is NOT anchored (no `last` from 'Drive belts checked')",
  !!beltRow && !beltRow.last,
  JSON.stringify(beltRow?.last),
);
ok(
  "performed oil change IS anchored from the same record",
  !!oilRow && !!oilRow.last && oilRow.last.miles === 64175,
  JSON.stringify(oilRow?.last),
);

// ---------------------------------------------------------------------------
// Layer 4: CARFAX categories rollup + emissions exception
// ---------------------------------------------------------------------------
// An inspect-only category must not anchor a replacement key, but an
// emissions inspection (INSPECTION_SERVICE_KEYS) legitimately anchors.
const emissionsOem: OEMItem = {
  maintenance_id: 902,
  name: "Emissions inspection.",
  category: "Emissions",
  miles: 12000,
  months: null as any,
  intervals: [{ units: "Miles", value: 12000 }],
  notes: null,
} as any;

const catBuckets = triage({
  oemItems: [beltOem, emissionsOem],
  carfaxRecords: [],
  carfaxCategories: [
    { serviceName: "Drive belt inspection", date: "2024-08-17", odometer: 64175 },
    { serviceName: "Emissions Inspection", date: "2024-08-17", odometer: 64175 },
  ],
  shopServiceHistory: [],
  currentMiles: 87576,
  today: new Date("2026-07-01T00:00:00Z"),
  dviFindings: [],
  vehicleYear: 2013,
} as any);
const catRows = [
  ...(catBuckets.overdue || []),
  ...((catBuckets as any).dueSoon || []),
  ...(catBuckets.upcoming || []),
];
const catBelt = catRows.find((r: any) => r.serviceKey === "serpentine_belt");
const catEmissions = catRows.find((r: any) => r.serviceKey === "emissions");
ok(
  "category 'Drive belt inspection' does NOT anchor serpentine_belt",
  !!catBelt && !catBelt.last,
  JSON.stringify(catBelt?.last),
);
ok(
  "category 'Emissions Inspection' DOES anchor emissions (inspection is the service)",
  !!catEmissions && !!catEmissions.last,
  JSON.stringify(catEmissions?.last),
);

// ---------------------------------------------------------------------------
// Layer 5: shop-history path guarded too (same class of bug)
// ---------------------------------------------------------------------------
const shopBuckets = triage({
  oemItems: [beltOem, oilOem],
  carfaxRecords: [],
  carfaxCategories: [],
  shopServiceHistory: [
    { serviceName: "Serpentine belt inspection", mileage: 64175, date: new Date("2024-08-17T00:00:00Z") },
    { serviceName: "Oil and filter change", mileage: 64175, date: new Date("2024-08-17T00:00:00Z") },
  ],
  currentMiles: 87576,
  today: new Date("2026-07-01T00:00:00Z"),
  dviFindings: [],
  vehicleYear: 2013,
} as any);
const shopRows = [
  ...(shopBuckets.overdue || []),
  ...((shopBuckets as any).dueSoon || []),
  ...(shopBuckets.upcoming || []),
];
const shopBelt = shopRows.find((r: any) => r.serviceKey === "serpentine_belt");
const shopOil = shopRows.find((r: any) => r.serviceKey === "oil");
ok(
  "shop-history 'Serpentine belt inspection' does NOT anchor serpentine_belt",
  !!shopBelt && !shopBelt.last,
  JSON.stringify(shopBelt?.last),
);
ok(
  "shop-history 'Oil and filter change' DOES anchor oil",
  !!shopOil && !!shopOil.last,
  JSON.stringify(shopOil?.last),
);

// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
