/**
 * Smoke test for the "CARFAX id changed => rebuild plans" standard.
 *
 * Run: `npx tsx tests/carfax-cache-invalidate.smoke.ts`
 *
 * When a shop's CARFAX Location ID is entered for the first time (or changed),
 * every cached plan for that shop was built WITHOUT CARFAX service history and
 * is stale. `setShopCarfaxLocationId` (lib/integrations/carfax.ts) must drop the
 * shop's `cached_plans` + `maintenance_analysis_cache` so plans rebuild fresh on
 * next view — but ONLY on a real empty->set / changed transition, NOT when the
 * same id is re-saved. `invalidateShopPlanCache` (lib/plan-cache.ts) must match
 * shopId stored as BOTH String and Number (legacy rows mixed the two).
 *
 * A regression that skips the clear, clears on a no-op re-save, or only matches
 * one shopId type would ship green today. This test stubs MongoDB with an
 * in-memory fake `Db` so the real codepaths run end-to-end without a live Mongo.
 */

import { createRequire } from "module";

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
    if (v !== null && typeof v === "object" && "$exists" in (v as any)) {
      if ((v as any).$exists ? !(k in doc) : k in doc) return false;
    } else if (v !== null && typeof v === "object" && "$in" in (v as any)) {
      if (!((v as any).$in as any[]).some((cand) => cand === doc[k])) return false;
    } else if (doc[k] !== v) {
      return false;
    }
  }
  return true;
}

function makeFakeCollection(seed: Doc[] = []) {
  const docs: Doc[] = seed.map((d) => ({ ...d }));
  return {
    docs,
    findOne: async (q: any) => {
      const hit = docs.find((d) => matchesQuery(d, q));
      return hit ? { ...hit } : null;
    },
    updateOne: async (q: any, update: any, opts: any = {}) => {
      let target = docs.find((d) => matchesQuery(d, q));
      if (!target && opts.upsert) {
        const created: Doc = { ...q };
        target = created;
        docs.push(created);
        if (update.$setOnInsert) Object.assign(created, update.$setOnInsert);
      }
      if (!target) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(target, update.$set);
      if (update.$unset)
        for (const k of Object.keys(update.$unset)) delete target[k];
      return { matchedCount: 1, modifiedCount: 1 };
    },
    deleteMany: async (q: any) => {
      let deletedCount = 0;
      for (let i = docs.length - 1; i >= 0; i--) {
        if (matchesQuery(docs[i], q)) {
          docs.splice(i, 1);
          deletedCount += 1;
        }
      }
      return { deletedCount };
    },
    countDocuments: async (q: any) =>
      docs.filter((d) => matchesQuery(d, q)).length,
  };
}

function makeFakeDb(collections: Record<string, ReturnType<typeof makeFakeCollection>>) {
  return {
    collection: (name: string) => {
      if (!collections[name]) collections[name] = makeFakeCollection();
      return collections[name];
    },
  } as any;
}

async function run() {
  // Stub `server-only` (imported by lib/integrations/carfax) before importing
  // it, so the real module resolves in a plain Node/tsx test. Same trick as
  // tests/carfax-snapshot-preservation.smoke.ts.
  const req = createRequire(import.meta.url);
  const serverOnlyPath = req.resolve("server-only");
  req.cache[serverOnlyPath] = {
    id: serverOnlyPath,
    filename: serverOnlyPath,
    loaded: true,
    children: [],
    paths: [],
    exports: {},
  } as any;

  const { setShopCarfaxLocationId } = await import("../lib/integrations/carfax");
  const { invalidateShopPlanCache } = await import("../lib/plan-cache");

  const SHOP = 162;

  // --- Case 1: empty -> "LOC1" clears the cache ---
  {
    const cols = {
      shops: makeFakeCollection([{ shopId: SHOP, name: "Mac's" }]),
      cached_plans: makeFakeCollection([
        { vin: "AAA", shopId: SHOP },
        { vin: "BBB", shopId: String(SHOP) }, // legacy String shopId
      ]),
      maintenance_analysis_cache: makeFakeCollection([{ vin: "AAA", shopId: SHOP }]),
    };
    const db = makeFakeDb(cols);
    const res = await setShopCarfaxLocationId(db, SHOP, "LOC1");
    ok("empty->set returns cleared counts", !!res.cleared, JSON.stringify(res.cleared));
    ok("empty->set drops all cached_plans (String+Number)", cols.cached_plans.docs.length === 0);
    ok("empty->set drops analysis cache", cols.maintenance_analysis_cache.docs.length === 0);
    ok("empty->set writes carfax.locationId", cols.shops.docs[0].carfax?.locationId === "LOC1");
    ok("empty->set writes flat carfaxLocationId", cols.shops.docs[0].carfaxLocationId === "LOC1");
  }

  // --- Case 2: "LOC1" -> "LOC1" (same) does NOT clear ---
  {
    const cols = {
      shops: makeFakeCollection([{ shopId: SHOP, carfax: { locationId: "LOC1" }, carfaxLocationId: "LOC1" }]),
      cached_plans: makeFakeCollection([{ vin: "AAA", shopId: SHOP }]),
      maintenance_analysis_cache: makeFakeCollection(),
    };
    const db = makeFakeDb(cols);
    const res = await setShopCarfaxLocationId(db, SHOP, "LOC1");
    ok("same-value re-save returns cleared=null", res.cleared === null);
    ok("same-value re-save keeps cached_plans", cols.cached_plans.docs.length === 1);
  }

  // --- Case 3: "LOC1" -> "LOC2" (changed) clears ---
  {
    const cols = {
      shops: makeFakeCollection([{ shopId: SHOP, carfax: { locationId: "LOC1" }, carfaxLocationId: "LOC1" }]),
      cached_plans: makeFakeCollection([{ vin: "AAA", shopId: SHOP }]),
      maintenance_analysis_cache: makeFakeCollection(),
    };
    const db = makeFakeDb(cols);
    const res = await setShopCarfaxLocationId(db, SHOP, "LOC2");
    ok("changed value returns cleared counts", !!res.cleared);
    ok("changed value drops cached_plans", cols.cached_plans.docs.length === 0);
    ok("changed value writes new id", cols.shops.docs[0].carfaxLocationId === "LOC2");
  }

  // --- Case 4: set -> "" (clear) via helper does NOT clear plans (DELETE route handles removal) ---
  {
    const cols = {
      shops: makeFakeCollection([{ shopId: SHOP, carfax: { locationId: "LOC1" }, carfaxLocationId: "LOC1" }]),
      cached_plans: makeFakeCollection([{ vin: "AAA", shopId: SHOP }]),
      maintenance_analysis_cache: makeFakeCollection(),
    };
    const db = makeFakeDb(cols);
    const res = await setShopCarfaxLocationId(db, SHOP, "");
    ok("empty save returns cleared=null", res.cleared === null);
    ok("empty save leaves cached_plans (removal handled by DELETE route)", cols.cached_plans.docs.length === 1);
  }

  // --- Case 5: invalidateShopPlanCache matches BOTH String and Number shopId ---
  {
    const cols = {
      cached_plans: makeFakeCollection([
        { vin: "AAA", shopId: SHOP },
        { vin: "BBB", shopId: String(SHOP) },
        { vin: "CCC", shopId: 999 }, // other shop, must survive
      ]),
      maintenance_analysis_cache: makeFakeCollection([{ vin: "AAA", shopId: String(SHOP) }]),
    };
    const db = makeFakeDb(cols);
    const counts = await invalidateShopPlanCache(db, SHOP);
    ok("invalidate deletes both String+Number rows", counts.cachedPlans === 2, JSON.stringify(counts));
    ok("invalidate deletes analysis row", counts.analysisCache === 1);
    ok("invalidate leaves other shops untouched", cols.cached_plans.docs.length === 1 && cols.cached_plans.docs[0].shopId === 999);
  }

  if (failed > 0) {
    console.error(`\nFAILED: ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("\nAll CARFAX cache-invalidate assertions passed.");
  process.exit(0);
}

run().catch((err) => {
  console.error("carfax-cache-invalidate smoke crashed:", err);
  process.exit(1);
});
