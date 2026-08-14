/**
 * Task #1118: duplicate declined items in the VHI sidepanel — regression smoke.
 *
 * The sidepanel showed the same service twice: an OEM plan item ("Coolant
 * Service") next to a verb-phrased twin ("Replace engine coolant.").
 * Root causes locked down here:
 *   1. Shop-interval retitle twin: the OEM Inspect row retitled to the
 *      canonical service name coexisted with the OEM Replace row for the
 *      same canonical key. Triage now collapses same-key OEM twins (while
 *      genuine Inspect + Replace pairs still coexist — see task #198).
 *   2. Declined jobs only attached the FIRST match and pre-deduped repeat
 *      declines by title. Now every matching declined-job group
 *      accumulates (`declinedCount`, most-recent provenance).
 *   3. A declined job whose key mapper output misses the plan item's key
 *      now attaches via a guarded normalized-title containment match
 *      instead of appending a standalone twin.
 *   4. Genuinely unmatched declined jobs still appear standalone.
 *
 * Pure triage() + pure helpers — no DB, no network.
 * Run: npx tsx tests/plan-build-task-1118.smoke.ts
 */
import { triage, type TriagedItem } from "../lib/plan-build/triage";
import type { OEMItem } from "../lib/plan-build/oem-item";
import {
  groupDeclinedJobs,
  titlesContainMatch,
  collapseDuplicateServiceItems,
  foldDeclinedProvenance,
} from "../lib/plan-build/declined-merge";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

function allItems(b: ReturnType<typeof triage>): TriagedItem[] {
  return [...b.overdue, ...b.dueSoon, ...b.upcoming];
}

const base = {
  dviFindings: [],
  currentMiles: 150_000,
  today: new Date("2026-08-14"),
  carfaxRecords: [],
  vehicleTransType: "automatic",
};

// Fixtures modeled on RO #853077833 (2016 Toyota Sienna): DataOne ships an
// Inspect row AND a Replace row per fluid; the shop-interval override
// retitles the Inspect row to the canonical name → duplicate pair.
const sienaOem: OEMItem[] = [
  { maintenance_id: 1, name: "Inspect engine coolant.", category: "Fluids", miles: 30_000, months: 36, intervals: [{ units: "Miles", value: 30_000 }], notes: null },
  { maintenance_id: 2, name: "Replace engine coolant.", category: "Fluids", miles: 100_000, months: 120, intervals: [{ units: "Miles", value: 100_000 }], notes: null },
  { maintenance_id: 3, name: "Inspect engine air filter.", category: "Engine", miles: 15_000, months: 12, intervals: [{ units: "Miles", value: 15_000 }], notes: null },
  { maintenance_id: 4, name: "Replace engine air filter.", category: "Engine", miles: 30_000, months: 36, intervals: [{ units: "Miles", value: 30_000 }], notes: null },
  { maintenance_id: 5, name: "Replace spark plugs.", category: "Engine", miles: 120_000, months: null, intervals: [{ units: "Miles", value: 120_000 }], notes: null },
  { maintenance_id: 6, name: "Inspect automatic transmission fluid.", category: "Drivetrain", miles: 30_000, months: null, intervals: [{ units: "Miles", value: 30_000 }], notes: null },
  { maintenance_id: 7, name: "Replace automatic transmission fluid.", category: "Drivetrain", miles: 100_000, months: null, intervals: [{ units: "Miles", value: 100_000 }], notes: null },
];

const shopIntervals = {
  coolant: { useShop: true, miles: 50_000, months: 48 },
  engine_air: { useShop: true, miles: 30_000, months: 24 },
  trans_auto: { useShop: true, miles: 60_000, months: null },
} as any;

console.log("1) Shop-interval retitle twin collapses to ONE item per key");
{
  const b = triage({ ...base, oemItems: sienaOem, shopIntervals, intervalApplyMode: "always" } as any);
  const items = allItems(b);
  for (const key of ["coolant", "engine_air", "trans_auto"]) {
    const rows = items.filter((t) => t.serviceKey === key);
    check(`${key}: exactly one plan item`, rows.length === 1, `got ${rows.length}: ${rows.map((r) => r.title).join(" | ")}`);
  }
}

console.log("2) Genuine Inspect + Replace pairs (no shop override) still coexist (task #198 parity)");
{
  const b = triage({ ...base, oemItems: sienaOem, shopIntervals: {} } as any);
  const rows = allItems(b).filter((t) => t.serviceKey === "coolant");
  check("coolant: inspect + replace both present", rows.length === 2, `got ${rows.length}`);
}

console.log("3) Declined job for a service already on the plan merges (no standalone twin)");
{
  const b = triage({
    ...base,
    oemItems: sienaOem,
    shopIntervals,
    intervalApplyMode: "always",
    tekmetricDeclinedJobs: [
      { id: "d1", title: "Replace engine coolant.", date: "2025-09-29T15:01:23.000Z", originalWorkOrderNumber: 69715 },
      { id: "d2", title: "Replace engine air filter.", date: "2025-09-29T15:01:23.000Z", originalWorkOrderNumber: 69715 },
    ],
  } as any);
  const items = allItems(b);
  for (const key of ["coolant", "engine_air"]) {
    const rows = items.filter((t) => t.serviceKey === key);
    check(`${key}: still exactly one item`, rows.length === 1, `got ${rows.length}`);
    check(`${key}: carries declined provenance`, !!rows[0]?.declined && rows[0]?.declinedCount === 1);
  }
  check("no standalone Customer Declined twin", !items.some((t) => t.source === "declined"));
}

console.log("4) Repeat declines aggregate: Declined ×3 with most-recent provenance");
{
  const b = triage({
    ...base,
    oemItems: [
      { maintenance_id: 10, name: "Replace rear shock absorbers.", category: "Suspension", miles: 60_000, months: null, intervals: [{ units: "Miles", value: 60_000 }], notes: null },
    ],
    tekmetricDeclinedJobs: [
      { id: "s1", title: "REAR SHOCK ABSORBERS", date: "2023-04-19T21:34:59.000Z", originalWorkOrderNumber: 47763 },
      { id: "s2", title: "REAR SHOCK ABSORBERS", date: "2023-12-04T18:28:16.000Z", originalWorkOrderNumber: 53113 },
      { id: "s3", title: "REAR SHOCK ABSORBERS", date: "2025-09-29T15:01:23.000Z", originalWorkOrderNumber: 69715 },
    ],
  } as any);
  const rows = allItems(b).filter((t) => t.serviceKey === "rear_shocks");
  check("one rear_shocks item", rows.length === 1, `got ${rows.length}`);
  check("declinedCount === 3", rows[0]?.declinedCount === 3, `got ${rows[0]?.declinedCount}`);
  check("provenance is most recent decline (RO 69715)", rows[0]?.declined?.roNumber === 69715);
  check("merged item is forced overdue", b.overdue.includes(rows[0]!));
}

console.log("5) Key-mapper miss falls back to guarded title containment");
{
  // "Rear Main Seal Service" maps to no canonical key on either side; the
  // declined free text contains the plan item's normalized title, so it
  // must attach instead of appending a standalone twin.
  const b = triage({
    ...base,
    oemItems: [
      { maintenance_id: 20, name: "Rear Main Seal Service", category: "Engine", miles: 90_000, months: null, intervals: [{ units: "Miles", value: 90_000 }], notes: null },
    ],
    tekmetricDeclinedJobs: [
      { id: "m1", title: "REPLACE REAR MAIN SEAL SERVICE", date: "2025-01-05T00:00:00.000Z", originalWorkOrderNumber: 111 },
    ],
  } as any);
  const items = allItems(b);
  const seal = items.filter((t) => /rear main seal/i.test(t.title));
  check("one rear-main-seal item", seal.length === 1, `got ${seal.length}: ${seal.map((s) => s.title).join(" | ")}`);
  check("decline attached via containment", !!seal[0]?.declined);
  check("no standalone twin", !items.some((t) => t.source === "declined"));
}

console.log("6) Genuinely unmatched declined job still shows standalone");
{
  const b = triage({
    ...base,
    oemItems: sienaOem,
    shopIntervals,
    intervalApplyMode: "always",
    tekmetricDeclinedJobs: [
      { id: "u1", title: "TIRE DISCLAIMER", date: "2023-12-04T18:28:16.000Z", originalWorkOrderNumber: 53113 },
    ],
  } as any);
  const standalone = allItems(b).filter((t) => t.source === "declined");
  check("standalone entry present", standalone.length === 1, `got ${standalone.length}`);
  check("standalone keeps declinedCount 1", standalone[0]?.declinedCount === 1);
}

console.log("7) Pure helper guards");
{
  check("groupDeclinedJobs counts repeats + keeps latest", (() => {
    const g = groupDeclinedJobs([
      { id: "1", title: "Rear Shocks", date: "2023-01-01T00:00:00.000Z" },
      { id: "2", title: "rear  shocks", date: "2025-01-01T00:00:00.000Z" },
    ]);
    return g.length === 1 && g[0].count === 2 && g[0].latest.id === "2";
  })());
  check("containment: verb-stripped equality matches", titlesContainMatch("Replace engine air filter.", "Engine Air Filter"));
  check("containment: word-boundary containment matches", titlesContainMatch("ENGINE AIR FILTER REPLACEMENT KIT", "Engine Air Filter"));
  check("containment: short/single-word guard rejects", !titlesContainMatch("TIRE DISCLAIMER", "Tires"));
  check("containment: unrelated titles reject", !titlesContainMatch("Coolant Service", "Replace engine coolant."));

  // Both-branch parity: the on-demand rec shape collapses identically.
  const recs: any[] = [
    { service: "Coolant Service", serviceKey: "coolant", source: "oem", status: "overdue" },
    { service: "Replace engine coolant.", serviceKey: "coolant", source: "oem", status: "overdue" },
    { service: "TIRE INSTALLATION", serviceKey: "tire_rotation", source: "declined", status: "overdue", declined: { declinedAt: "2025-01-01T00:00:00.000Z" }, declinedCount: 2 },
    { service: "Rotate tires.", serviceKey: "tire_rotation", source: "oem", status: "upcoming" },
    { service: "Inspect brake fluid.", serviceKey: "brake_fluid", source: "oem", status: "upcoming" },
    { service: "Replace brake fluid.", serviceKey: "brake_fluid", source: "oem", status: "upcoming" },
  ];
  const out = collapseDuplicateServiceItems(recs, {
    getServiceKey: (r) => r.serviceKey,
    getSource: (r) => r.source,
    getAction: (r) => (/^\s*(?:inspect|check)\b/i.test(r.service || "") ? "inspect" : null),
    isInspectOnly: (r) => !!r.inspectOnly,
    mergeInto: (k, d) => foldDeclinedProvenance(k, d),
  });
  check("rec collapse: coolant twin folded to one", out.filter((r) => r.serviceKey === "coolant").length === 1);
  check("rec collapse: standalone declined folded onto OEM tire item", (() => {
    const t = out.filter((r) => r.serviceKey === "tire_rotation");
    return t.length === 1 && t[0].source === "oem" && t[0].declinedCount === 2 && !!t[0].declined;
  })());
  check("rec collapse: inspect + replace pair untouched", out.filter((r) => r.serviceKey === "brake_fluid").length === 2);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll task #1118 checks passed.");
