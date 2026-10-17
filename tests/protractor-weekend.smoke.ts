import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { WEEKEND, callbackQuietEvidence, weekendAdmissionExpression, weekendFrom, weekendShopCancelled } from "../lib/protractor-weekend-policy";
import { historyEndpoint, matchesHistoryRequest, validateHistoryGrant, type ShopHistoryGrant } from "../lib/protractor-shop-history-policy";
import { historyBindingDigest, runWithShopHistory } from "../lib/integrations/protractor/shop-history-context";
import { createMongoExpressionCollection } from "./helpers/mongo-expression-collection";
import { __protractorPhysicalTransportTestHooks as hooks, confirmProtractorPhysicalTransportLease as confirm } from "../lib/data/repositories/api-usage";
import { plannedDays } from "../scripts/protractor-weekend/prepare";
const now = new Date("2026-10-17T15:00:00Z");
const grant: ShopHistoryGrant = {
  version: 4, shopId: 457, from: weekendFrom(457), until: WEEKEND.until,
  runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  canaryGeneration: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  bindingDigest: historyBindingDigest(457, "test-only"),
  notBefore: new Date(WEEKEND.start), expiresAt: new Date(WEEKEND.end),
  maxRequests: WEEKEND.maxRequests, consumedRequests: 9999, stopped: false,
};
const request = { runId: grant.runId, shopId: 457, day: "2026-10-16", pilot: "weekend" as const };
function fixture(patch: object = {}) {
  return createMongoExpressionCollection({
    _id: "protractor-physical-transport-v1", ownerToken: "lease", leaseExpiresAt: new Date(+now + 90000),
    operatorStop: { active: false }, ownerCanaryGeneration: grant.canaryGeneration,
    weekendHistory: { ...grant, activityCheckedAt: now, runnerLeaseUntil: new Date(+now + 120000), ...patch },
    avidHistory: { consumedRequests: 394, stopped: true },
    canary: { generation: grant.canaryGeneration, mode: "live", scope: "callbacks_and_interactive",
      requiresCallback: false, requiresRelay: true, workersSuspendedConfirmed: true,
      startedAt: new Date("2026-09-15T11:52:46Z"), maxAdmissions: null, remainingAdmissions: null,
      consumedAdmissions: 0, audit: [], auditTruncatedAdmissions: 0 },
  }, { now: () => now });
}
async function main() {
  assert.equal(weekendShopCancelled({ status: "active", billing: { status: "canceled" } }), true);
  assert.equal(weekendShopCancelled({ status: "locked", billing: { status: "past_due" } }), false);
  assert.equal(weekendShopCancelled({ status: "Cancelled" }), true);
  assert.equal(plannedDays(538, null, { status: "completed", until: "2026-10-09" }).at(-1), "2026-10-08");
  const avidDays = plannedDays(457, null, null);
  assert.equal(avidDays[0], "2026-10-16");
  assert.equal(avidDays.at(-1), "2024-10-17");
  assert.equal(plannedDays(538, null, null).at(-1), "2025-08-17");
  const partial = plannedDays(51, { completed: false, currentChunkEnd: "2025-01-24",
    lastRunAt: "2026-09-28" }, null);
  assert.ok(partial.includes("2026-10-16") && partial.includes("2025-01-24"));
  assert.ok(!partial.includes("2026-01-01"));
  validateHistoryGrant(grant);
  assert.equal(weekendFrom(538), "2025-08-17");
  const endpoint = historyEndpoint(request, 0);
  assert.ok(matchesHistoryRequest(request, endpoint, "GET", 457));
  assert.ok(!matchesHistoryRequest(request, endpoint, "POST", 457));
  assert.ok(!matchesHistoryRequest(request, endpoint, "GET", 538));
  for (const patch of [{ day: WEEKEND.until }, { day: "2024-10-16" }, { day: "2026-02-30" }])
    assert.throws(() => historyEndpoint({ ...request, ...patch }, 0));
  assert.throws(() => historyEndpoint(request, 100));
  for (const patch of [{ expiresAt: new Date("2026-10-20") }, { maxRequests: 10001 }, { consumedRequests: -1 }])
    assert.throws(() => validateHistoryGrant({ ...grant, ...patch }));
  assert.ok(!callbackQuietEvidence([], now));
  const known = [new Date("2026-10-16T15:00Z"), new Date("2026-10-16T15:01Z"), new Date("2026-10-15T15:00Z")];
  assert.ok(callbackQuietEvidence(known, now));
  assert.ok(!callbackQuietEvidence([...known, new Date(+now - 5000)], now));
  assert.ok(!callbackQuietEvidence(known.map(d => new Date(+d - 8 * 86400000)), now));
  assert.ok(!callbackQuietEvidence([known[0], known[0], known[0]], now));
  const context = { requireTimedTrial: true, historyRequest: request, historyBindingDigest: grant.bindingDigest,
    environment: "production" as const, transport: "relay" as const };
  const original = hooks.getDb;
  try {
    const col = fixture();
    hooks.getDb = async () => ({ collection: () => col } as any);
    assert.equal(await confirm("lease", context), true);
    assert.equal(await confirm("lease", context), false, "Budget may not reset");
    for (const patch of [
      { stopped: true }, { consumedRequests: 10000 },
      { runnerLeaseUntil: new Date(+now - 1) },
      { activityCheckedAt: new Date(+now - 16000) },
      { activityCheckedAt: new Date(+now + 1000) },
      { expiresAt: new Date(+now - 1) }, { bindingDigest: "0".repeat(64) }, { shopId: 538 },
    ]) {
      hooks.getDb = async () => ({ collection: () => fixture(patch) } as any);
      assert.equal(await confirm("lease", context), false, JSON.stringify(patch));
    }
    hooks.getDb = async () => ({ collection: () => fixture() } as any);
    assert.equal(await confirm("lease", { ...context, transport: "direct" }), false);
    assert.equal(await confirm("lease", { ...context, interactiveShopId: 457 }), false);
    assert.equal(await confirm("lease", { ...context, callbackReceivedAt: now }), false);
  } finally { hooks.getDb = original; }
  const oldClock = Date.now; Date.now = () => +now;
  try {
    await runWithShopHistory(grant, request, async () => {});
    await assert.rejects(runWithShopHistory(grant, { ...request, pilot: "avid" }, async () => {}));
    Date.now = () => Date.parse(WEEKEND.end);
    await assert.rejects(runWithShopHistory(grant, request, async () => {}));
  } finally { Date.now = oldClock; }
  assert.deepEqual(weekendAdmissionExpression({ ...request, day: WEEKEND.until }), { $literal: false });
  console.log("PASS: weekend grant, fleet budget, callback health, scope, lease and hard expiry");
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
