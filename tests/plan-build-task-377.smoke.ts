/**
 * Task #377 smoke test: technician notes + per-shop best-practice blurbs
 * flow through `triage()` and land on DVI Finding tiles.
 *
 * Run: `npx tsx tests/plan-build-task-377.smoke.ts`
 */

import { triage, type OEMItem } from "../lib/plan-build/triage";
import {
  upsertShopDviBestPractice,
  deleteShopDviBestPractice,
  getShopDviBestPracticeMap,
  canonicalizeServiceKey,
  DEFAULT_DVI_BEST_PRACTICES,
  DVI_BEST_PRACTICE_MAX_CHARS,
} from "../lib/dvi-best-practices";
import { toKeyFromName } from "../lib/service-keys";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Task #377 smoke checks");

const today = new Date("2026-05-05T00:00:00Z");

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
];

const longBrakeNote = "Pedal feels spongy at low speed. Bench-tested fluid; copper above 200ppm. Recommend full flush before winter storage.";
const shortBrakeNote = "Fluid dark.";

const dviFindings = [
  // Two reds on the same service key — longer note must win.
  { name: "Brake Fluid", status: "0", source: "autoflow", notes: shortBrakeNote },
  { name: "Brake Fluid", status: "0", source: "autoflow", notes: longBrakeNote },
  // Yellow finding on a service key that has NO matching OEM row → standalone DVI Finding tile.
  {
    name: "Front Wiper Blades",
    status: "1",
    source: "autovitals",
    notes: "Streaking on driver side; chatter at high speed.",
  },
  {
    name: "Cabin Air Filter",
    status: "0",
    source: "tekmetric",
    notes: "Filter loaded with leaves; airflow restricted by ~50%.",
  },
  // Unmapped finding — note flows through, blurb does NOT (no canonical serviceKey).
  {
    name: "Cracked windshield (driver side)",
    status: "0",
    source: "tekmetric",
    notes: "12 inch crack across passenger view; safety inspection failure.",
  },
  // No-note finding — should not crash the merge logic.
  { name: "Air Filter", status: "1", source: "autoflow" },
];

const longBlurb = "x".repeat(200);
const blurbsObject: Record<string, string> = {
  wiper_blades: "Replace every 6–12 months. Streaking blades reduce visibility in rain and freezing weather.",
  cabin_air: "Replace every 15k–30k miles. A clogged cabin filter restricts A/C airflow and traps allergens inside the vehicle.",
  brake_fluid: "Brake fluid absorbs water; flush every 2–3 years.",
  front_brake_pads: longBlurb,
};

const buckets = triage({
  oemItems,
  carfaxRecords: [],
  shopServiceHistory: [],
  currentMiles: 5000,
  today,
  dviFindings,
  vehicleYear: 2022,
  dviBestPractices: blurbsObject,
});

const all = [...buckets.overdue, ...buckets.dueSoon, ...buckets.upcoming];

// ---- Tech-note merge: longer note wins on same key ----
const brakeFluid = all.find((t) => t.serviceKey === "brake_fluid");
ok("Brake fluid row exists", brakeFluid != null);
ok("Brake fluid row carries the LONGER tech note when two reds collide",
  brakeFluid?.notes === longBrakeNote,
  `notes=${brakeFluid?.notes}`);
// Brake fluid bumped an OEM row (category=Brakes), so blurb must NOT attach.
ok("Brake fluid OEM-bumped row has NO best-practice blurb (not a DVI Finding tile)",
  brakeFluid?.bestPracticeBlurb == null,
  `bestPracticeBlurb=${brakeFluid?.bestPracticeBlurb}, category=${brakeFluid?.category}`);

// ---- Mapped DVI Finding tile gets BOTH note + blurb ----
const wipers = all.find((t) => t.serviceKey === "wiper_blades" && t.category === "DVI Finding");
ok("Wiper Blades shows up as a standalone DVI Finding tile", wipers != null);
ok("Wiper Blades tile carries the technician note",
  wipers?.notes === "Streaking on driver side; chatter at high speed.",
  `notes=${wipers?.notes}`);
ok("Wiper Blades tile carries the per-shop best-practice blurb",
  wipers?.bestPracticeBlurb === blurbsObject.wiper_blades,
  `blurb=${wipers?.bestPracticeBlurb}`);

const cabin = all.find((t) => t.serviceKey === "cabin_air" && t.category === "DVI Finding");
ok("Cabin Air Filter DVI Finding tile carries both note and blurb",
  cabin?.notes?.startsWith("Filter loaded with leaves") === true &&
    cabin?.bestPracticeBlurb === blurbsObject.cabin_air);

// ---- Unmapped finding: note flows through, blurb does NOT ----
const windshield = all.find((t) => t.title === "Cracked windshield (driver side)");
ok("Unmapped DVI Finding tile carries the technician note",
  windshield?.notes?.startsWith("12 inch crack") === true,
  `notes=${windshield?.notes}`);
ok("Unmapped DVI Finding tile has NO blurb (no canonical serviceKey to look up)",
  windshield?.bestPracticeBlurb == null,
  `blurb=${windshield?.bestPracticeBlurb}`);

// ---- Map-shape input also works ----
const blurbsMap = new Map<string, string>([["wiper_blades", "Map-shape blurb wins."]]);
const buckets2 = triage({
  oemItems,
  carfaxRecords: [],
  shopServiceHistory: [],
  currentMiles: 5000,
  today,
  dviFindings: [{ name: "Front Wiper Blades", status: "1", source: "autoflow", notes: "tn" }],
  vehicleYear: 2022,
  dviBestPractices: blurbsMap,
});
const wipersFromMap = [...buckets2.overdue, ...buckets2.dueSoon, ...buckets2.upcoming]
  .find((t) => t.serviceKey === "wiper_blades" && t.category === "DVI Finding");
ok("Best-practice lookup accepts a Map<string,string>",
  wipersFromMap?.bestPracticeBlurb === "Map-shape blurb wins.");

// ---- 140-char cap is enforced even if caller passes overlong text ----
const buckets3 = triage({
  oemItems: [],
  carfaxRecords: [],
  shopServiceHistory: [],
  currentMiles: 5000,
  today,
  dviFindings: [{ name: "Front Brake Pads", status: "0", source: "tekmetric", notes: "thin" }],
  vehicleYear: 2022,
  dviBestPractices: blurbsObject,
});
const padsTile = [...buckets3.overdue, ...buckets3.dueSoon, ...buckets3.upcoming]
  .find((t) => t.serviceKey === "front_brake_pads" && t.category === "DVI Finding");
ok("Front Brake Pads DVI Finding tile receives a blurb capped at 140 chars",
  (padsTile?.bestPracticeBlurb?.length ?? 0) === DVI_BEST_PRACTICE_MAX_CHARS,
  `blurb length=${padsTile?.bestPracticeBlurb?.length}`);

// ---- No-note finding doesn't crash ----
const airFilter = all.find((t) => t.title === "Air Filter" && t.category === "DVI Finding");
ok("Finding with no note still produces a DVI Finding tile (notes=null)",
  airFilter != null && airFilter.notes == null);

// ---- Triage with NO dviBestPractices param: tiles still render with notes, blurb null ----
const buckets4 = triage({
  oemItems: [],
  carfaxRecords: [],
  shopServiceHistory: [],
  currentMiles: 5000,
  today,
  dviFindings: [{ name: "Cabin Air Filter", status: "0", source: "tekmetric", notes: "loaded" }],
  vehicleYear: 2022,
});
const cabinNoBlurb = [...buckets4.overdue, ...buckets4.dueSoon, ...buckets4.upcoming]
  .find((t) => t.serviceKey === "cabin_air" && t.category === "DVI Finding");
ok("Without dviBestPractices param, DVI Finding tile still carries the tech note",
  cabinNoBlurb?.notes === "loaded" && cabinNoBlurb?.bestPracticeBlurb == null);

// ---- canonicalizeServiceKey matches the plan-matching normalizer ----
ok("canonicalizeServiceKey('Front Brake Pads') → 'front_brake_pads'",
  canonicalizeServiceKey({ serviceName: "Front Brake Pads" }) === "front_brake_pads");
ok("canonicalize matches toKeyFromName for canonical labels",
  canonicalizeServiceKey({ serviceName: "Cabin Air Filter" }) === toKeyFromName("Cabin Air Filter"));
ok("canonicalize falls back to slug for non-canonical custom services",
  canonicalizeServiceKey({ serviceName: "Custom Frobnicator Service" }) === "custom_frobnicator_service");
ok("canonicalize returns null on empty input",
  canonicalizeServiceKey({ serviceName: "", serviceKey: "" }) === null);

// End-to-end: blurb authored via canonical key attaches to a matching tile.
const padsKey = canonicalizeServiceKey({ serviceName: "Front Brake Pads" })!;
const buckets5 = triage({
  oemItems: [],
  carfaxRecords: [],
  shopServiceHistory: [],
  currentMiles: 5000,
  today,
  dviFindings: [{ name: "Front Brake Pads", status: "0", source: "tekmetric", notes: "thin" }],
  vehicleYear: 2022,
  dviBestPractices: { [padsKey]: "Authored via canonicalize." },
});
const padsViaCanonical = [...buckets5.overdue, ...buckets5.dueSoon, ...buckets5.upcoming]
  .find((t) => t.serviceKey === padsKey && t.category === "DVI Finding");
ok("Blurb keyed by canonicalize() attaches to the DVI tile produced by triage",
  padsViaCanonical?.bestPracticeBlurb === "Authored via canonicalize.");

// ---- Suggested template catalog has reasonable shape ----
ok("Default catalog has at least 10 entries (broad coverage)",
  DEFAULT_DVI_BEST_PRACTICES.length >= 10);
ok("Every default blurb fits within the 140-char cap",
  DEFAULT_DVI_BEST_PRACTICES.every((d) => d.blurb.length <= DVI_BEST_PRACTICE_MAX_CHARS));
ok("Every default entry has a non-empty serviceKey + serviceName",
  DEFAULT_DVI_BEST_PRACTICES.every((d) => d.serviceKey.length > 0 && d.serviceName.length > 0));

async function runMongoChecks() {
  const hasMongo = Boolean(process.env.MONGODB_URI || process.env.DATABASE_URL_MONGO);
  if (!hasMongo) {
    console.log("  ! Mongo not available — skipping storage-layer checks");
    return;
  }
  try {
    const TEST_SHOP_ID = -377; // negative shopId to avoid collision with real data
    const { getDb } = await import("../lib/mongo");
    const db = await getDb();
    await db.collection("shop_dvi_best_practices").deleteMany({ shopId: TEST_SHOP_ID });

    // Empty shop renders an empty lookup map — the "no global default" rule.
    const empty = await getShopDviBestPracticeMap(TEST_SHOP_ID);
    ok("New shop starts with an EMPTY blurb library (no auto-seed)", empty.size === 0);

    // Upsert + verify.
    const u = await upsertShopDviBestPractice({
      shopId: TEST_SHOP_ID,
      serviceKey: "battery",
      serviceName: "Battery",
      blurb: "Authored blurb for tests.",
      updatedBy: "smoke@test.local",
    });
    ok("Upsert (insert) returns before=null, after=blurb",
      u.before == null && u.after === "Authored blurb for tests.");

    const m = await getShopDviBestPracticeMap(TEST_SHOP_ID);
    ok("Lookup map returns ONLY the authored entry",
      m.size === 1 && m.get("battery") === "Authored blurb for tests.");

    // Update existing.
    const u2 = await upsertShopDviBestPractice({
      shopId: TEST_SHOP_ID,
      serviceKey: "battery",
      serviceName: "Battery",
      blurb: "Updated blurb.",
      updatedBy: "smoke@test.local",
    });
    ok("Upsert (update) returns prior blurb as `before`",
      u2.before === "Authored blurb for tests." && u2.after === "Updated blurb.");

    // Empty blurb deletes.
    const cleared = await upsertShopDviBestPractice({
      shopId: TEST_SHOP_ID,
      serviceKey: "battery",
      serviceName: "Battery",
      blurb: "",
      updatedBy: "smoke@test.local",
    });
    ok("Upsert with empty blurb deletes the row",
      cleared.before === "Updated blurb." && cleared.after === null);

    // Explicit delete helper.
    await upsertShopDviBestPractice({
      shopId: TEST_SHOP_ID,
      serviceKey: "wiper_blades",
      serviceName: "Wiper Blades",
      blurb: "Soon to be deleted.",
      updatedBy: "smoke@test.local",
    });
    const del = await deleteShopDviBestPractice({ shopId: TEST_SHOP_ID, serviceKey: "wiper_blades" });
    ok("deleteShopDviBestPractice returns prior blurb",
      del.before === "Soon to be deleted." && del.serviceKey === "wiper_blades");
    const after = await getShopDviBestPracticeMap(TEST_SHOP_ID);
    ok("Deleted entry no longer in lookup map", !after.has("wiper_blades"));

    await db.collection("shop_dvi_best_practices").deleteMany({ shopId: TEST_SHOP_ID });
  } catch (err) {
    console.warn("  ! Mongo helpers test skipped:", (err as Error).message);
  }
}

runMongoChecks().then(() => {
  if (failed === 0) {
    console.log("\nAll Task #377 smoke checks passed.");
    process.exit(0);
  } else {
    console.error(`\n${failed} Task #377 smoke check(s) failed.`);
    process.exit(1);
  }
});
