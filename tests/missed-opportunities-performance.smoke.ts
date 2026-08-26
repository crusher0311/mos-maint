import { getCachedPlans, PLAN_CACHE_SCHEMA_VERSION } from "../lib/plan-cache";
import {
  classifyMissedOpportunityLoad,
  runMissedOpportunityRefresh,
} from "../lib/missed-opportunities-refresh";

let failed = 0;
function check(name: string, condition: boolean) {
  if (condition) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name}`); }
}

async function main() {
console.log("Missed Opportunities load policy:");
{
  check("fresh cache serves immediately", classifyMissedOpportunityLoad({
    hasUsableCache: true, cacheIsFresh: true, forceRefresh: false,
  }) === "fresh_hit");
  check("stale cache serves before refresh", classifyMissedOpportunityLoad({
    hasUsableCache: true, cacheIsFresh: false, forceRefresh: false,
  }) === "stale_hit");
  check("first load computes", classifyMissedOpportunityLoad({
    hasUsableCache: false, cacheIsFresh: false, forceRefresh: false,
  }) === "compute");
  check("forced refresh computes despite cache", classifyMissedOpportunityLoad({
    hasUsableCache: true, cacheIsFresh: true, forceRefresh: true,
  }) === "compute");
}

console.log("Missed Opportunities single-flight:");
{
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const work = async () => {
    calls++;
    await gate;
    return { generatedAt: "ok" } as any;
  };
  const first = runMissedOpportunityRefresh(42, 30, work);
  const second = runMissedOpportunityRefresh(42, 30, work);
  await Promise.resolve();
  check("concurrent callers share one computation", first.promise === second.promise && calls === 1);
  check("second caller is marked joined", !first.joined && second.joined);
  release();
  await Promise.all([first.promise, second.promise]);

  let attempts = 0;
  await runMissedOpportunityRefresh(43, 30, async () => {
    attempts++;
    throw new Error("expected");
  }).promise.catch(() => {});
  await runMissedOpportunityRefresh(43, 30, async () => {
    attempts++;
    return {} as any;
  }).promise;
  check("failed refresh permits a later retry", attempts === 2);

  let syncAttempts = 0;
  const syncFailure = runMissedOpportunityRefresh(44, 30, () => {
    syncAttempts++;
    throw new Error("synchronous failure");
  });
  await syncFailure.promise.catch(() => {});
  await runMissedOpportunityRefresh(44, 30, async () => {
    syncAttempts++;
    return {} as any;
  }).promise;
  check("synchronous failure also permits a later retry", syncAttempts === 2);
}

console.log("Missed Opportunities batched plan loading:");
{
  let queries = 0;
  const now = new Date();
  const rows = Array.from({ length: 205 }, (_, index) => ({
    vin: `VIN${String(index).padStart(14, "0")}`,
    shopId: 7,
    mileage: 10_000 + index,
    plan: { buckets: { overdue: [], dueSoon: [], upcoming: [] }, distanceUnit: "miles" },
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    schemaVersion: PLAN_CACHE_SCHEMA_VERSION,
  }));
  rows[1].plan.distanceUnit = "kilometers";
  rows[2].schemaVersion = PLAN_CACHE_SCHEMA_VERSION - 1;
  rows[3].plan = { ...rows[3].plan, oemMissing: true } as any;
  rows[3].createdAt = new Date(now.getTime() - 60_000);
  rows[4].expiresAt = new Date(now.getTime() - 1);
  const fakeDb = {
    collection: () => ({
      find: (filter: any) => {
        queries++;
        const requested = new Set(filter.vin.$in);
        const selected = rows.filter((row) => requested.has(row.vin));
        return { sort: () => ({ toArray: async () => selected }) };
      },
    }),
  } as any;
  const selected = await getCachedPlans(
    fakeDb,
    7,
    rows.map((row) => ({ vin: row.vin, currentMiles: row.mileage, distanceUnit: "miles" })),
  );
  check("valid plans retain selector semantics", selected.get(rows[0].vin) != null);
  check("distance-unit mismatch remains invalid", selected.get(rows[1].vin) === null);
  check("old schema remains invalid", selected.get(rows[2].vin) === null);
  check("aged degraded plan remains invalid", selected.get(rows[3].vin) === null);
  check("expired plan remains invalid", selected.get(rows[4].vin) === null);
  check("205 VINs use three bounded queries, not 205", queries === 3);
}

if (failed) process.exit(1);
console.log("\nAll missed-opportunities performance tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});