/**
 * Smoke test for Task #737 — plan cache poisoning when the OEM/VIN-attribute
 * lookup (DataOne) is slow.
 *
 * Scenario being fixed: on a DataOne cache miss the plan build races the OEM
 * lookup against a small timeout. If the lookup loses, the plan is built with
 * NO vehicle attributes and NO OEM items — and previously that empty-OEM plan
 * was cached for 4 hours, so the vehicle kept showing undecided attributes
 * until TTL expiry or a manual refresh.
 *
 * The fix: such plans carry `plan.oemMissing = true`. `setCachedPlan` stores
 * them with a SHORT TTL (10 min instead of 4 h) and `getCachedPlan` skips
 * them outside the 30 s just-built freshness window, forcing the next load to
 * retry the OEM fetch and upgrade the cached plan in place.
 *
 * Uses the same in-memory fake `Db` as tests/plan-build-cache-write.smoke.ts
 * so the real plan-cache codepaths run end-to-end without a live Mongo.
 */
import {
  setCachedPlan,
  getCachedPlan,
  type CachedPlanData,
} from "../lib/plan-cache";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

// ----------------- in-memory Mongo fake -----------------
type Doc = Record<string, any>;

function matchesQuery(doc: Doc, query: any): boolean {
  for (const [k, v] of Object.entries(query)) {
    if (v !== null && typeof v === "object" && "$in" in (v as any)) {
      const arr = (v as any).$in as any[];
      if (!arr.some((cand) => cand === doc[k])) return false;
    } else if (doc[k] !== v) {
      return false;
    }
  }
  return true;
}

function makeFakeCollection() {
  const docs: Doc[] = [];
  return {
    docs,
    deleteMany: async (q: any) => {
      const before = docs.length;
      for (let i = docs.length - 1; i >= 0; i--) {
        if (matchesQuery(docs[i], q)) docs.splice(i, 1);
      }
      return { deletedCount: before - docs.length };
    },
    insertOne: async (doc: Doc) => {
      docs.push(doc);
      return { insertedId: docs.length };
    },
    updateOne: async (filter: any, update: any, options?: { upsert?: boolean }) => {
      const idx = docs.findIndex((d) => matchesQuery(d, filter));
      if (idx >= 0) {
        if (update.$set) Object.assign(docs[idx], update.$set);
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (options?.upsert) {
        const newDoc: Doc = { ...filter, ...(update.$set ?? {}) };
        docs.push(newDoc);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    },
    find: (q: any) => {
      const result = docs.filter((d) => matchesQuery(d, q));
      const cursor = {
        sort: (_: any) => {
          result.sort(
            (a, b) =>
              (b.createdAt?.getTime?.() ?? 0) - (a.createdAt?.getTime?.() ?? 0),
          );
          return cursor;
        },
        toArray: async () => result.slice(),
      };
      return cursor;
    },
  };
}

type FakeColl = ReturnType<typeof makeFakeCollection>;

function makeFakeDb() {
  const collections = new Map<string, FakeColl>();
  return {
    collection: (name: string) => {
      if (!collections.has(name)) collections.set(name, makeFakeCollection());
      return collections.get(name)!;
    },
    _coll: (name: string): FakeColl | undefined => collections.get(name),
  } as any;
}

function basePlan(overrides: Partial<CachedPlanData> = {}): CachedPlanData {
  return {
    buckets: { overdue: [], dueSoon: [], upcoming: [] },
    vehicle: { year: null, make: null, model: null, engine: null },
    currentMiles: 70000,
    mpdBlended: 35,
    customerName: "Test Customer",
    latestRoNumber: "1234",
    distanceUnit: "miles",
    soonMiles: 1000,
    soonDays: 30,
    showInspectItems: true,
    ...overrides,
  };
}

const VIN = "1C6RR6FG7KS516181";
const SHOP = 162; // Mac's Service Center (the reporting shop)
const MILES = 70000;

async function main() {
  console.log("Plan-cache oemMissing (task #737) smoke checks");

  // 1. oemMissing plan gets the SHORT TTL, complete plan keeps 4h
  {
    const db = makeFakeDb();
    await setCachedPlan(db, VIN, SHOP, MILES, basePlan({ oemMissing: true }));
    const doc = (db._coll("cached_plans") as FakeColl).docs[0];
    const ttlMs = doc.expiresAt.getTime() - doc.createdAt.getTime();
    ok("degraded (oemMissing) plan cached with 10m TTL", ttlMs === 10 * 60 * 1000, `ttl=${ttlMs}`);

    const db2 = makeFakeDb();
    await setCachedPlan(db2, VIN, SHOP, MILES, basePlan());
    const doc2 = (db2._coll("cached_plans") as FakeColl).docs[0];
    const ttl2 = doc2.expiresAt.getTime() - doc2.createdAt.getTime();
    ok("complete plan keeps the 4h TTL", ttl2 === 4 * 60 * 60 * 1000, `ttl=${ttl2}`);
  }

  // 2. Just-built oemMissing plan IS served (freshness window — preserves
  //    the partner await-build → read-cache flow)
  {
    const db = makeFakeDb();
    await setCachedPlan(db, VIN, SHOP, MILES, basePlan({ oemMissing: true }));
    const hit = await getCachedPlan(db, VIN, SHOP, MILES);
    ok("just-built oemMissing plan is served within the 30s freshness window", hit != null);
  }

  // 3. An oemMissing plan older than 30s is treated as a MISS so the next
  //    load retries the OEM fetch — the poisoning fix itself.
  {
    const db = makeFakeDb();
    await setCachedPlan(db, VIN, SHOP, MILES, basePlan({ oemMissing: true }));
    const doc = (db._coll("cached_plans") as FakeColl).docs[0];
    doc.createdAt = new Date(Date.now() - 60_000); // 1 minute old, well under TTL
    const miss = await getCachedPlan(db, VIN, SHOP, MILES);
    ok("oemMissing plan older than 30s is a MISS (forces OEM retry/rebuild)", miss === null);
  }

  // 4. The rebuild after DataOne recovers overwrites the degraded row with a
  //    complete plan that then serves normally (upgrade-in-place).
  {
    const db = makeFakeDb();
    await setCachedPlan(db, VIN, SHOP, MILES, basePlan({ oemMissing: true }));
    (db._coll("cached_plans") as FakeColl).docs[0].createdAt = new Date(Date.now() - 60_000);
    ok("degraded row is skipped pre-recovery", (await getCachedPlan(db, VIN, SHOP, MILES)) === null);

    // simulate the rebuild that got OEM data this time
    await setCachedPlan(db, VIN, SHOP, MILES, basePlan({
      vehicle: { year: 2019, make: "Ram", model: "1500", engine: "5.7L V8" },
    }));
    const coll = db._coll("cached_plans") as FakeColl;
    ok("rebuild leaves exactly one row (upgraded in place)", coll.docs.length === 1);
    // age it past the freshness window — a COMPLETE plan must still serve
    coll.docs[0].createdAt = new Date(Date.now() - 60_000);
    const hit = await getCachedPlan(db, VIN, SHOP, MILES);
    ok("upgraded plan serves as a normal cache HIT after recovery", hit != null);
    ok("upgraded plan carries the resolved vehicle attributes", hit?.plan?.vehicle?.make === "Ram");
  }

  // 5. Plans WITHOUT the flag (legacy rows / legit-empty OEM) are untouched.
  {
    const db = makeFakeDb();
    await setCachedPlan(db, VIN, SHOP, MILES, basePlan());
    (db._coll("cached_plans") as FakeColl).docs[0].createdAt = new Date(Date.now() - 60_000);
    const hit = await getCachedPlan(db, VIN, SHOP, MILES);
    ok("complete plan (no flag) still HITs outside the freshness window", hit != null);
  }

  if (failed > 0) {
    console.error(`\n${failed} plan-cache oemMissing smoke check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll plan-cache oemMissing smoke checks passed.");
}

main().catch((err) => {
  console.error("plan-cache-oem-missing smoke crashed:", err);
  process.exit(1);
});
