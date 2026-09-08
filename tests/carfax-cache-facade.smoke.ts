import assert from "node:assert/strict";

type Doc = Record<string, any>;

function matches(doc: Doc, query: Doc): boolean {
  return Object.entries(query).every(([key, value]) => {
    if (value && typeof value === "object" && "$in" in value) {
      return value.$in.includes(doc[key]);
    }
    return doc[key] === value;
  });
}

function fakeCollection(docs: Doc[]) {
  return {
    findOne: async (query: Doc) => docs.find((doc) => matches(doc, query)) ?? null,
    find: (query: Doc) => ({
      sort: () => ({
        toArray: async () => docs.filter((doc) => matches(doc, query)),
      }),
    }),
    deleteMany: async (query: Doc) => {
      let deletedCount = 0;
      for (let i = docs.length - 1; i >= 0; i -= 1) {
        if (matches(docs[i], query)) {
          docs.splice(i, 1);
          deletedCount += 1;
        }
      }
      return { deletedCount };
    },
  };
}

async function main() {
  const vin = "1HGCM82633A004352";
  const plans: Doc[] = [{
    shopId: 7,
    vin,
    plan: { carfaxMaterialRevision: "old" },
    createdAt: new Date(),
  }];
  const analyses: Doc[] = [{ shopId: 7, vin, carfaxMaterialRevision: "old" }];
  const reports: Doc[] = [{ shopId: 7, vin, materialRevision: "new" }];
  const db = {
    collection(name: string) {
      return fakeCollection(
        name === "cached_plans"
          ? plans
          : name === "maintenance_analysis_cache"
            ? analyses
            : reports,
      );
    },
  } as any;

  const facade = await import("../lib/data/repositories/plan-cache-store");
  let pgPlanDeletes = 0;
  let pgAnalysisDeletes = 0;
  facade.__cacheInvalidationDeps.pgDeleteCachedPlan = async () => {
    pgPlanDeletes += 1;
    return 1;
  };
  facade.__cacheInvalidationDeps.pgDeleteMaintenanceAnalysis = async () => {
    pgAnalysisDeletes += 1;
    return 1;
  };

  assert.equal(
    await facade.findLatestCachedPlanDoc(7, vin, db),
    null,
    "raw timeout candidate rejects a stale CARFAX revision",
  );

  await facade.deleteCachedPlans(7, vin, db, { requireBothStores: true });
  await facade.deleteMaintenanceAnalysis(7, vin, db, { requireBothStores: true });
  assert.equal(plans.length, 0);
  assert.equal(analyses.length, 0);
  assert.equal(pgPlanDeletes, 1, "strict CARFAX cleanup reaches PG plan cache");
  assert.equal(pgAnalysisDeletes, 1, "strict CARFAX cleanup reaches PG analysis cache");

  plans.push({ shopId: 7, vin });
  facade.__cacheInvalidationDeps.pgDeleteCachedPlan = async () => {
    throw new Error("synthetic PG delete failure");
  };
  await assert.rejects(
    facade.deleteCachedPlans(7, vin, db, { requireBothStores: true }),
    /synthetic PG delete failure/,
  );
  assert.equal(plans.length, 0, "Mongo is still attempted when PG fails");

  plans.push({ shopId: 7, vin });
  facade.__cacheInvalidationDeps.pgDeleteCachedPlan = async () => {
    throw Object.assign(new Error('relation "cached_plans" does not exist'), {
      code: "42P01",
    });
  };
  await facade.deleteCachedPlans(7, vin, db, { requireBothStores: true });
  assert.equal(plans.length, 0, "unprovisioned optional PG mirror is graceful");

  console.log("carfax cache facade: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});