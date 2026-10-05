/**
 * Offline regression for the extension plan analyzer's local service mapper.
 * No route seam is exported: the route imports these same pure helpers.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeFakeDb } from "./utils/fake-mongo";
import {
  chooseExtensionLastPerformed,
  EXTENSION_TRANSMISSION_PATTERNS,
  hasUnresolvedCvtRecommendation,
  isPerformedExtensionHistoryPhrase,
  mapExtensionTransmissionServiceToKey,
} from "../lib/plan-build/extension-service-history";
import { splitServicePhrases } from "../lib/service-keys";

assert.equal(
  mapExtensionTransmissionServiceToKey("Replace CVT fluid"),
  "trans_auto",
);
assert.equal(
  mapExtensionTransmissionServiceToKey("Manual transmission fluid changed"),
  "trans_manual",
);
assert.equal(
  mapExtensionTransmissionServiceToKey("Dual-clutch transmission fluid"),
  "dct",
);
assert.equal(mapExtensionTransmissionServiceToKey("Replace engine oil"), null);
assert.equal(mapExtensionTransmissionServiceToKey("CVT mount replaced"), null);
assert.equal(mapExtensionTransmissionServiceToKey("CVT unit repaired"), null);

const transPatterns = EXTENSION_TRANSMISSION_PATTERNS.trans_auto;
const performed = (phrase: string) =>
  isPerformedExtensionHistoryPhrase(phrase, "trans_auto", transPatterns);

assert.equal(performed("Transmission fluid changed"), true);
assert.equal(performed("CVT fluid serviced"), true);
assert.equal(performed("Transmission fluid checked"), false);
assert.equal(performed("CVT fluid inspected"), false);
assert.equal(
  performed("Manual transmission fluid changed"),
  false,
  "manual-transmission work does not reset a CVT interval",
);
assert.equal(
  performed("Dual-clutch transmission fluid changed"),
  false,
  "DCT work does not reset a CVT interval",
);
assert.equal(
  isPerformedExtensionHistoryPhrase(
    "Oil change and transmission fluid service",
    "oil",
    [/oil change/i],
  ),
  true,
  "a combined title still credits its non-transmission service key",
);

const mixed =
  "Vehicle serviced; Transmission fluid changed; Transmission checked";
assert.equal(
  splitServicePhrases(mixed).some(performed),
  true,
  "a performed transmission phrase in a mixed CARFAX visit is credited",
);
const checkedOnly =
  "Vehicle serviced; Transmission fluid checked; CVT fluid inspected";
assert.equal(
  splitServicePhrases(checkedOnly).some(performed),
  false,
  "checked-only transmission history never resets the replacement clock",
);

const sameVisit = new Date("2026-04-01T00:00:00Z");
assert.deepEqual(
  chooseExtensionLastPerformed(
    { date: sameVisit, mileage: 46_615 },
    { date: sameVisit, mileage: 46_615 },
  ),
  { source: "shop", date: sameVisit, mileage: 46_615 },
  "same-visit shop history keeps precedence over duplicate CARFAX history",
);
assert.equal(
  chooseExtensionLastPerformed(
    { date: new Date("2026-03-01"), mileage: 45_000 },
    { date: sameVisit, mileage: 46_615 },
  ).source,
  "external",
  "the later performed record wins when visits differ",
);

assert.equal(
  hasUnresolvedCvtRecommendation([
    {
      service: "Replace CVT fluid",
      serviceKey: null,
      dueMileage: 24855,
      status: "overdue",
    },
  ]),
  true,
  "the narrow stale-cache detector catches the confirmed old row",
);
assert.equal(
  hasUnresolvedCvtRecommendation([
    { service: "Replace CVT fluid", serviceKey: "trans_auto" },
    { service: "Manual transmission fluid", serviceKey: "trans_manual" },
  ]),
  false,
  "resolved CVT/manual rows do not trigger cache invalidation",
);

// The extension's interval math after the now-recognized 46,615-mile anchor.
const lastMiles = 46_615;
const intervalMiles = 30_000;
const dueMileage = lastMiles + intervalMiles;
assert.equal(dueMileage, 76_615);
assert.equal(dueMileage - 60_000, 16_615, "before interval is upcoming");
assert.equal(dueMileage - 80_000, -3_385, "after interval is overdue");

const lastDate = new Date("2026-04-01T00:00:00Z");
const dueDate = new Date(lastDate);
dueDate.setUTCMonth(dueDate.getUTCMonth() + 24);
assert.equal(dueDate.toISOString().slice(0, 10), "2028-04-01");

async function verifyActualAnalyzer() {
  const serverOnlyPath = require.resolve("server-only");
  require.cache[serverOnlyPath] = {
    id: serverOnlyPath,
    filename: serverOnlyPath,
    loaded: true,
    children: [],
    paths: [],
    exports: {},
  } as any;

  const { __deps, runOnDemandAnalysis } =
    await import("../app/api/extension/plan/route");
  const runAt = async (
    currentMiles: number,
    intervalMiles = 24_855,
    intervalMonths: number | null = null,
  ) => {
    const fake = makeFakeDb({
      engine_risk_overrides: [],
      oem_carfax_mappings: [],
      maintenance_analysis_cache: [],
      tekmetric_work_orders: [],
      tekmetric_deferred_work: [],
    });
    const originalGetDb = __deps.getDb;
    __deps.getDb = (async () => fake.db) as any;
    try {
      const recs = await runOnDemandAnalysis(
        42,
        "TESTCVTVIN00000001",
        currentMiles,
        true,
        {},
        [{
          date: "2026-04-01",
          odometer: 46_615,
          description: "Transmission fluid changed",
        }],
        {
          oemResult: {
            ok: true,
            vin: "TESTCVTVIN00000001",
            squish: "TESTCVTVIN",
            count: 1,
            source: "cache",
            items: [{
              maintenance_id: "cvt",
              maintenance_category: "Transmission",
              maintenance_name: "Replace CVT fluid",
              maintenance_notes: null,
              intervals: [],
              miles: intervalMiles,
              months: intervalMonths,
            }],
            vehicle: null,
          } as any,
          shopWorkOrders: [],
        },
        [],
        "always",
        [],
        [],
      );
      return recs.find((row: any) => row.service === "Replace CVT fluid");
    } finally {
      __deps.getDb = originalGetDb;
    }
  };

  const before = await runAt(57_387);
  assert.ok(before, "actual analyzer emits the exact CVT OEM row");
  assert.equal(before.serviceKey, "trans_auto");
  assert.equal(before.last?.miles, 46_615);
  assert.equal(before.last?.date, "2026-04-01T00:00:00.000Z");
  assert.equal(before.last?.source, "external");
  assert.equal(before.interval, 24_855);
  assert.equal(before.dueMileage, 71_470);
  assert.equal(before.milesToGo, 14_083);
  assert.equal(before.status, "upcoming");

  const after = await runAt(72_000);
  assert.equal(after.dueMileage, 71_470);
  assert.equal(after.milesToGo, -530);
  assert.equal(after.status, "overdue");

  const monthOnly = await runAt(57_387, 0, 1);
  assert.equal(monthOnly.serviceKey, "trans_auto");
  assert.equal(monthOnly.last?.date, "2026-04-01T00:00:00.000Z");
  assert.equal(monthOnly.dueMileage, null);
  assert.equal(monthOnly.intervalMonths, 1);
  assert.equal(monthOnly.status, "overdue");
}

// Pin the route-level stale predicate wiring, not only the pure detector.
const routeSource = readFileSync(
  new URL("../app/api/extension/plan/route.ts", import.meta.url),
  "utf8",
);
assert.match(
  routeSource,
  /if \([^)]*hasUnresolvedCvt[^)]*\) \{/,
  "the route rebuild condition must include targeted unresolved-CVT staleness",
);

verifyActualAnalyzer()
  .then(() => {
    console.log("Extension CVT mapping, analyzer and stale-cache checks passed.");
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });