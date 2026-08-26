/**
 * Smoke test for the DVI-findings (Autoflow / AutoVitals / Tekmetric)
 * red/yellow injection into `triage()`.
 *
 * Run: `npx tsx tests/plan-build-dvi-injection.smoke.ts`
 *
 * The route flattens findings from three DVI sources into a single
 * `dviFindings: { name, status, source }[]` array and hands it to
 * `triage()`. Inside, `triage()`:
 *
 *   - Maps each finding to a service key (via `toKeyFromName`).
 *   - Bumps a matching OEM row to `bump: "red" | "yellow"` and records
 *     `dviSource` (so the UI knows which DVI raised it).
 *   - Promotes a `red` bump to the `overdue` bucket regardless of mileage.
 *   - Promotes a `yellow` bump to `dueSoon` unless the row is already
 *     mileage/time overdue, in which case it stays in `overdue`.
 *   - Treats a "0" status as red and a "1" status as yellow.
 *   - When two findings hit the same service key, RED wins over YELLOW.
 *   - Findings whose `name` does NOT map to a known service key still
 *     appear as standalone "DVI Finding" rows.
 *
 * A regression in any of these would silently demote a flagged item back
 * to `upcoming` or hide it entirely.
 */

import { triage, type OEMItem } from "../lib/plan-build/triage";
import {
  buildPartnerVhiSuccessResponse,
  dedupePartnerVhiBuckets,
} from "../lib/external-api/partner-vhi-response";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Plan-build DVI-injection smoke checks");

const today = new Date("2026-04-28T00:00:00Z");

// Three OEM rows with intervals so far in the future they would otherwise
// land in `upcoming`. Without a DVI bump, none of these would be flagged.
const oemItems: OEMItem[] = [
  {
    maintenance_id: 1,
    name: "Replace brake fluid",
    category: "Brakes",
    miles: 30000,
    months: 36,
    intervals: [{ units: "Miles", value: 30000 }],
    notes: null,
  },
  {
    maintenance_id: 2,
    name: "Replace engine air filter",
    category: "Engine",
    miles: 30000,
    months: 36,
    intervals: [{ units: "Miles", value: 30000 }],
    notes: null,
  },
  {
    maintenance_id: 3,
    name: "Replace cabin air filter",
    category: "HVAC",
    miles: 30000,
    months: 36,
    intervals: [{ units: "Miles", value: 30000 }],
    notes: null,
  },
];

// Mix of red/yellow findings from all three DVI sources, plus a finding
// that does not map to a known service key.
const dviFindings = [
  // Red on brake fluid via Autoflow.
  { name: "Brake Fluid", status: "0", source: "autoflow" },
  // Yellow on engine air filter via AutoVitals.
  { name: "Engine Air Filter", status: "1", source: "autovitals" },
  // Conflicting findings on cabin air filter from Tekmetric: yellow then red
  // — RED must win regardless of order.
  { name: "Cabin Air Filter", status: "1", source: "tekmetric" },
  { name: "Cabin Air Filter", status: "0", source: "tekmetric" },
  // Free-form Tekmetric finding that does NOT map to a known service key.
  { name: "Cracked windshield (driver side)", status: "0", source: "tekmetric" },
  { name: "Warning Lights", status: "1", source: "tekmetric", notes: "ABS lamp" },
  { name: "Warning Lights", status: "0", source: "autoflow", notes: "Brake lamp" },
  { name: "Diagnostic Comments", status: "1", source: "tekmetric", notes: "Code P0123" },
  { name: "Diagnostic Comments", status: "1", source: "autovitals", notes: "Further diagnosis" },
  // Status "2" (Pass / informational) must NOT bump anything.
  { name: "Tire Tread Depth", status: "2", source: "autoflow" },
];

const buckets = triage({
  oemItems,
  carfaxRecords: [],
  shopServiceHistory: [],
  currentMiles: 5000,
  today,
  dviFindings,
  vehicleYear: 2022,
});

const all = [...buckets.overdue, ...buckets.dueSoon, ...buckets.upcoming];

// ---- Red bump on brake fluid ----
const brakeFluid = all.find((t) => t.serviceKey === "brake_fluid");
ok("Brake fluid OEM row is present", brakeFluid != null);
ok(
  "Brake fluid carries the RED bump from Autoflow",
  brakeFluid?.bump === "red",
  `bump=${brakeFluid?.bump}`,
);
ok(
  "Brake fluid records dviSource=autoflow",
  brakeFluid?.dviSource === "autoflow",
  `dviSource=${brakeFluid?.dviSource}`,
);
ok(
  "Brake fluid was promoted to OVERDUE despite being far from mileage due",
  buckets.overdue.some((t) => t.serviceKey === "brake_fluid"),
);

// ---- Yellow bump on engine air filter ----
const engineFilter = all.find((t) => t.serviceKey === "engine_air");
ok("Engine air filter OEM row is present", engineFilter != null);
ok(
  "Engine air filter carries the YELLOW bump from AutoVitals",
  engineFilter?.bump === "yellow",
  `bump=${engineFilter?.bump}`,
);
ok(
  "Engine air filter records dviSource=autovitals",
  engineFilter?.dviSource === "autovitals",
);
ok(
  "Engine air filter was promoted to DUE SOON (not overdue, not upcoming)",
  buckets.dueSoon.some((t) => t.serviceKey === "engine_air") &&
    !buckets.overdue.some((t) => t.serviceKey === "engine_air") &&
    !buckets.upcoming.some((t) => t.serviceKey === "engine_air"),
);

// ---- Conflicting red/yellow on cabin air filter: RED wins ----
const cabinFilter = all.find((t) => t.serviceKey === "cabin_air");
ok("Cabin air filter OEM row is present", cabinFilter != null);
ok(
  "Cabin air filter resolves to RED when both red and yellow findings hit the same key",
  cabinFilter?.bump === "red",
  `bump=${cabinFilter?.bump}`,
);
ok(
  "Cabin air filter is in OVERDUE (red beats yellow)",
  buckets.overdue.some((t) => t.serviceKey === "cabin_air"),
);

// ---- Unmapped finding still surfaces as a standalone DVI row ----
const unmapped = all.find((t) => t.title === "Cracked windshield (driver side)");
ok("Unmapped DVI finding still appears in triaged output", unmapped != null);
ok(
  "Unmapped DVI finding is categorized as 'DVI Finding'",
  unmapped?.category === "DVI Finding",
  `category=${unmapped?.category}`,
);
ok(
  "Unmapped DVI finding carries the RED bump and dviSource=tekmetric",
  unmapped?.bump === "red" && unmapped?.dviSource === "tekmetric",
  `bump=${unmapped?.bump} dviSource=${unmapped?.dviSource}`,
);
ok(
  "Unmapped RED DVI finding lands in OVERDUE",
  buckets.overdue.some((t) => t.title === "Cracked windshield (driver side)"),
);

const warningLights = all.filter((t) => t.serviceKey === "dvi_unmapped_warning_lights");
ok("Duplicate unmapped warning-light findings merge to one item", warningLights.length === 1);
ok(
  "Red warning-light finding wins and combines notes deterministically",
  warningLights[0]?.bump === "red" &&
    warningLights[0]?.dviSource === "autoflow" &&
    warningLights[0]?.notes === "ABS lamp • Brake lamp",
  JSON.stringify(warningLights[0]),
);
const diagnosticComments = all.filter((t) => t.serviceKey === "dvi_unmapped_diagnostic_comments");
ok("Duplicate diagnostic-comment findings merge to one item", diagnosticComments.length === 1);
ok(
  "Same-severity diagnostic notes and source merge deterministically",
  diagnosticComments[0]?.dviSource === "autovitals" &&
    diagnosticComments[0]?.notes === "Code P0123 • Further diagnosis",
  JSON.stringify(diagnosticComments[0]),
);

const legacyBuckets = dedupePartnerVhiBuckets({
  overdue: [{ key: "legacy-red", serviceKey: "duplicate_key", bump: "red", notes: "urgent" }] as any,
  dueSoon: [{ key: "legacy-yellow", serviceKey: "duplicate_key", bump: "yellow", notes: "inspect" }] as any,
  upcoming: [{ key: "legacy-upcoming", serviceKey: "duplicate_key" }] as any,
  complimentary: [],
});
const legacyAll = [
  ...legacyBuckets.overdue,
  ...legacyBuckets.dueSoon,
  ...legacyBuckets.upcoming,
  ...legacyBuckets.complimentary,
];
ok("Partner response collapse enforces cross-bucket service-key uniqueness", legacyAll.length === 1);
ok(
  "Partner response collapse keeps the most severe bucket and combines notes",
  legacyBuckets.overdue.length === 1 &&
    legacyBuckets.overdue[0].bump === "red" &&
    legacyBuckets.overdue[0].notes === "inspect • urgent",
  JSON.stringify(legacyBuckets),
);
const legacyResponse = buildPartnerVhiSuccessResponse({
  success: true,
  source: "cached_plan",
  buckets: {
    overdue: [{ serviceKey: "duplicate_key" }],
    dueSoon: [{ serviceKey: "duplicate_key" }],
    upcoming: [],
    complimentary: [],
  },
  summary: { overdue: 1, dueSoon: 1, upcoming: 0, complimentary: 0 },
}, "TESTVIN", 1);
ok(
  "Legacy cached response summary is recomputed after duplicate collapse",
  legacyResponse.summary.overdue === 1 && legacyResponse.summary.dueSoon === 0,
  JSON.stringify(legacyResponse.summary),
);

// ---- Status "2" (info / pass) must not bump anything ----
ok(
  "DVI finding with status '2' (informational) does NOT introduce a tire-rotation row",
  !all.some((t) => t.serviceKey === "tire_rotation" && (t.bump === "red" || t.bump === "yellow")),
);
ok(
  "DVI finding with status '2' does NOT appear as an unmapped DVI Finding row",
  !all.some((t) => t.title === "Tire Tread Depth"),
);

if (failed === 0) {
  console.log("\nAll plan-build DVI-injection smoke checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} plan-build DVI-injection smoke check(s) failed.`);
  process.exit(1);
}
