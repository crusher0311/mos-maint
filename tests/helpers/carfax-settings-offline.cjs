// Keep legacy smoke tests isolated even though cache invalidation also attempts
// a best-effort Postgres delete when Mongo is canonical.
const Module = require("node:module");
const original = Module._load;
Module._load = function(name, ...args) {
  if (name === "@/lib/data/repositories/pg/plan-cache") return {
    pgDeleteCachedPlan: async () => 0,
    pgDeleteCachedPlansForShop: async () => 0,
    pgDeleteMaintenanceAnalysisForShop: async () => 0,
  };
  if (name === "@/lib/db/drizzle" || name === "./db/drizzle") return {
    getDb: () => { throw Error("Unexpected Postgres use in offline CARFAX test"); },
  };
  return original.call(this, name, ...args);
};
