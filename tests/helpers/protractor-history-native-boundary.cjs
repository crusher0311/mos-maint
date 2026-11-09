// Keep this a native CJS -> import() boundary: transpiling it into require()
// would hide the production tsx dual-loader regression.
const assert = require("node:assert/strict");
exports.loadBoundary = async function(db) {
  const unwrap = m => m.default || m;
  const context = unwrap(await import("../../lib/integrations/protractor/fleet-history-context.ts"));
  const repo = unwrap(await import("../../lib/data/repositories/protractor-fleet-history.ts"));
  const onboarding = unwrap(await import("../../lib/integrations/protractor/onboarding.ts"));
  // Both loader copies use the same disposable real Mongo, not fake authority.
  repo.__fleetHistoryDeps.getDb = async () => db;
  let entered = 0;
  return {
    getContext: context.getFleetHistoryContext,
    async allowed(shopId) {
      assert.equal(context.getFleetHistoryContext()?.shopId, shopId);
      await context.assertFleetHistoryContext(shopId, "original-account");
      const before = entered;
      const result = await onboarding.runStagedInitialSync(db, shopId, async staged => {
        assert.equal(staged, true);
        entered++;
        // Stop at the real engine boundary without provider calls or optional
        // service-item counts. This is the engine's normal busy response.
        return { chunksProcessed: 0, totalJobsIndexed: 0, complete: false, error: "Already in progress" };
      });
      assert.equal(entered, before + 1);
      assert.equal(result.error, "Already in progress");
    },
    async denied(shopId) {
      const before = entered;
      const result = await onboarding.runStagedInitialSync(db, shopId, async () => {
        entered++;
        throw Error("Unauthorized engine entry");
      });
      assert.equal(entered, before);
      assert.equal(result.error, "Historical sync is queued until background Protractor access is approved.");
    },
  };
};
