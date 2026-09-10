import assert from "node:assert/strict";
import {
  __protractorPhysicalTransportTestHooks,
  acquireProtractorPhysicalTransportLease,
  activateProtractorOperatorStop,
  clearProtractorOperatorStop,
  confirmProtractorPhysicalTransportLease,
} from "../lib/data/repositories/api-usage";
import {
  __protractorCircuitBreakerTestHooks,
  acquireProtractorOutboundGate,
  PROTRACTOR_TRANSPORT_FAILURE_STATUS,
  recordProtractorResponse,
} from "../lib/data/repositories/protractor-circuit-breaker";

const calls: Array<{ method: string; filter: any; update?: any }> = [];
let operatorStop: any;
let ownerToken: string | undefined;

const collection = {
  updateOne: async (filter: any, update: any) => {
    calls.push({ method: "updateOne", filter, update });
    return { matchedCount: 1 };
  },
  findOneAndUpdate: async (filter: any, update: any) => {
    calls.push({ method: "findOneAndUpdate", filter, update });
    if ("operatorStop.active" in filter && filter["operatorStop.active"]?.$ne === true) {
      if (operatorStop?.active) return null;
      if (filter.ownerToken && filter.ownerToken !== ownerToken) return null;
      if (!filter.ownerToken) ownerToken = "lease-token";
      return { ownerToken, leaseExpiresAt: new Date(Date.now() + 60_000) };
    }
    if (update?.$set?.operatorStop?.active === true) {
      operatorStop = update.$set.operatorStop;
      return {
        operatorStop,
        ownerToken,
        physicalAdmissionOwnerToken: ownerToken,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      };
    }
    if (update?.$set?.operatorStop?.active === false) {
      if (
        !operatorStop?.active ||
        filter["operatorStop.stopId"] !== operatorStop.stopId
      ) return null;
      operatorStop = update.$set.operatorStop;
      return { operatorStop };
    }
    return null;
  },
  findOne: async (filter: any) =>
    filter["operatorStop.active"] === true && operatorStop?.active ? { _id: "lease" } : null,
};

__protractorPhysicalTransportTestHooks.getDb = async () => ({
  collection: () => collection,
} as any);
__protractorPhysicalTransportTestHooks.randomUUID = () =>
  ownerToken ? "stop-generation" : "lease-token";

async function main() {
  const lease = await acquireProtractorPhysicalTransportLease(Date.now() + 100);
  assert.equal(lease, "lease-token");
  const acquire = calls.find(call =>
    call.method === "findOneAndUpdate" && !call.filter.ownerToken &&
    call.filter["operatorStop.active"]?.$ne === true
  );
  assert.ok(acquire, "lease acquisition must atomically reject an active operator stop");

  const activated = await activateProtractorOperatorStop({
    changedBy: "test-operator",
    reason: "canary abort",
    now: new Date(1000),
  });
  assert.equal(activated.active, true);
  assert.equal(activated.stopId, "stop-generation");
  assert.equal(activated.physicalAdmissionInFlight, true);

  assert.equal(
    await confirmProtractorPhysicalTransportLease(lease!),
    false,
    "activation before final admission must prevent physical dispatch",
  );

  const breakerCollection = {
    updateOne: async () => ({ matchedCount: 1 }),
    findOneAndUpdate: async () => null,
    countDocuments: async () => 0,
  };
  __protractorCircuitBreakerTestHooks.getDb = async () => ({
    collection: () => breakerCollection,
  } as any);
  __protractorCircuitBreakerTestHooks.claimScope = async () => ({
    allowed: true,
    probe: true,
  });
  __protractorCircuitBreakerTestHooks.releaseClaimedProbe = async () => {};
  for (const status of [200, 401, 429, 503, PROTRACTOR_TRANSPORT_FAILURE_STATUS]) {
    await recordProtractorResponse("stale-in-flight", status);
    assert.equal(operatorStop.active, true, `stale ${status} feedback must not clear the stop`);
    assert.equal(operatorStop.stopId, "stop-generation");
  }
  await acquireProtractorOutboundGate("recovery-probe-race");
  assert.equal(operatorStop.active, true, "recovery-probe ownership changes must not clear the stop");
  assert.equal(operatorStop.stopId, "stop-generation");
  const confirm = calls.find(call => call.filter.ownerToken === "lease-token");
  assert.deepEqual(confirm?.filter["operatorStop.active"], { $ne: true });

  assert.equal(
    await acquireProtractorPhysicalTransportLease(Date.now() + 1),
    null,
    "activation must prevent all subsequent fleet lease claims",
  );

  await assert.rejects(
    clearProtractorOperatorStop({
      changedBy: "test-operator",
      reason: "stale clear",
      expectedStopId: "older-generation",
    }),
    /operator stop changed/,
  );
  const cleared = await clearProtractorOperatorStop({
    changedBy: "test-operator",
    reason: "incident owner approved",
    expectedStopId: "stop-generation",
  });
  assert.equal(cleared.active, false);

  console.log("All Protractor operator-stop repository checks passed");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});