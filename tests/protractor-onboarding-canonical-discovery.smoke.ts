import "./helpers/deny-network-egress";
import assert from "node:assert/strict";

// Real canonical repository dispatch with a fake PG store and no Mongo
// mirror. An established shop is intentionally far outside the fastpath.
const Module = require("module");
const originalLoad = Module._load;
const shop = {
  shopId: 42,
  createdAt: new Date("2020-01-01"),
  integrationProvider: "protractor",
  protractorConnectionId: "offline-id",
  protractorApiKey: "offline-key",
  protractor: { configured: true, initialSyncState: "pending" },
};
let canonicalRow: any = null;
let canonicalReads = 0;
const db = {
  collection(name: string) {
    assert.equal(name, "shops", "PG-only progress must never read or write raw Mongo backfill_progress");
    return { find: () => ({ project: () => ({ toArray: async () => [shop] }) }) };
  },
};
Module._load = function(request: string, parent: any, ...rest: any[]) {
  if (request === "@/lib/mongo" || request === "@/lib/data/db") return { getDb: async () => db };
  if (request === "@/lib/db/integration-ops-write-mode") return {
    isProtractorOpsPgCanonical: () => true,
    shouldShadowWriteMongoProtractorOps: () => false,
    shadowWriteMongoIntegrationOps: async (shouldWrite: () => boolean) => {
      assert.equal(shouldWrite(), false, "Mongo shadow disabled");
    },
  };
  if (request === "./pg/protractor-backfill-progress" &&
      parent.filename.endsWith("/repositories/protractor-backfill-progress.ts")) return {
    upsertMerge: async (shopId: number, update: any) => {
      canonicalRow ??= { shopId, ...update.setOnInsert };
      Object.assign(canonicalRow, update.set || {});
    },
    findStaleBackfills: async (threshold: Date) => {
      canonicalReads++;
      return canonicalRow && canonicalRow.completed !== true &&
        canonicalRow.lastRunAt < threshold ? [canonicalRow] : [];
    },
  };
  if (request === "@/lib/integrations/backfill-pace") return {
    reopenCompletedShopsForHorizon: async () => {},
  };
  if (request === "@/lib/data/repositories/activity-profiles") return {
    prepareQuietWindowGate: async () => ({}),
    applyQuietWindowGate: () => ({ shouldSkip: false }),
  };
  return originalLoad.call(this, request, parent, ...rest);
};

async function run() {
  const repository = require("../lib/data/repositories/protractor-backfill-progress");
  const sync = require("../lib/integrations/protractor/sync");
  const queued: number[] = [];
  sync.__staleBackfillDeps.runBackfill = async (shopId: number) => {
    queued.push(shopId);
    return { chunksProcessed: 0, totalJobsIndexed: 0, complete: false };
  };
  await repository.upsertMerge(42, {
    setOnInsert: { startedAt: new Date(), completed: false, lastRunAt: new Date(0) },
  });
  const result = await sync.findAndResumeStaleBackfills();
  assert.deepEqual(result, { resumed: 1, shopIds: [42] });
  assert.deepEqual(queued, [42], "established shop discovered from canonical PG checkpoint without Mongo shadow");
  assert.equal(canonicalReads, 1);
  console.log("Protractor mature-shop PG-canonical onboarding discovery passed");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
// Keep fake stores and the network-denial guard installed until process exit.